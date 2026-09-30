import type { CapabilityGateway, CapabilityPrincipal } from '@harness/capability';
import { createResearchCommandContext, createResearchWorkflow, type ResearchNodeExecutors } from '@harness/command-research';
import { WorkflowRunner, type WorkflowEvent } from '@harness/command-core';
import type { EvidenceStore } from '@harness/evidence';
import {
  verifyFinancialObservation,
  type FinancialDataByKind,
  type FinancialDataResult,
  type FinancialObservationKind,
} from '@harness/financial-data';
import type { Evidence, ResearchReportPayload, ResearchSourceCoverage } from '@harness/schemas';
import { ResearchReportPayloadSchema } from '@harness/schemas';
import { buildEvidenceZone } from '@harness/shared';
import type { ResearcherAgent, ResearcherOutput } from '@harness/subagent-researcher';
import type { ToolRuntimeEvent } from '@harness/tool-runtime';
import { verifyAndPersistFinancialEvidence } from '../financialEvidence.js';
import { financialToolIds } from '../tools/financial.js';
import { RESEARCH_CAPABILITY_PRINCIPALS } from '../capabilities/financial.js';
import { groundResearcherOutput, type GroundedResearchSynthesis } from './grounding.js';
import { WorkflowTraceRecorder } from '../runtime/workflowTraceRecorder.js';
import type { WorkflowTraceStore } from '../runtime/workflowTraceRecorder.js';

export interface ResearchWorkflowRunIdentity {
  id: string;
  ticker: string;
}

export interface ResearchWorkflowRuntimeDependencies {
  capabilityGateway: Pick<CapabilityGateway, 'invoke'>;
  evidence: Pick<EvidenceStore, 'accept' | 'getManyByIdsForRun'>;
  researcher: Pick<ResearcherAgent, 'research'>;
  trace: WorkflowTraceStore;
}

export interface ResearchAcquisition {
  evidence: Evidence[];
  evidenceIds: string[];
  evidenceZone: string;
  coverage: ResearchSourceCoverage[];
}

export interface ResearchWorkflowRuntimeOptions {
  run: ResearchWorkflowRunIdentity;
  question: string;
  dependencies: ResearchWorkflowRuntimeDependencies;
  signal?: AbortSignal;
  onWorkflowEvent?: (event: WorkflowEvent) => void;
  onToolEvent?: (event: ToolRuntimeEvent) => void;
}

export interface ResearchWorkflowRuntimeResult {
  acquisition: ResearchAcquisition;
  grounded: GroundedResearchSynthesis;
  report: ResearchReportPayload;
}

type OptionalSource = 'news' | 'filings';

function value<T>(values: Readonly<Record<string, unknown>>, nodeId: string): T {
  return values[nodeId] as T;
}

function stableErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code)) return error.code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  if (error instanceof Error && error.name === 'NotFoundError') return 'NOT_FOUND';
  if (error instanceof Error && error.name === 'ToolExecutionError') return 'TOOL_EXECUTION_FAILED';
  return 'PROVIDER_ERROR';
}

function available(source: string, evidence: Evidence): ResearchSourceCoverage {
  return { source, status: 'available', evidenceIds: [evidence.id] };
}

function unavailable(source: string, reason: string): ResearchSourceCoverage {
  return { source, status: 'unavailable', reason };
}

async function persistRequired<K extends FinancialObservationKind>(params: {
  executionId: string;
  ticker: string;
  kind: K;
  result: FinancialDataResult<FinancialDataByKind[K]>;
  evidence: Pick<EvidenceStore, 'accept'>;
}): Promise<Evidence> {
  const { evidence, ...acquisition } = params;
  const acquired = await verifyAndPersistFinancialEvidence({ ...acquisition, evidenceStore: evidence });
  if (!acquired.accepted) throw new Error('Evidence policy rejected required source ' + params.kind);
  return acquired.evidence;
}

