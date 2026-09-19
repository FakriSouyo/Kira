import { createHash } from 'node:crypto';
import { canonicalJson } from '@harness/shared';

export const EXECUTION_PROFILE_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_NODE_OUTPUT_SCHEMA_VERSION = 1 as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function assertJsonValue(value: unknown, path = 'payload'): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} must contain only finite JSON numbers`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} must be JSON-serializable data only`);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface ExecutionProfile<TPayload extends JsonValue = JsonValue> {
  schemaVersion: typeof EXECUTION_PROFILE_SCHEMA_VERSION;
  executionId: string;
  workflowId: string;
  workflowVersion: number;
  graphFingerprint: string;
  command: string;
  ticker: string;
  payload: TPayload;
  fingerprint: string;
  createdAt: string;
}

export type ExecutionProfileInput<TPayload extends JsonValue> = Omit<ExecutionProfile<TPayload>, 'schemaVersion' | 'fingerprint'>;

export function executionProfileSemanticJson(profile: Pick<ExecutionProfile, 'executionId' | 'workflowId' | 'workflowVersion' | 'graphFingerprint' | 'command' | 'ticker' | 'payload'>): string {
  return canonicalJson({
    executionId: profile.executionId,
    workflowId: profile.workflowId,
    workflowVersion: profile.workflowVersion,
    graphFingerprint: profile.graphFingerprint,
    command: profile.command,
    ticker: profile.ticker,
    payload: profile.payload,
  });
}

export function createExecutionProfile<TPayload extends JsonValue>(params: ExecutionProfileInput<TPayload>): ExecutionProfile<TPayload> {
  assertJsonValue(params.payload);
  const semantic = executionProfileSemanticJson(params);
  return {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    ...params,
    fingerprint: fingerprint(semantic),
  };
}

export class ExecutionProfileConflictError extends Error {
  readonly code = 'EXECUTION_PROFILE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'ExecutionProfileConflictError';
  }
}

export type WorkflowNodeOutputStatus = 'completed' | 'skipped';

export interface WorkflowNodeOutput<TPayload extends JsonValue = JsonValue> {
  outputId: string;
  schemaVersion: typeof WORKFLOW_NODE_OUTPUT_SCHEMA_VERSION;
  executionId: string;
  workflowId: string;
  workflowVersion: number;
  nodeId: string;
  status: WorkflowNodeOutputStatus;
  outputKind: string;
  dependencyFingerprint: string;
  outputFingerprint: string;
  payload: TPayload | null;
  completionGeneration: number;
  createdAt: string;
}

export type WorkflowNodeOutputInput<TPayload extends JsonValue> = Omit<WorkflowNodeOutput<TPayload>, 'schemaVersion' | 'outputId' | 'outputFingerprint'> & {
  outputId?: string;
};

export function workflowNodeOutputSemanticJson(output: Pick<WorkflowNodeOutput, 'executionId' | 'workflowId' | 'workflowVersion' | 'nodeId' | 'status' | 'outputKind' | 'dependencyFingerprint' | 'payload'>): string {
  return canonicalJson({
    executionId: output.executionId,
    workflowId: output.workflowId,
    workflowVersion: output.workflowVersion,
    nodeId: output.nodeId,
    status: output.status,
    outputKind: output.outputKind,
    dependencyFingerprint: output.dependencyFingerprint,
    payload: output.payload,
  });
}

export function createWorkflowNodeOutput<TPayload extends JsonValue>(params: WorkflowNodeOutputInput<TPayload>): WorkflowNodeOutput<TPayload> {
  if (params.payload !== null) assertJsonValue(params.payload);
  const outputFingerprint = fingerprint(workflowNodeOutputSemanticJson(params));
  return {
    outputId: params.outputId ?? `output_${outputFingerprint.slice(0, 24)}`,
    schemaVersion: WORKFLOW_NODE_OUTPUT_SCHEMA_VERSION,
    ...params,
    outputFingerprint,
  };
}

export class WorkflowNodeOutputConflictError extends Error {
  readonly code = 'WORKFLOW_OUTPUT_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowNodeOutputConflictError';
  }
}

export interface ExecutionProfileStore {
  save<TPayload extends JsonValue>(profile: ExecutionProfile<TPayload>): Promise<ExecutionProfile<TPayload>>;
  getByExecutionId<TPayload extends JsonValue = JsonValue>(executionId: string): Promise<ExecutionProfile<TPayload> | null>;
}

export interface WorkflowNodeOutputStore {
  save<TPayload extends JsonValue>(output: WorkflowNodeOutput<TPayload>): Promise<WorkflowNodeOutput<TPayload>>;
  getNodeOutput<TPayload extends JsonValue = JsonValue>(executionId: string, nodeId: string): Promise<WorkflowNodeOutput<TPayload> | null>;
  listNodeOutputsForExecution<TPayload extends JsonValue = JsonValue>(executionId: string): Promise<WorkflowNodeOutput<TPayload>[]>;
}
