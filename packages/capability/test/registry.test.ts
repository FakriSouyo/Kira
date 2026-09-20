import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  type ToolDefinition,
} from '@harness/tool-runtime';
import {
  CapabilityRegistry,
  CapabilityRegistryError,
  type CapabilityDescriptor,
  type CapabilityRegistration,
} from '../src';

const echoTool = defineTool({
  id: 'test.echo',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
  execute: async (input: { value: string }) => ({ value: input.value }),
});

const countTool = defineTool({
  id: 'test.count',
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.object({ value: z.number() }),
  execute: async (input: { value: number }) => ({ value: input.value }),
});

function registration<TTool extends ToolDefinition<any, any, any>>(
  tool: TTool,
  descriptor: Partial<CapabilityDescriptor> = {},
): CapabilityRegistration<TTool> {
  return {
    descriptor: {
      id: tool.id,
      displayName: `Display ${tool.id}`,
      description: `Description ${tool.id}`,
      kind: 'tool',
      integrationId: 'test.integration',
      ...descriptor,
    },
    tool,
  };
}

describe('CapabilityRegistry', () => {
  it('registers valid capabilities and resolves the explicit tool binding', () => {
    const registry = new CapabilityRegistry([registration(echoTool)] as const);

    expect(registry.describe('test.echo')).toEqual({
      id: 'test.echo',
      displayName: 'Display test.echo',
      description: 'Description test.echo',
      kind: 'tool',
      integrationId: 'test.integration',
    });
    expect(registry.resolveTool('test.echo')).toBe(echoTool);
    expectTypeOf(registry.resolveTool('test.echo')).toEqualTypeOf<typeof echoTool>();
  });

  it('list returns safe public descriptors without executable bindings', () => {
    const registry = new CapabilityRegistry([registration(echoTool)] as const);

    const descriptors = registry.list();
    expect(descriptors).toEqual([{
      id: 'test.echo',
      displayName: 'Display test.echo',
      description: 'Description test.echo',
      kind: 'tool',
      integrationId: 'test.integration',
    }]);
    expect(descriptors[0]).not.toHaveProperty('tool');
    expect(descriptors[0]).not.toHaveProperty('execute');
    expect(descriptors[0]).not.toHaveProperty('inputSchema');
  });

  it('orders discovery deterministically by canonical capability ID', () => {
    const first = new CapabilityRegistry([
      registration(countTool),
      registration(echoTool),
    ] as const);
    const second = new CapabilityRegistry([
      registration(echoTool),
      registration(countTool),
    ] as const);

    expect(first.list().map(({ id }) => id)).toEqual(['test.count', 'test.echo']);
    expect(second.list()).toEqual(first.list());
  });

  it('rejects duplicate canonical capability IDs', () => {
    const duplicate = defineTool({
      id: 'test.echo',
      inputSchema: z.object({ value: z.boolean() }),
      outputSchema: z.object({ value: z.boolean() }),
      execute: async (input: { value: boolean }) => ({ value: input.value }),
    });

    expect(() => new CapabilityRegistry([
      registration(echoTool),
      registration(duplicate),
    ])).toThrowError(new CapabilityRegistryError(
      'DUPLICATE_CAPABILITY',
      'Capability test.echo is registered more than once',
    ));
  });

  it.each([
    ['id', { id: '' }],
    ['displayName', { displayName: '   ' }],
    ['description', { description: '' }],
    ['integrationId', { integrationId: '' }],
    ['kind', { kind: 'not-a-tool' as CapabilityDescriptor['kind'] }],
  ])('rejects an invalid descriptor %s', (_field, descriptor) => {
    expect(() => new CapabilityRegistry([
      registration(echoTool, descriptor),
    ])).toThrowError(expect.objectContaining({
      code: 'INVALID_CAPABILITY_REGISTRATION',
    }));
  });

  it('rejects a descriptor whose ID disagrees with the tool ID', () => {
    expect(() => new CapabilityRegistry([
      registration(echoTool, { id: 'test.other' }),
    ])).toThrowError(expect.objectContaining({
      code: 'INVALID_CAPABILITY_REGISTRATION',
    }));
  });

  it('rejects a non-tool binding before it can be resolved', () => {
    expect(() => new CapabilityRegistry([{
      descriptor: {
        id: 'test.invalid',
        displayName: 'Invalid',
        description: 'Invalid binding',
        kind: 'tool',
        integrationId: 'test.integration',
      },
      tool: { id: 'test.invalid' },
    } as unknown as CapabilityRegistration<ToolDefinition<string, unknown, unknown>>])).toThrowError(expect.objectContaining({
      code: 'INVALID_CAPABILITY_REGISTRATION',
    }));
  });

  it('returns a typed error for an unknown capability lookup', () => {
    const registry = new CapabilityRegistry([registration(echoTool)] as const);

    expect(() => registry.describe('test.unknown')).toThrowError(new CapabilityRegistryError(
      'UNKNOWN_CAPABILITY',
      'Unknown capability: test.unknown',
    ));
    expect(() => registry.resolveTool('test.unknown')).toThrowError(expect.objectContaining({
      code: 'UNKNOWN_CAPABILITY',
    }));
  });

  it('keeps registry state immutable when returned descriptors are mutated', () => {
    const registry = new CapabilityRegistry([registration(echoTool)] as const);
    const listed = registry.list();
    const described = registry.describe('test.echo');

    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(Object.isFrozen(described)).toBe(true);
    expect(() => {
      (listed[0] as { displayName: string }).displayName = 'Changed';
    }).toThrow(TypeError);
    expect(registry.describe('test.echo').displayName).toBe('Display test.echo');
  });

  it('does not expose execution authority or mutation methods', () => {
    const registry = new CapabilityRegistry([registration(echoTool)] as const);

    expect(registry).not.toHaveProperty('invoke');
    expect(registry).not.toHaveProperty('execute');
    expect(registry).not.toHaveProperty('run');
    expect(registry).not.toHaveProperty('register');
    expect(registry).not.toHaveProperty('remove');
  });
});
