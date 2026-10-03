import type { EvidenceStore } from '@harness/evidence';
import { matchesGroundedNumber, numericAssertions, numericValueAtPath } from '@harness/execution';
import type { ResearcherOutput } from '@harness/subagent-researcher';
import { ResearcherOutputSchema } from '@harness/subagent-researcher';
import { hasTransactionDirective, UserFriendlyError, ValidationError } from '@harness/shared';
import { ResearchReportPayloadSchema, type Evidence, type ResearchReportPayload } from '@harness/schemas';

export type GroundedResearchSynthesis = Pick<
  ResearchReportPayload,
  'summary' | 'findings' | 'sourceAssessments' | 'gaps'
>;

const GroundedResearchSynthesisSchema = ResearchReportPayloadSchema.pick({
  summary: true,
  findings: true,
  sourceAssessments: true,
  gaps: true,
});

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function observationKind(evidence: Evidence): 'company_report' | 'quarterly_financials' {
  const provenance = record(evidence.provenance);
  const acceptedProvenance = record(evidence.acceptance?.provenance);
  const kinds = [
    ...(provenance && Object.hasOwn(provenance, 'observationKind') ? [provenance.observationKind] : []),
    ...(acceptedProvenance && Object.hasOwn(acceptedProvenance, 'observationKind') ? [acceptedProvenance.observationKind] : []),
  ];
  if (kinds.length === 0 || kinds.some(kind => kind !== 'company_report' && kind !== 'quarterly_financials')) {
    throw new ValidationError('Evidence has no supported financial observation kind');
  }
  if (new Set(kinds).size !== 1) throw new ValidationError('Evidence observation kinds conflict across provenance');
  return kinds[0] as 'company_report' | 'quarterly_financials';
}

function metadataValue(evidence: Evidence, key: string): unknown[] {
  return [evidence.provenance, evidence.acceptance?.provenance]
    .map(provenance => record(record(provenance)?.metadata))
    .map(metadata => metadata && Object.hasOwn(metadata, key) ? metadata[key] : undefined);
}

function requiredTemporalLabel(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`Evidence path ${path} has no valid temporal label`);
  }
  return value;
}

function companyReportAnchor(evidence: Evidence, path: string): string {
  const candidates = [
    ...metadataValue(evidence, 'dataAsOf'),
    Object.hasOwn(evidence.data, 'asOf') ? evidence.data.asOf : undefined,
  ].filter(value => value !== undefined && value !== null);
  if (candidates.length === 0) throw new ValidationError(`Evidence path ${path} has no Company Report temporal anchor`);
  const labels = candidates.map(value => requiredTemporalLabel(value, path));
  if (new Set(labels).size !== 1) throw new ValidationError(`Evidence path ${path} has conflicting Company Report temporal anchors`);
  return labels[0]!;
}

function quarterlyAnchor(evidence: Evidence, path: string): string {
  const quarter = /^quarters(?:\[(\d+)\]|\.(\d+))\./.exec(path);
  if (quarter) {
    const row = record(numericValueAtPath(evidence.data, `quarters.${quarter[1] ?? quarter[2]}`));
    return requiredTemporalLabel(row?.period, path);
  }
  if (path.startsWith('cumulativeYtd.')) {
    const cumulativeYtd = record(numericValueAtPath(evidence.data, 'cumulativeYtd'));
    return requiredTemporalLabel(cumulativeYtd?.periodLabel, path);
  }
  throw new ValidationError(`Evidence path ${path} has no supported Quarterly Financials temporal anchor`);
}

function evidenceTemporalAnchor(evidence: Evidence, path: string): string {
  switch (observationKind(evidence)) {
    case 'company_report': return companyReportAnchor(evidence, path);
    case 'quarterly_financials': return quarterlyAnchor(evidence, path);
  }
}

