import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type {
  ToolDefinition,
  ToolInvocationOptions,
  ToolInvocationResult,
} from '@harness/tool-runtime';
import {
  CapabilityAccessError,
  CapabilityGateway,
  CapabilityPolicy,
  CapabilityRegistry,
  CapabilityRegistryError,
  type CapabilityRegistration,
} from '../src/index.js';
import { defineTool, ToolRuntime, ToolRuntimeError } from '@harness/tool-runtime';

const principal = { id: 'analyst' } as const;

class CountingToolRuntime extends ToolRuntime {
  invocationCount = 0;

  override invoke<TId extends string, TInput, TOutput>(
    tool: ToolDefinition<TId, TInput, TOutput>,
    input: unknown,
    options?: ToolInvocationOptions,
  ): Promise<ToolInvocationResult<TOutput>> {
    this.invocationCount += 1;
    return super.invoke(tool, input, options);
  }
}

function createEchoRegistration(onExecute?: (input: { value: string }) => void) {
  const tool = defineTool({
    id: 'test.echo' as const,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async (input) => {
      onExecute?.(input);
      return input;
    },
  });

  return {
    descriptor: {
      id: 'test.echo' as const,
      displayName: 'Echo',
      description: 'Echo test input',
      kind: 'tool' as const,
      integrationId: 'test',
    },
    tool,
  } satisfies CapabilityRegistration<typeof tool>;
}

function createCountRegistration() {
  const tool = defineTool({
    id: 'test.count' as const,
    inputSchema: z.object({ values: z.array(z.number()) }),
    outputSchema: z.object({ count: z.number() }),
    execute: async (input) => ({ count: input.values.length }),
  });

  return {
    descriptor: {
      id: 'test.count' as const,
      displayName: 'Count',
      description: 'Count test values',
      kind: 'tool' as const,
      integrationId: 'test',
    },
    tool,
  } satisfies CapabilityRegistration<typeof tool>;
}

function createGateway() {
  const registrations = [createEchoRegistration(), createCountRegistration()] as const;
  const registry = new CapabilityRegistry(registrations);
  const policy = new CapabilityPolicy([
    { principalId: 'analyst', capabilityIds: ['test.count', 'test.echo'] },
  ]);
  return new CapabilityGateway({ registry, policy, toolRuntime: new ToolRuntime() });
}

