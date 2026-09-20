import type { z } from 'zod';

export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
}

export interface ToolDefinition<
  TId extends string,
  TInput,
  TOutput,
> {
  readonly id: TId;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<TOutput>;
}

export function defineTool<const TId extends string, TInput, TOutput>(
  definition: ToolDefinition<TId, TInput, TOutput>,
): ToolDefinition<TId, TInput, TOutput> {
  return definition;
}

export interface ToolInvocationMetadata {
  readonly toolId: string;
  readonly durationMs: number;
}

export interface ToolInvocationResult<TOutput> {
  readonly value: TOutput;
  readonly metadata: ToolInvocationMetadata;
}

export type ToolRuntimeEvent =
  | {
      readonly type: 'tool.started';
      readonly toolId: string;
    }
  | {
      readonly type: 'tool.completed';
      readonly toolId: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'tool.failed';
      readonly toolId: string;
      readonly durationMs: number;
      readonly error?: unknown;
    }
  | {
      readonly type: 'tool.cancelled';
      readonly toolId: string;
      readonly durationMs: number;
    };

export interface ToolInvocationOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ToolRuntimeEvent) => unknown | Promise<unknown>;
}

export interface ToolRuntimeOptions {
  readonly now?: () => number;
}
