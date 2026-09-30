import type { WorkflowDefinition, WorkflowNode } from '@harness/command-core';

export const COMPARE_NODE_IDS = [
  'identify-subjects',
  'fetch-financials',
  'collect-evidence',
  'normalize-comparison',
  'build-report',
] as const;
export type CompareNodeId = typeof COMPARE_NODE_IDS[number];

export const COMPARE_SERVICES = [
  'financial-data',
  'comparison-evidence',
  'comparison-normalization',
  'comparison-report',
] as const;

export type CompareExecutor = NonNullable<WorkflowNode<unknown>['executor']>;
export type CompareNodeExec = (
  inputs: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>;
export type CompareNodeExecutors = Readonly<Record<CompareNodeId, CompareNodeExec>>;

export interface CompareCommandContext {
  execute(
    nodeId: CompareNodeId,
    executor: CompareExecutor,
    inputs: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

function node(
  id: CompareNodeId,
  label: string,
  executor: CompareExecutor,
  dependsOn: CompareNodeId[] = [],
): WorkflowNode<CompareCommandContext> {
  return {
    id,
    label,
    executor,
    dependsOn,
    run: async (context, inputs, signal) => await context.execute(id, executor, inputs, signal),
  };
}

const service = (id: typeof COMPARE_SERVICES[number]): CompareExecutor => ({ kind: 'service', id });

/** Static, required Comparison DAG; providers, Evidence, and persistence stay outside the command package. */
export function createCompareWorkflow(): WorkflowDefinition<CompareCommandContext> {
  return {
    id: 'compare',
    nodes: [
      node('identify-subjects', 'Identify comparison subjects', service('financial-data')),
      node('fetch-financials', 'Fetch quarterly financials', service('financial-data'), ['identify-subjects']),
      node('collect-evidence', 'Collect and persist Evidence', service('comparison-evidence'), ['fetch-financials']),
      node('normalize-comparison', 'Normalize comparison', service('comparison-normalization'), ['collect-evidence']),
      node('build-report', 'Build comparison report', service('comparison-report'), ['normalize-comparison']),
    ],
  };
}

/** Binds every command node to a supplied engine executor without widening this package's dependencies. */
export function createCompareCommandContext(params: { executors: CompareNodeExecutors }): CompareCommandContext {
  return {
    execute: async (nodeId, _executor, inputs, signal) => await params.executors[nodeId](inputs, signal),
  };
}
