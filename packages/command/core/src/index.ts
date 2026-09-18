export interface WorkflowNode<TContext> {
  id: string;
  label: string;
  /** Auditable owner shown by trace renderers; it does not grant runtime capabilities. */
  executor?: { kind: 'subagent' | 'service'; id: string };
  dependsOn?: string[];
  required?: boolean;
  /** Allows execution profiles to omit a node without disguising it as completed work. */
  enabled?: (context: TContext) => boolean;
  run(context: TContext, inputs: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
}

export interface WorkflowDefinition<TContext> {
  id: string;
  nodes: WorkflowNode<TContext>[];
}

interface StepEventBase {
  workflowId: string;
  nodeId: string;
  label: string;
}

export type WorkflowEvent =
  | (StepEventBase & { type: 'workflow.step.started' })
  | (StepEventBase & { type: 'workflow.step.skipped'; reason: 'disabled' })
  | (StepEventBase & { type: 'workflow.step.completed'; durationMs: number })
  | (StepEventBase & { type: 'workflow.step.cancelled'; durationMs: number })
  | (StepEventBase & { type: 'workflow.step.failed'; durationMs: number; required: boolean; error: string });

export interface WorkflowRunnerOptions {
  onEvent?: (event: WorkflowEvent) => unknown | Promise<unknown>;
  now?: () => number;
}

export interface WorkflowRunOptions {
  signal?: AbortSignal;
}

/** Required workflow-node failure with a stable code for application error mapping. */
export class WorkflowStepError extends Error {
  readonly code = 'WORKFLOW_STEP_FAILED';

  constructor(
    readonly workflowId: string,
    readonly nodeId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowStepError';
  }
}

type NodeSettlement =
  | { node: WorkflowNode<unknown>; status: 'completed'; value: unknown }
  | { node: WorkflowNode<unknown>; status: 'skipped' }
  | { node: WorkflowNode<unknown>; status: 'cancelled'; error: unknown }
  | { node: WorkflowNode<unknown>; status: 'failed'; error: unknown };

/** Runs a command's dependency graph while keeping financial policy in command packages. */
export class WorkflowRunner {
  private readonly onEvent: (event: WorkflowEvent) => unknown | Promise<unknown>;
  private readonly now: () => number;

  constructor(options: WorkflowRunnerOptions = {}) {
    this.onEvent = options.onEvent ?? (() => {});
    this.now = options.now ?? (() => performance.now());
  }

  async run<TContext>(
    definition: WorkflowDefinition<TContext>,
    context: TContext,
    options: WorkflowRunOptions = {},
  ): Promise<Record<string, unknown>> {
    const remaining = [...definition.nodes];
    const knownIds = new Set(remaining.map((node) => node.id));
    const finished = new Set<string>();
    const values: Record<string, unknown> = {};
    for (const node of remaining) {
      for (const dependency of node.dependsOn ?? []) {
        if (!knownIds.has(dependency)) throw new Error(`Workflow node ${node.id} depends on unknown node ${dependency}`);
      }
    }

    while (remaining.length > 0) {
      options.signal?.throwIfAborted();
      const ready = remaining.filter((node) => (node.dependsOn ?? []).every((id) => finished.has(id)));
      if (ready.length === 0) throw new Error(`Workflow ${definition.id} contains a dependency cycle`);
      for (const node of ready) remaining.splice(remaining.indexOf(node), 1);

      const settlements = await Promise.all(ready.map(async (node): Promise<NodeSettlement> => {
        options.signal?.throwIfAborted();
        if (node.enabled?.(context) === false) {
          await this.onEvent({
            type: 'workflow.step.skipped',
            workflowId: definition.id,
            nodeId: node.id,
            label: node.label,
            reason: 'disabled',
          });
          return { node: node as WorkflowNode<unknown>, status: 'skipped' };
        }
        const started = this.now();
        await this.onEvent({ type: 'workflow.step.started', workflowId: definition.id, nodeId: node.id, label: node.label });
        const inputs = Object.fromEntries((node.dependsOn ?? []).map((id) => [id, values[id]]));
        try {
          const value = await node.run(context, inputs, options.signal);
          await this.onEvent({ type: 'workflow.step.completed', workflowId: definition.id, nodeId: node.id, label: node.label, durationMs: this.now() - started });
          return { node: node as WorkflowNode<unknown>, status: 'completed', value };
        } catch (error) {
          if (options.signal?.aborted) {
            await this.onEvent({
              type: 'workflow.step.cancelled',
              workflowId: definition.id,
              nodeId: node.id,
              label: node.label,
              durationMs: this.now() - started,
            });
            return {
              node: node as WorkflowNode<unknown>,
              status: 'cancelled',
              error: options.signal.reason ?? error,
            };
          }
          await this.onEvent({
            type: 'workflow.step.failed',
            workflowId: definition.id,
            nodeId: node.id,
            label: node.label,
            durationMs: this.now() - started,
            required: node.required !== false,
            error: error instanceof Error ? error.message : String(error),
          });
          return { node: node as WorkflowNode<unknown>, status: 'failed', error };
        }
      }));

      let requiredFailure: Extract<NodeSettlement, { status: 'failed' }> | undefined;
      let cancellation: Extract<NodeSettlement, { status: 'cancelled' }> | undefined;
      for (const settlement of settlements) {
        finished.add(settlement.node.id);
        if (settlement.status === 'completed') values[settlement.node.id] = settlement.value;
        else if (settlement.status === 'skipped') values[settlement.node.id] = undefined;
        else if (settlement.status === 'cancelled') cancellation ??= settlement;
        else if (settlement.node.required === false) values[settlement.node.id] = undefined;
        else requiredFailure ??= settlement;
      }
      if (cancellation) throw cancellation.error;
      if (requiredFailure) {
        throw new WorkflowStepError(
          definition.id,
          requiredFailure.node.id,
          `Required workflow step failed: ${requiredFailure.node.label}`,
          { cause: requiredFailure.error },
        );
      }
    }
    return values;
  }
}
