import type { WorkflowDefinition, WorkflowNode } from '@harness/command-core';
import { RESEARCHER_MANIFEST } from '@harness/subagent-researcher';

export const RESEARCH_NODE_IDS = [
  'identify-company',
  'fetch-financials',
  'fetch-news',
  'fetch-filings',
  'collect-evidence',
  'synthesize-research',
  'ground-research',
  'build-report',
] as const;
export type ResearchNodeId = typeof RESEARCH_NODE_IDS[number];

export const RESEARCH_SERVICES = [
  'financial-data',
  'research-evidence',
  'research-grounding',
  'research-report',
] as const;
export const RESEARCH_SUBAGENTS = [RESEARCHER_MANIFEST.id] as const;
export type ResearchExecutor = NonNullable<WorkflowNode<unknown>['executor']>;

export type ResearchNodeExec = (
  inputs: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>;
export type ResearchNodeExecutors = Readonly<Record<ResearchNodeId, ResearchNodeExec>>;

export interface ResearchCommandContext {
  execute(
    nodeId: ResearchNodeId,
    executor: ResearchExecutor,
    inputs: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

function node(
  id: ResearchNodeId,
  label: string,
  executor: ResearchExecutor,
  dependsOn: ResearchNodeId[] = [],
  options: Pick<WorkflowNode<ResearchCommandContext>, 'required'> = {},
): WorkflowNode<ResearchCommandContext> {
  return {
    id, label, executor, dependsOn, ...options,
    run: async (context, inputs, signal) => await context.execute(id, executor, inputs, signal),
  };
}

const service = (id: typeof RESEARCH_SERVICES[number]): ResearchExecutor => ({ kind: 'service', id });
const researcher: ResearchExecutor = { kind: 'subagent', id: RESEARCHER_MANIFEST.id };

/** Static Research acquisition and product graph; runtime ownership stays in Engine. */
export function createResearchWorkflow(): WorkflowDefinition<ResearchCommandContext> {
  return {
    id: 'research',
    nodes: [
      node('identify-company', 'Identify company', service('financial-data')),
      node('fetch-financials', 'Fetch quarterly financials', service('financial-data'), ['identify-company']),
      node('fetch-news', 'Fetch news', service('financial-data'), ['fetch-financials'], { required: false }),
      node('fetch-filings', 'Fetch filings', service('financial-data'), ['fetch-news'], { required: false }),
      node('collect-evidence', 'Collect and persist evidence', service('research-evidence'), ['fetch-filings']),
      node('synthesize-research', 'Synthesize research', researcher, ['collect-evidence']),
      node('ground-research', 'Ground research output', service('research-grounding'), ['synthesize-research']),
      node('build-report', 'Build research report', service('research-report'), ['ground-research']),
    ],
  };
}

export function createResearchCommandContext(params: {
  executors: ResearchNodeExecutors;
}): ResearchCommandContext {
  return {
    execute: async (nodeId, _executor, inputs, signal) => await params.executors[nodeId](inputs, signal),
  };
}
