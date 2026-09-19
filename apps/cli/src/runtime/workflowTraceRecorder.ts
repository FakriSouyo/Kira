import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '@harness/command-core';
import { calculateModelCost, type ModelPricing, type WorkflowStepStatus } from '@harness/session-core';
import type { SubagentResult } from '@harness/subagent-core';

/**
 * Trace only reads identity and dependency metadata. It is deliberately not
 * parameterised by the workflow context type so any command definition can be
 * recorded without variance casts.
 */
export interface TraceableWorkflowDefinition {
  id: string;
  nodes: ReadonlyArray<{
    id: string;
    label: string;
    dependsOn?: string[];
    executor?: { kind: 'subagent' | 'service'; id: string };
  }>;
}

interface TraceStore {
  saveStep(params: {
    stepId?: string; runId: string; nodeId: string; parentNodeIds: string[]; subagent?: string;
    skills: Array<{ name: string; contentHash: string }>; status: WorkflowStepStatus;
    durationMs?: number; summary?: string; error?: string;
  }): Promise<unknown>;
  recordModelCall(params: {
    callId?: string; runId: string; stepId: string; subagent: string; provider: string; model: string; attempt: number;
    inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; totalTokens: number | null;
    latencyMs: number; finishReason: string | null; cost: number | null; currency: string | null;
    contextSnapshotId?: string | null;
  }): Promise<unknown>;
}

export interface WorkflowTraceRecorderOptions {
  runId: string;
  definition: TraceableWorkflowDefinition;
  store: TraceStore;
  pricingFor?: (provider: string, model: string) => ModelPricing | null;
}

interface StepDetails {
  subagent?: string;
  skills: Array<{ name: string; contentHash: string }>;
  summary?: string;
}

/** Bridges awaited workflow events and subagent results into the durable session trace. */
export class WorkflowTraceRecorder {
  private readonly details = new Map<string, StepDetails>();
  private readonly nodes: Map<string, TraceableWorkflowDefinition['nodes'][number]>;

  constructor(private readonly options: WorkflowTraceRecorderOptions) {
    this.nodes = new Map(options.definition.nodes.map((node) => [node.id, node]));
  }

  async handle(event: WorkflowEvent): Promise<void> {
    const node = this.nodes.get(event.nodeId);
    if (!node) throw new Error(`Trace event references unknown node ${event.nodeId}`);
    const details = this.details.get(event.nodeId) ?? {
      subagent: node.executor?.kind === 'subagent' ? node.executor.id : undefined,
      skills: [],
    };
    const common = {
      stepId: this.stepId(event.nodeId), runId: this.options.runId, nodeId: event.nodeId,
      parentNodeIds: node.dependsOn ?? [], ...(details.subagent ? { subagent: details.subagent } : {}),
      skills: details.skills, ...(details.summary ? { summary: details.summary } : {}),
    };
    // Restored outputs are already durable; do not rewrite timing/status as if
    // the node executed in this process.
    if (event.type === 'workflow.step.restored') return;
    if (event.type === 'workflow.step.started') await this.options.store.saveStep({ ...common, status: 'running' });
    else if (event.type === 'workflow.step.skipped') await this.options.store.saveStep({ ...common, status: 'skipped', summary: event.reason });
    else if (event.type === 'workflow.step.completed') await this.options.store.saveStep({ ...common, status: 'completed', durationMs: event.durationMs });
    else if (event.type === 'workflow.step.cancelled') await this.options.store.saveStep({ ...common, status: 'cancelled', durationMs: event.durationMs });
    else await this.options.store.saveStep({ ...common, status: 'failed', durationMs: event.durationMs, error: event.error });
  }

  async recordSubagentResult(nodeId: string, result: SubagentResult<unknown>): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Subagent result references unknown node ${nodeId}`);
    const summary = typeof result.value === 'object' && result.value !== null && 'summary' in result.value
      && typeof result.value.summary === 'string' ? result.value.summary : undefined;
    const details: StepDetails = { subagent: result.subagent, skills: result.skills, ...(summary ? { summary } : {}) };
    this.details.set(nodeId, details);
    await this.options.store.saveStep({
      stepId: this.stepId(nodeId), runId: this.options.runId, nodeId, parentNodeIds: node.dependsOn ?? [],
      subagent: result.subagent, skills: result.skills, status: 'running', ...(summary ? { summary } : {}),
    });
    if (!result.modelCall && result.contextSnapshotId === undefined) return;
    const modelCall = result.modelCall ?? {
      provider: 'mock' as const, model: 'unknown', inputTokens: null, outputTokens: null,
      cachedInputTokens: null, totalTokens: null, latencyMs: 0, finishReason: null,
    };
    const pricing = this.options.pricingFor?.(modelCall.provider, modelCall.model) ?? null;
    const billed = calculateModelCost(modelCall, pricing);
    await this.options.store.recordModelCall({
      callId: `call_${randomUUID()}`, runId: this.options.runId, stepId: this.stepId(nodeId), subagent: result.subagent,
      provider: modelCall.provider, model: modelCall.model, attempt: 1,
      inputTokens: modelCall.inputTokens, outputTokens: modelCall.outputTokens,
      cachedInputTokens: modelCall.cachedInputTokens, totalTokens: modelCall.totalTokens,
      latencyMs: modelCall.latencyMs, finishReason: modelCall.finishReason,
      cost: billed.cost, currency: billed.currency,
      contextSnapshotId: result.contextSnapshotId ?? null,
    });
  }

  private stepId(nodeId: string): string {
    return `step_${this.options.runId}_${nodeId}`;
  }
}