/** Validates one Researcher response against the Evidence supplied to this Execution. */
export async function groundResearcherOutput(params: {
  executionId: string;
  output: ResearcherOutput;
  seenEvidenceIds: readonly string[];
  evidenceStore: Pick<EvidenceStore, 'getManyByIdsForRun'>;
}): Promise<GroundedResearchSynthesis> {
  if (!params.executionId.trim()) throw new ValidationError('Research grounding requires an Execution identity');

  const output = ResearcherOutputSchema.parse(params.output);
  const prose = [
    output.summary,
    ...output.findings.map(finding => finding.claim),
    ...output.sourceAssessments.map(assessment => assessment.rationale),
    ...output.gaps,
  ];
  if (prose.some(hasTransactionDirective)) {
    throw new ValidationError('Research output contains a transaction directive; transaction decisions belong to the human.');
  }
  const seenEvidenceIds = new Set(params.seenEvidenceIds);
  const findingEvidenceIds = new Set<string>();

  for (const finding of output.findings) {
    const findingIds = new Set(finding.evidenceIds);
    if (findingIds.size !== finding.evidenceIds.length) {
      throw new ValidationError('Research finding has duplicate Evidence IDs');
    }
    for (const id of findingIds) {
      if (!seenEvidenceIds.has(id)) throw new ValidationError(`Research finding Evidence ${id} was not supplied to Researcher`);
      findingEvidenceIds.add(id);
    }
    for (const figure of finding.citedFigures ?? []) {
      if (!seenEvidenceIds.has(figure.evidenceId)) {
        throw new ValidationError(`CitedFigure Evidence ${figure.evidenceId} was not supplied to Researcher`);
      }
      if (!findingIds.has(figure.evidenceId)) {
        throw new ValidationError(`CitedFigure Evidence ${figure.evidenceId} is not linked to its Research finding`);
      }
    }
  }

  const assessmentEvidenceIds = new Set<string>();
  for (const assessment of output.sourceAssessments) {
    if (assessmentEvidenceIds.has(assessment.evidenceId)) {
      throw new ValidationError(`Research source assessment has duplicate Evidence ${assessment.evidenceId}`);
    }
    if (!seenEvidenceIds.has(assessment.evidenceId)) {
      throw new ValidationError(`Research source assessment Evidence ${assessment.evidenceId} was not supplied to Researcher`);
    }
    assessmentEvidenceIds.add(assessment.evidenceId);
  }
  for (const id of findingEvidenceIds) {
    if (!assessmentEvidenceIds.has(id)) {
      throw new ValidationError(`Research finding Evidence ${id} has no source assessment`);
    }
  }

  const referencedIds = [...new Set([...findingEvidenceIds, ...assessmentEvidenceIds])];
  let evidence: Evidence[];
  try {
    evidence = await params.evidenceStore.getManyByIdsForRun(params.executionId, referencedIds);
  } catch (cause) {
    throw new UserFriendlyError(
      'VALIDATION_UNAVAILABLE',
      `Research Evidence scope could not be read: ${String(cause)}`,
      'Retry when Evidence storage is available.',
    );
  }

  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  for (const id of referencedIds) {
    if (!evidenceById.has(id)) {
      throw new ValidationError(`Evidence ${id} is outside Execution ${params.executionId} membership`);
    }
  }

  const findings = output.findings.map(finding => {
    const groundedFigures = (finding.citedFigures ?? []).map(figure => {
      const citedEvidence = evidenceById.get(figure.evidenceId)!;
      const actual = numericValueAtPath(citedEvidence.data, figure.path);
      if (actual === undefined) {
        throw new ValidationError(`Research finding Evidence path ${figure.path} is missing`);
      }
      if (typeof actual !== 'number' || !matchesGroundedNumber(actual, figure.value)) {
        throw new ValidationError(`Research finding CitedFigure value mismatch at ${figure.path}`);
      }
      const periodLabel = evidenceTemporalAnchor(citedEvidence, figure.path);
      if (figure.periodLabel !== periodLabel) {
        throw new ValidationError(`Research finding CitedFigure period label mismatch at ${figure.path}`);
      }
      return { cited: figure.value, actual, figure: { ...figure, periodLabel } };
    });
    for (const assertion of numericAssertions(finding.claim)) {
      if (!groundedFigures.some(figure =>
        matchesGroundedNumber(assertion, figure.cited) && matchesGroundedNumber(assertion, figure.actual))) {
        throw new ValidationError('Research numeric statement has no matching grounded CitedFigure');
      }
    }

    return {
      statement: finding.claim,
      evidenceIds: finding.evidenceIds,
      confidence: finding.confidence,
      ...(finding.citedFigures ? { citedFigures: groundedFigures.map(grounded => grounded.figure) } : {}),
    };
  });

  return GroundedResearchSynthesisSchema.parse({
    summary: output.summary,
    findings,
    sourceAssessments: output.sourceAssessments,
    gaps: output.gaps,
  });
}
