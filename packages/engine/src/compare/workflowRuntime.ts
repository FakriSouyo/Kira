import type { CapabilityGateway, CapabilityPrincipal } from '@harness/capability';
import { createCompareCommandContext, createCompareWorkflow, type CompareNodeExecutors } from '@harness/command-compare';
import { WorkflowRunner, type WorkflowEvent } from '@harness/command-core';
import type { EvidenceStore } from '@harness/evidence';
import {
  verifyFinancialObservation,
  type CompanyReport,
  type FinancialDataByKind,
  type FinancialDataResult,
  type QuarterlyFinancials,
} from '@harness/financial-data';
import type { ComparisonMatrix, ComparisonReportPayload, Evidence } from '@harness/schemas';
import type { ToolRuntimeEvent } from '@harness/tool-runtime';
import { verifyAndPersistFinancialEvidence } from '../financialEvidence.js';
import { COMPARE_CAPABILITY_PRINCIPALS } from '../capabilities/financial.js';
import { financialToolIds } from '../tools/financial.js';
import { normalizeComparisonEvidence, type ComparisonEvidenceSource } from './normalization.js';
import { buildComparisonReportPayload } from './report.js';
import { WorkflowTraceRecorder, type WorkflowTraceStore } from '../runtime/workflowTraceRecorder.js';

export interface ComparisonWorkflowRunIdentity {
  id: string;
  ticker: string;
}

export interface ComparisonWorkflowRuntimeDependencies {
  capabilityGateway: Pick<CapabilityGateway, 'invoke'>;
  evidence: Pick<EvidenceStore, 'accept' | 'getManyByIdsForRun'>;
  trace: WorkflowTraceStore;
}

export interface ComparisonWorkflowRuntimeOptions {
  run: ComparisonWorkflowRunIdentity;
  subjects: readonly string[];
  dependencies: ComparisonWorkflowRuntimeDependencies;
  signal?: AbortSignal;
  onWorkflowEvent?: (event: WorkflowEvent) => void;
  onToolEvent?: (event: ToolRuntimeEvent) => void;
}

export interface ComparisonAcquisition {
  evidence: Evidence[];
  sources: ComparisonEvidenceSource[];
}

export interface ComparisonWorkflowRuntimeResult {
  acquisition: ComparisonAcquisition;
  matrix: ComparisonMatrix;
  report: ComparisonReportPayload;
}

const IDX_TICKER_PATTERN = /^[A-Z]{2,6}$/;

function assertRuntimeInput(options: ComparisonWorkflowRuntimeOptions): string[] {
  if (typeof options.run.id !== 'string' || options.run.id.trim().length === 0) {
    throw new Error('Comparison runtime requires a non-empty Execution ID');
  }
  if (!Array.isArray(options.subjects) || options.subjects.length < 2 || options.subjects.length > 3) {
    throw new Error('Comparison runtime requires two or three IDX subjects');
  }
  const subjects = options.subjects.map(subject => typeof subject === 'string' ? subject.trim().toUpperCase() : '');
  if (subjects.some(ticker => !IDX_TICKER_PATTERN.test(ticker))) {
    throw new Error('Comparison subjects must be valid IDX tickers');
  }
  if (new Set(subjects).size !== subjects.length) {
    throw new Error('Comparison subjects must be unique');
  }
  if (options.run.ticker !== subjects[0]) {
    throw new Error('Comparison Execution ticker must equal the first normalized subject');
  }
  return subjects;
}

function value<T>(values: Readonly<Record<string, unknown>>, nodeId: string): T {
  return values[nodeId] as T;
}

async function persistRequiredFinancialEvidence<K extends 'company_report' | 'quarterly_financials'>(params: {
  executionId: string;
  ticker: string;
  kind: K;
  result: FinancialDataResult<FinancialDataByKind[K]>;
  evidence: Pick<EvidenceStore, 'accept'>;
}): Promise<Evidence> {
  const { evidence, ...acquisition } = params;
  const accepted = await verifyAndPersistFinancialEvidence({ ...acquisition, evidenceStore: evidence });
  if (!accepted.accepted) {
    throw new Error(`Evidence policy rejected required Comparison source ${params.kind}`, {
      cause: { policyId: accepted.policyId, reason: accepted.reason },
    });
  }
  return accepted.evidence;
}