function assertRuntimeInput(options: ResearchWorkflowRuntimeOptions): void {
  if (!options.run.id.trim()) throw new Error('Research runtime requires a non-empty Execution ID');
  if (!options.run.ticker.trim()) throw new Error('Research runtime requires a non-empty ticker');
  if (!options.question.trim()) throw new Error('Research runtime requires a non-empty question');
}

/** Runs acquisition through one grounded ResearchReportPayload for an existing Execution. */
export async function runResearchWorkflowRuntime(
  options: ResearchWorkflowRuntimeOptions,
): Promise<ResearchWorkflowRuntimeResult> {
  assertRuntimeInput(options);
  const { run, dependencies } = options;
  const optionalFailureCodes: Partial<Record<OptionalSource, string>> = {};
  let companyResult: FinancialDataResult<FinancialDataByKind['company_report']> | undefined;
  let quarterlyResult: FinancialDataResult<FinancialDataByKind['quarterly_financials']> | undefined;
  let newsResult: FinancialDataResult<FinancialDataByKind['news']> | undefined;
  let filingsResult: FinancialDataResult<FinancialDataByKind['filings']> | undefined;
  let acquisitionResult: ResearchAcquisition | undefined;
  const definition = createResearchWorkflow();
  const recorder = new WorkflowTraceRecorder({ runId: run.id, definition, store: dependencies.trace });

  const invoke = async <T>(
    principal: CapabilityPrincipal,
    capabilityId: string,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    const result = await dependencies.capabilityGateway.invoke(principal, capabilityId, { ticker: run.ticker }, {
      signal,
      onEvent: options.onToolEvent,
    });
    return result.value as T;
  };

  const executors: ResearchNodeExecutors = {
    'identify-company': async (_inputs, signal) => {
      companyResult = await invoke<FinancialDataResult<FinancialDataByKind['company_report']>>(
        RESEARCH_CAPABILITY_PRINCIPALS.identifyCompany, financialToolIds.companyReport, signal,
      );
      return companyResult;
    },
    'fetch-financials': async (_inputs, signal) => {
      quarterlyResult = await invoke<FinancialDataResult<FinancialDataByKind['quarterly_financials']>>(
        RESEARCH_CAPABILITY_PRINCIPALS.fetchFinancials, financialToolIds.quarterlyFinancials, signal,
      );
      return quarterlyResult;
    },
    'fetch-news': async (_inputs, signal) => {
      try {
        newsResult = await invoke<FinancialDataResult<FinancialDataByKind['news']>>(
          RESEARCH_CAPABILITY_PRINCIPALS.fetchNews, financialToolIds.news, signal,
        );
        return newsResult;
      } catch (error) {
        if (signal?.aborted) throw error;
        optionalFailureCodes.news = stableErrorCode(error);
        throw error;
      }
    },
    'fetch-filings': async (_inputs, signal) => {
      try {
        filingsResult = await invoke<FinancialDataResult<FinancialDataByKind['filings']>>(
          RESEARCH_CAPABILITY_PRINCIPALS.fetchNews, financialToolIds.filings, signal,
        );
        return filingsResult;
      } catch (error) {
        if (signal?.aborted) throw error;
        optionalFailureCodes.filings = stableErrorCode(error);
        throw error;
      }
    },
    'collect-evidence': async () => {
      if (!companyResult || !quarterlyResult) throw new Error('Required Research acquisitions are missing');

      // Verify all acquired shapes before the first Evidence write.
      verifyFinancialObservation('company_report', companyResult, run.ticker);
      verifyFinancialObservation('quarterly_financials', quarterlyResult, run.ticker);

      let newsVerified = false;
      if (newsResult) {
        try {
          verifyFinancialObservation('news', newsResult, run.ticker);
          newsVerified = true;
        } catch (error) {
          optionalFailureCodes.news = stableErrorCode(error);
        }
      }
      let filingsVerified = false;
      if (filingsResult) {
        try {
          verifyFinancialObservation('filings', filingsResult, run.ticker);
          filingsVerified = true;
        } catch (error) {
          optionalFailureCodes.filings = stableErrorCode(error);
        }
      }

      const companyEvidence = await persistRequired({
        executionId: run.id, ticker: run.ticker, kind: 'company_report',
        result: companyResult, evidence: dependencies.evidence,
      });
      const quarterlyEvidence = await persistRequired({
        executionId: run.id, ticker: run.ticker, kind: 'quarterly_financials',
        result: quarterlyResult, evidence: dependencies.evidence,
      });
      const evidence = [companyEvidence, quarterlyEvidence];
      let newsEvidence: Evidence | undefined;
      if (newsResult && newsVerified) {
        const acquired = await verifyAndPersistFinancialEvidence({
          executionId: run.id, ticker: run.ticker, kind: 'news', result: newsResult, evidenceStore: dependencies.evidence,
        });
        if (acquired.accepted) newsEvidence = acquired.evidence;
        else optionalFailureCodes.news = 'EVIDENCE_POLICY_REJECTED';
      }
      let filingsEvidence: Evidence | undefined;
      if (filingsResult && filingsVerified) {
        const acquired = await verifyAndPersistFinancialEvidence({
          executionId: run.id, ticker: run.ticker, kind: 'filings', result: filingsResult, evidenceStore: dependencies.evidence,
        });
        if (acquired.accepted) filingsEvidence = acquired.evidence;
        else optionalFailureCodes.filings = 'EVIDENCE_POLICY_REJECTED';
      }
      if (newsEvidence) evidence.push(newsEvidence);
      if (filingsEvidence) evidence.push(filingsEvidence);

      const coverage: ResearchSourceCoverage[] = [
        available('company_report', companyEvidence),
        available('quarterly_financials', quarterlyEvidence),
        newsEvidence ? available('news', newsEvidence) : unavailable('news', optionalFailureCodes.news ?? 'PROVIDER_ERROR'),
        filingsEvidence ? available('filings', filingsEvidence) : unavailable('filings', optionalFailureCodes.filings ?? 'PROVIDER_ERROR'),
        { source: 'daily_transaction', status: 'not_requested' },
        { source: 'foreign_flow', status: 'not_requested' },
        { source: 'sentiment', status: 'not_requested' },
      ];
      const evidenceIds = evidence.map(item => item.id);
      acquisitionResult = {
        evidence,
        evidenceIds,
        evidenceZone: buildEvidenceZone(run.ticker, evidence),
        coverage,
      };
      return acquisitionResult;
    },
    'synthesize-research': async (inputs) => {
      const acquisition = value<ResearchAcquisition>(inputs, 'collect-evidence');
      const result = await dependencies.researcher.research({
        ticker: run.ticker,
        question: options.question,
        evidenceZone: acquisition.evidenceZone,
      });
      await recorder.recordSubagentResult('synthesize-research', result);
      return result;
    },
    'ground-research': async (inputs) => {
      if (!acquisitionResult) throw new Error('Research acquisition result is missing');
      const result = value<Awaited<ReturnType<ResearcherAgent['research']>>>(inputs, 'synthesize-research');
      return await groundResearcherOutput({
        executionId: run.id,
        output: result.value as ResearcherOutput,
        seenEvidenceIds: acquisitionResult.evidenceIds,
        evidenceStore: dependencies.evidence,
      });
    },
    'build-report': async (inputs) => {
      if (!acquisitionResult) throw new Error('Research acquisition result is missing');
      const grounded = value<GroundedResearchSynthesis>(inputs, 'ground-research');
      return ResearchReportPayloadSchema.parse({
        question: options.question,
        ...grounded,
        coverage: acquisitionResult.coverage,
      });
    },
  };
  const context = createResearchCommandContext({ executors });
  const runner = new WorkflowRunner({
    onEvent: async event => {
      options.onWorkflowEvent?.(event);
      await recorder.handle(event);
    },
  });
  const values = await runner.run(definition, context, { signal: options.signal });
  return {
    acquisition: value<ResearchAcquisition>(values, 'collect-evidence'),
    grounded: value<GroundedResearchSynthesis>(values, 'ground-research'),
    report: value<ResearchReportPayload>(values, 'build-report'),
  };
}
