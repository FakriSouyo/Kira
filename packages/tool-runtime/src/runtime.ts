import {
  ToolRuntimeError,
} from './errors.js';
import type {
  ToolDefinition,
  ToolInvocationOptions,
  ToolInvocationResult,
  ToolRuntimeEvent,
  ToolRuntimeOptions,
} from './contracts.js';

const DEFAULT_NOW = (): number => performance.now();

export class ToolRuntime {
  private readonly now: () => number;

  constructor(options: ToolRuntimeOptions = {}) {
    this.now = options.now ?? DEFAULT_NOW;
  }

  async invoke<TId extends string, TInput, TOutput>(
    tool: ToolDefinition<TId, TInput, TOutput>,
    input: unknown,
    options: ToolInvocationOptions = {},
  ): Promise<ToolInvocationResult<TOutput>> {
    this.validateDefinition(tool);

    const startedAt = this.now();
    await this.emit(options.onEvent, { type: 'tool.started', toolId: tool.id });

    let outcome:
      | {
          readonly result: ToolInvocationResult<TOutput>;
          readonly event: ToolRuntimeEvent;
        }
      | {
          readonly error: unknown;
          readonly event: ToolRuntimeEvent;
        };

    try {
      this.throwIfAborted(options.signal);

      const parsedInput = this.parseInput(tool, input);
      const output = await tool.execute(parsedInput, {
        signal: options.signal,
      });

      this.throwIfAborted(options.signal);
      const parsedOutput = this.parseOutput(tool, output);
      const durationMs = this.durationSince(startedAt);
      outcome = {
        result: {
          value: parsedOutput,
          metadata: { toolId: tool.id, durationMs },
        },
        event: {
          type: 'tool.completed',
          toolId: tool.id,
          durationMs,
        },
      };
    } catch (error) {
      const durationMs = this.durationSince(startedAt);
      if (this.isAbortedError(error, options.signal)) {
        outcome = {
          error,
          event: {
            type: 'tool.cancelled',
            toolId: tool.id,
            durationMs,
          },
        };
      } else {
        outcome = {
          error,
          event: {
            type: 'tool.failed',
            toolId: tool.id,
            durationMs,
            error,
          },
        };
      }
    }

    await this.emit(options.onEvent, outcome.event);
    if ('result' in outcome) {
      return outcome.result;
    }
    throw outcome.error;
  }

  private validateDefinition<TId extends string, TInput, TOutput>(
    tool: ToolDefinition<TId, TInput, TOutput>,
  ): void {
    if (
      tool === null ||
      typeof tool !== 'object' ||
      typeof tool.id !== 'string' ||
      tool.id.length === 0 ||
      typeof tool.inputSchema?.parse !== 'function' ||
      typeof tool.outputSchema?.parse !== 'function' ||
      typeof tool.execute !== 'function'
    ) {
      throw new ToolRuntimeError(
        'INVALID_TOOL_DEFINITION',
        'Tool definition is invalid',
      );
    }
  }

  private parseInput<TId extends string, TInput, TOutput>(
    tool: ToolDefinition<TId, TInput, TOutput>,
    input: unknown,
  ): TInput {
    try {
      return tool.inputSchema.parse(input);
    } catch (error) {
      throw new ToolRuntimeError(
        'TOOL_INPUT_INVALID',
        `Invalid input for tool ${tool.id}`,
        error,
      );
    }
  }

  private parseOutput<TId extends string, TInput, TOutput>(
    tool: ToolDefinition<TId, TInput, TOutput>,
    output: unknown,
  ): TOutput {
    try {
      return tool.outputSchema.parse(output);
    } catch (error) {
      throw new ToolRuntimeError(
        'TOOL_OUTPUT_INVALID',
        `Invalid output from tool ${tool.id}`,
        error,
      );
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new ToolRuntimeError('TOOL_ABORTED', 'Tool invocation aborted');
    }
  }

  private isAbortedError(error: unknown, signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true || (
      error instanceof ToolRuntimeError && error.code === 'TOOL_ABORTED'
    );
  }

  private durationSince(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  private async emit(
    observer: ToolInvocationOptions['onEvent'],
    event: ToolRuntimeEvent,
  ): Promise<void> {
    try {
      await observer?.(event);
    } catch {
      // Observation must not become execution authority.
    }
  }
}

export type { ToolRuntimeErrorCode } from './errors.js';