/** Executes deterministic Comparison acquisition and normalization for an already selected Execution identity. */
export async function runComparisonWorkflowRuntime(
  options: ComparisonWorkflowRuntimeOptions,
): Promise<ComparisonWorkflowRuntimeResult> {
  const subjects = assertRuntimeInput(options);
  const { run, dependencies } = options;
  const definition = createCompareWorkflow();
  const recorder = new WorkflowTraceRecorder({ runId: run.id, definition, store: dependencies.trace });

  let companyResults: Array<FinancialDataResult<CompanyReport>> | undefined;
  let quarterlyResults: Array<FinancialDataResult<QuarterlyFinancials>> | undefined;
  const invoke = async <T>(
    principal: CapabilityPrincipal,
    capabilityId: string,
    ticker: string,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    const result = await dependencies.capabilityGateway.invoke(principal, capabilityId, { ticker }, {
      signal,
      onEvent: options.onToolEvent,
    });
    return result.value as T;
  };

  const executors: CompareNodeExecutors = {
    'identify-subjects': async (_inputs, signal) => {
      const results: Array<FinancialDataResult<CompanyReport>> = [];
      for (const ticker of subjects) {
        signal?.throwIfAborted();
        results.push(await invoke<FinancialDataResult<CompanyReport>>(
          COMPARE_CAPABILITY_PRINCIPALS.identifySubjects,
          financialToolIds.companyReport,
          ticker,
          signal,
        ));
      }
      companyResults = results;
      return subjects;
    },
    'fetch-financials': async (_inputs, signal) => {
      const results: Array<FinancialDataResult<QuarterlyFinancials>> = [];
      for (const ticker of subjects) {
        signal?.throwIfAborted();
        results.push(await invoke<FinancialDataResult<QuarterlyFinancials>>(
          COMPARE_CAPABILITY_PRINCIPALS.fetchFinancials,
          financialToolIds.quarterlyFinancials,
          ticker,
          signal,
        ));
      }
      quarterlyResults = results;
      return results;
    },
    'collect-evidence': async (_inputs, signal) => {
      if (!companyResults || !quarterlyResults) throw new Error('Required Comparison acquisitions are missing');

      // Verify every provider response before the first Evidence write.
      for (const [index, ticker] of subjects.entries()) {
        verifyFinancialObservation('company_report', companyResults[index]!, ticker);
        verifyFinancialObservation('quarterly_financials', quarterlyResults[index]!, ticker);
      }

      const evidence: Evidence[] = [];
      const sources: ComparisonEvidenceSource[] = [];
      for (const [index, ticker] of subjects.entries()) {
        signal?.throwIfAborted();
        const companyEvidence = await persistRequiredFinancialEvidence({
          executionId: run.id,
          ticker,
          kind: 'company_report',
          result: companyResults[index]!,
          evidence: dependencies.evidence,
        });
        signal?.throwIfAborted();
        const quarterlyEvidence = await persistRequiredFinancialEvidence({
          executionId: run.id,
          ticker,
          kind: 'quarterly_financials',
          result: quarterlyResults[index]!,
          evidence: dependencies.evidence,
        });
        evidence.push(companyEvidence, quarterlyEvidence);
        sources.push({
          ticker,
          companyReportEvidenceId: companyEvidence.id,
          quarterlyFinancialsEvidenceId: quarterlyEvidence.id,
        });
      }
      return { evidence, sources } satisfies ComparisonAcquisition;
    },
    'normalize-comparison': async (inputs, signal) => {
      const acquisition = value<ComparisonAcquisition>(inputs, 'collect-evidence');
      return await normalizeComparisonEvidence({
        executionId: run.id,
        subjects,
        sources: acquisition.sources,
        evidenceStore: dependencies.evidence,
        signal,
      });
    },
    'build-report': async (inputs) => buildComparisonReportPayload(value<ComparisonMatrix>(inputs, 'normalize-comparison')),
  };

  const context = createCompareCommandContext({ executors });
  const runner = new WorkflowRunner({
    onEvent: async event => {
      options.onWorkflowEvent?.(event);
      await recorder.handle(event);
    },
  });
  const values = await runner.run(definition, context, { signal: options.signal });
  return {
    acquisition: value<ComparisonAcquisition>(values, 'collect-evidence'),
    matrix: value<ComparisonMatrix>(values, 'normalize-comparison'),
    report: value<ComparisonReportPayload>(values, 'build-report'),
  };
}
