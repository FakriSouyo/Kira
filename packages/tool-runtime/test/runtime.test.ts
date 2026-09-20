import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, ToolRuntime, type ToolRuntimeEvent } from '../src';

function echoTool(execute: (input: { value: string }, context: { signal?: AbortSignal }) => Promise<unknown>) {
  return defineTool({
    id: 'test.echo',
    inputSchema: z.object({ value: z.string().min(1) }),
    outputSchema: z.object({ value: z.string() }),
    execute,
  });
}

describe('ToolRuntime', () => {
  it('validates, executes once, validates output, and reports deterministic metadata', async () => {
    const calls: Array<{ value: string }> = [];
    const events: ToolRuntimeEvent[] = [];
    const tool = echoTool(async (input) => {
      calls.push(input);
      return { value: input.value.toUpperCase() };
    });
    const clock = [100, 137][Symbol.iterator]();
    const result = await new ToolRuntime({ now: () => clock.next().value as number }).invoke(tool, { value: 'hello' }, { onEvent: event => events.push(event) });

    expect(calls).toEqual([{ value: 'hello' }]);
    expect(result).toEqual({ value: { value: 'HELLO' }, metadata: { toolId: 'test.echo', durationMs: 37 } });
    expect(events).toEqual([
      { type: 'tool.started', toolId: 'test.echo' },
      { type: 'tool.completed', toolId: 'test.echo', durationMs: 37 },
    ]);
  });

  it('rejects invalid input before handler execution', async () => {
    let calls = 0;
    const events: ToolRuntimeEvent[] = [];
    const tool = echoTool(async () => {
      calls += 1;
      return { value: 'never' };
    });

    await expect(new ToolRuntime({ now: () => 0 }).invoke(tool, { value: 7 }, { onEvent: event => events.push(event) }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(calls).toBe(0);
    expect(events.map(event => event.type)).toEqual(['tool.started', 'tool.failed']);
  });

  it('rejects invalid output after one handler execution', async () => {
    let calls = 0;
    const tool = echoTool(async () => {
      calls += 1;
      return { value: 42 };
    });

    await expect(new ToolRuntime({ now: () => 0 }).invoke(tool, { value: 'input' }))
      .rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' });
    expect(calls).toBe(1);
  });

  it('preserves the exact domain error identity', async () => {
    const failure = Object.assign(new Error('provider unavailable'), { code: 'RATE_LIMIT' });
    const tool = echoTool(async () => { throw failure; });

    await expect(new ToolRuntime({ now: () => 0 }).invoke(tool, { value: 'input' })).rejects.toBe(failure);
  });

  it('cancels before dispatch without invoking the handler', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const events: ToolRuntimeEvent[] = [];
    const tool = echoTool(async () => {
      calls += 1;
      return { value: 'never' };
    });

    await expect(new ToolRuntime({ now: () => 0 }).invoke(tool, { value: 'input' }, {
      signal: controller.signal,
      onEvent: event => events.push(event),
    })).rejects.toMatchObject({ code: 'TOOL_ABORTED' });
    expect(calls).toBe(0);
    expect(events.map(event => event.type)).toEqual(['tool.started', 'tool.cancelled']);
  });

  it('fences cancellation after handler resolution before publishing success', async () => {
    const controller = new AbortController();
    let calls = 0;
    const events: ToolRuntimeEvent[] = [];
    const tool = echoTool(async (_input, context) => {
      calls += 1;
      expect(context.signal).toBe(controller.signal);
      controller.abort();
      return { value: 'discarded' };
    });

    await expect(new ToolRuntime({ now: () => 0 }).invoke(tool, { value: 'input' }, {
      signal: controller.signal,
      onEvent: event => events.push(event),
    })).rejects.toMatchObject({ code: 'TOOL_ABORTED' });
    expect(calls).toBe(1);
    expect(events.map(event => event.type)).toEqual(['tool.started', 'tool.cancelled']);
  });

  it('never emits duplicate terminal events for a failed invocation', async () => {
    const events: ToolRuntimeEvent[] = [];
    const tool = echoTool(async () => { throw new Error('failed'); });

    await expect(new ToolRuntime({ now: () => 0 }).invoke(tool, { value: 'input' }, { onEvent: event => events.push(event) })).rejects.toThrow('failed');
    expect(events.filter(event => event.type !== 'tool.started')).toHaveLength(1);
    expect(events[1]?.type).toBe('tool.failed');
  });
});