describe('CapabilityGateway', () => {
  it('fails fast when policy grants a capability absent from the registry', () => {
    const registry = new CapabilityRegistry([createEchoRegistration()] as const);
    const policy = new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['missing'] }]);

    expect(
      () => new CapabilityGateway({ registry, policy, toolRuntime: new ToolRuntime() }),
    ).toThrowError(new CapabilityRegistryError('UNKNOWN_CAPABILITY', 'Unknown capability: missing'));
  });

  it('lists and describes only authorized frozen data-only descriptors', () => {
    const gateway = createGateway();

    const descriptors = gateway.list(principal);

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(['test.count', 'test.echo']);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0])).toBe(true);
    expect(descriptors[0]).not.toHaveProperty('tool');
    expect(descriptors[0]).not.toHaveProperty('execute');
    expect(gateway.list({ id: 'unknown' })).toEqual([]);
    expect(gateway.describe(principal, 'test.echo')).toEqual(descriptors[1]);
    expect(() => gateway.describe(principal, 'test.count')).not.toThrow();
  });

  it('filters scoped discovery to the principal grant', () => {
    const registrations = [createEchoRegistration(), createCountRegistration()] as const;
    const registry = new CapabilityRegistry(registrations);
    const policy = new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['test.echo'] }]);
    const gateway = new CapabilityGateway({ registry, policy, toolRuntime: new ToolRuntime() });

    const descriptors = gateway.list(principal);

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(['test.echo']);
    expect(descriptors[0]).not.toHaveProperty('tool');
    expect(descriptors[0]).not.toHaveProperty('execute');
    expect(() => gateway.describe(principal, 'test.count')).toThrowError(
      new CapabilityAccessError(
        'CAPABILITY_DENIED',
        'Capability test.count is not granted to principal analyst',
      ),
    );
  });

  it('keeps unknown and denied capability errors distinct', () => {
    const gateway = createGateway();

    expect(() => gateway.describe(principal, 'missing')).toThrowError(
      new CapabilityRegistryError('UNKNOWN_CAPABILITY', 'Unknown capability: missing'),
    );
    expect(() => gateway.describe({ id: 'unknown' }, 'test.echo')).toThrowError(
      new CapabilityAccessError(
        'CAPABILITY_DENIED',
        'Capability test.echo is not granted to principal unknown',
      ),
    );
    expect(() => gateway.list({ id: '' })).toThrowError(/principal ID must be non-empty/);
  });

  it('delegates invocation to ToolRuntime with preserved generic output typing', async () => {
    const registrations = [createEchoRegistration()] as const;
    const registry = new CapabilityRegistry(registrations);
    const policy = new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['test.echo'] }]);
    const runtime = new CountingToolRuntime();
    const gateway = new CapabilityGateway({ registry, policy, toolRuntime: runtime });

    const result = await gateway.invoke(principal, 'test.echo', { value: 'hello' });

    expect(result.value).toEqual({ value: 'hello' });
    expect(result.metadata.toolId).toBe('test.echo');
    expect(runtime.invocationCount).toBe(1);
    expectTypeOf(result.value).toEqualTypeOf<{ value: string }>();
    expect(gateway).not.toHaveProperty('resolveTool');
    expect(gateway).not.toHaveProperty('execute');
  });

  it('does not execute tools directly and preserves ToolRuntime error identity', async () => {
    let executeCount = 0;
    const registration = createEchoRegistration(() => {
      executeCount += 1;
    });
    const registry = new CapabilityRegistry([registration] as const);
    const policy = new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['test.echo'] }]);
    const runtime = new CountingToolRuntime();
    const gateway = new CapabilityGateway({ registry, policy, toolRuntime: runtime });

    await expect(gateway.invoke(principal, 'test.echo', { value: 123 })).rejects.toMatchObject({
      code: 'TOOL_INPUT_INVALID',
    });
    expect(executeCount).toBe(0);

    await expect(gateway.invoke({ id: 'unknown' }, 'test.echo', { value: 'hello' })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    await expect(gateway.invoke(principal, 'missing', {})).rejects.toMatchObject({
      code: 'UNKNOWN_CAPABILITY',
    });
    await expect(gateway.invoke({ id: '' }, 'test.echo', { value: 'hello' })).rejects.toMatchObject({
      code: 'INVALID_CAPABILITY_PRINCIPAL',
    });
    expect(runtime.invocationCount).toBe(1);
    expect(executeCount).toBe(0);
  });

  it('preserves pre-dispatch cancellation through ToolRuntime', async () => {
    let executeCount = 0;
    const registration = createEchoRegistration(() => {
      executeCount += 1;
    });
    const registry = new CapabilityRegistry([registration] as const);
    const policy = new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['test.echo'] }]);
    const runtime = new CountingToolRuntime();
    const gateway = new CapabilityGateway({ registry, policy, toolRuntime: runtime });
    const controller = new AbortController();
    const events: string[] = [];
    controller.abort();

    await expect(
      gateway.invoke(principal, 'test.echo', { value: 'cancelled' }, {
        signal: controller.signal,
        onEvent: (event) => events.push(event.type),
      }),
    ).rejects.toMatchObject({ code: 'TOOL_ABORTED' });
    expect(runtime.invocationCount).toBe(1);
    expect(executeCount).toBe(0);
    expect(events).toEqual(['tool.started', 'tool.cancelled']);
  });

  it('keeps output validation, lifecycle events, and post-handler cancellation in ToolRuntime', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const tool = defineTool({
      id: 'test.output' as const,
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: 'invalid' } as unknown as { ok: boolean }),
    });
    const outputRegistration = {
      descriptor: {
        id: 'test.output' as const,
        displayName: 'Output',
        description: 'Output test',
        kind: 'tool' as const,
        integrationId: 'test',
      },
      tool,
    } satisfies CapabilityRegistration<typeof tool>;
    const cancelTool = defineTool({
      id: 'test.cancel' as const,
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        controller.abort();
        return { ok: true };
      },
    });
    const cancelRegistration = {
      descriptor: {
        id: 'test.cancel' as const,
        displayName: 'Cancel',
        description: 'Cancellation test',
        kind: 'tool' as const,
        integrationId: 'test',
      },
      tool: cancelTool,
    } satisfies CapabilityRegistration<typeof cancelTool>;
    const registry = new CapabilityRegistry([outputRegistration, cancelRegistration] as const);
    const policy = new CapabilityPolicy([
      { principalId: 'analyst', capabilityIds: ['test.cancel', 'test.output'] },
    ]);
    const gateway = new CapabilityGateway({ registry, policy, toolRuntime: new ToolRuntime() });

    await expect(
      gateway.invoke(principal, 'test.output', {}, {
        onEvent: (event) => events.push(event.type),
      }),
    ).rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' });
    expect(events).toEqual(['tool.started', 'tool.failed']);

    await expect(
      gateway.invoke(principal, 'test.cancel', {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'TOOL_ABORTED' });
  });

  it('preserves downstream tool error identity and cancellation semantics', async () => {
    const expected = new Error('domain failure');
    const tool = defineTool({
      id: 'test.failure' as const,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => {
        throw expected;
      },
    });
    const registration = {
      descriptor: {
        id: 'test.failure' as const,
        displayName: 'Failure',
        description: 'Failure test',
        kind: 'tool' as const,
        integrationId: 'test',
      },
      tool,
    } satisfies CapabilityRegistration<typeof tool>;
    const registry = new CapabilityRegistry([registration] as const);
    const policy = new CapabilityPolicy([{ principalId: 'analyst', capabilityIds: ['test.failure'] }]);
    const gateway = new CapabilityGateway({ registry, policy, toolRuntime: new ToolRuntime() });

    await expect(gateway.invoke(principal, 'test.failure', {})).rejects.toBe(expected);

    const controller = new AbortController();
    controller.abort();
    await expect(
      gateway.invoke(principal, 'test.failure', {}, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ToolRuntimeError);
  });
});
