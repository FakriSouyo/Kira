import { createHash } from 'node:crypto';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@harness/shared';
import { defineTool, ToolRuntime } from '@harness/tool-runtime';
import {
  CapabilityGateway,
  CapabilityPolicy,
  CapabilityRegistry,
  createCapabilityPlan,
  validateCapabilityPlan,
} from '../src/index';

function gatewayFor(params: {
  descriptors: readonly { id: string; integrationId: string; kind?: 'tool' | string }[];
  grants: readonly { principalId: string; capabilityIds: readonly string[] }[];
}) {
  const registrations = params.descriptors.map((descriptor) => ({
    descriptor: {
      id: descriptor.id,
      displayName: descriptor.id,
      description: `Description for ${descriptor.id}`,
      kind: 'tool' as const,
      integrationId: descriptor.integrationId,
    },
    tool: defineTool({
      id: descriptor.id,
      inputSchema: z.object({}),
      outputSchema: z.string(),
      execute: vi.fn(async () => descriptor.id),
    }),
  }));
  const registry = new CapabilityRegistry(registrations);
  return new CapabilityGateway({
    registry,
    policy: new CapabilityPolicy(params.grants),
    toolRuntime: new ToolRuntime(),
  });
}

describe('CapabilityPlan', () => {
  it('sorts principals and semantic capabilities deterministically and omits display metadata', () => {
    const gateway = gatewayFor({
      descriptors: [
        { id: 'tool.z', integrationId: 'integration-z' },
        { id: 'tool.a', integrationId: 'integration-a' },
      ],
      grants: [
        { principalId: 'principal.z', capabilityIds: ['tool.z', 'tool.a'] },
        { principalId: 'principal.a', capabilityIds: ['tool.a'] },
      ],
    });

    const plan = createCapabilityPlan(gateway, [
      { id: 'principal.z' },
      { id: 'principal.a' },
    ]);

    expect(plan.schemaVersion).toBe(1);
    expect(plan.principals.map((principal) => principal.principalId)).toEqual([
      'principal.a',
      'principal.z',
    ]);
    expect(plan.principals[1]?.capabilities).toEqual([
      { id: 'tool.a', kind: 'tool', integrationId: 'integration-a' },
      { id: 'tool.z', kind: 'tool', integrationId: 'integration-z' },
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/displayName|description|execute/);

    const semantic = {
      schemaVersion: 1,
      principals: [
        {
          principalId: 'principal.a',
          capabilities: [
            { id: 'tool.a', kind: 'tool', integrationId: 'integration-a' },
          ],
        },
        {
          principalId: 'principal.z',
          capabilities: [
            { id: 'tool.a', kind: 'tool', integrationId: 'integration-a' },
            { id: 'tool.z', kind: 'tool', integrationId: 'integration-z' },
          ],
        },
      ],
    };
    expect(plan.fingerprint).toBe(
      createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex'),
    );
  });

  it('produces the same plan for the same scoped authority', () => {
    const gateway = gatewayFor({
      descriptors: [{ id: 'tool.a', integrationId: 'integration-a' }],
      grants: [{ principalId: 'principal.a', capabilityIds: ['tool.a'] }],
    });
    const principals = [{ id: 'principal.a' }];

    expect(createCapabilityPlan(gateway, principals)).toEqual(
      createCapabilityPlan(gateway, principals),
    );
  });

  it('keeps the fingerprint stable when only display metadata changes', () => {
    const left = createCapabilityPlan({
      list: () => [{ id: 'tool.a', displayName: 'Left label', description: 'Left description', kind: 'tool', integrationId: 'integration-a' }],
    }, [{ id: 'principal.a' }]);
    const right = createCapabilityPlan({
      list: () => [{ id: 'tool.a', displayName: 'Right label', description: 'Right description', kind: 'tool', integrationId: 'integration-a' }],
    }, [{ id: 'principal.a' }]);

    expect(left.fingerprint).toBe(right.fingerprint);
  });

  it('rejects a forged fingerprint when validating a persisted plan', () => {
    const plan = createCapabilityPlan({ list: () => [] }, []);

    expect(() => validateCapabilityPlan({ ...plan, fingerprint: '0'.repeat(64) }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY_PLAN' }));
  });

  it('rejects duplicate principal IDs with INVALID_CAPABILITY_PLAN', () => {
    const base = createCapabilityPlan(gatewayFor({
      descriptors: [{ id: 'tool.a', integrationId: 'integration-a' }],
      grants: [{ principalId: 'principal.a', capabilityIds: ['tool.a'] }],
    }), [{ id: 'principal.a' }]);
    const semantic = {
      schemaVersion: 1,
      principals: [
        { principalId: 'principal.a', capabilities: [...base.principals[0]!.capabilities] },
        { principalId: 'principal.a', capabilities: [...base.principals[0]!.capabilities] },
      ],
    };
    const fingerprint = createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex');

    expect(() => validateCapabilityPlan({ ...semantic, fingerprint }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY_PLAN' }));
  });

  it('rejects duplicate capability IDs within one principal with INVALID_CAPABILITY_PLAN', () => {
    const base = createCapabilityPlan(gatewayFor({
      descriptors: [{ id: 'tool.a', integrationId: 'integration-a' }],
      grants: [{ principalId: 'principal.a', capabilityIds: ['tool.a'] }],
    }), [{ id: 'principal.a' }]);
    const capability = base.principals[0]!.capabilities[0]!;
    const semantic = {
      schemaVersion: 1,
      principals: [{
        principalId: 'principal.a',
        capabilities: [capability, { ...capability }],
      }],
    };
    const fingerprint = createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex');

    expect(() => validateCapabilityPlan({ ...semantic, fingerprint }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY_PLAN' }));
  });

  it.each([
    {
      name: 'grant drift',
      left: { id: 'tool.a', integrationId: 'integration-a' },
      right: { id: 'tool.b', integrationId: 'integration-a' },
      leftGrant: ['tool.a'],
      rightGrant: ['tool.b'],
    },
    {
      name: 'integration drift',
      left: { id: 'tool.a', integrationId: 'integration-a' },
      right: { id: 'tool.a', integrationId: 'integration-b' },
      leftGrant: ['tool.a'],
      rightGrant: ['tool.a'],
    },
  ])('changes the fingerprint when $name changes', ({ left, right, leftGrant, rightGrant }) => {
    const leftPlan = createCapabilityPlan(gatewayFor({
      descriptors: [left],
      grants: [{ principalId: 'principal.a', capabilityIds: leftGrant }],
    }), [{ id: 'principal.a' }]);
    const rightPlan = createCapabilityPlan(gatewayFor({
      descriptors: [right],
      grants: [{ principalId: 'principal.a', capabilityIds: rightGrant }],
    }), [{ id: 'principal.a' }]);

    expect(leftPlan.fingerprint).not.toBe(rightPlan.fingerprint);
  });

  it('rejects an invalid semantic kind', () => {
    const principal = { id: 'principal.a' };
    const toolGateway = {
      list: () => [{ id: 'tool.a', displayName: 'A', description: 'A', kind: 'tool', integrationId: 'integration-a' }],
    };
    const otherKindGateway = {
      list: () => [{ id: 'tool.a', displayName: 'A', description: 'A', kind: 'service', integrationId: 'integration-a' }],
    };

    expect(() => createCapabilityPlan(toolGateway as never, [principal])).not.toThrow();
    expect(() => createCapabilityPlan(otherKindGateway as never, [principal]))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY_PLAN' }));
  });

  it('changes the fingerprint when a capability ID changes', () => {
    const principal = { id: 'principal.a' };
    const leftPlan = createCapabilityPlan({
      list: () => [{ id: 'tool.a', displayName: 'A', description: 'A', kind: 'tool', integrationId: 'integration-a' }],
    } as never, [principal]);
    const rightPlan = createCapabilityPlan({
      list: () => [{ id: 'tool.b', displayName: 'A', description: 'A', kind: 'tool', integrationId: 'integration-a' }],
    } as never, [principal]);

    expect(leftPlan.fingerprint).not.toBe(rightPlan.fingerprint);
  });

  it('is deeply immutable and contains no executable binding or execution method', () => {
    const gateway = gatewayFor({
      descriptors: [{ id: 'tool.a', integrationId: 'integration-a' }],
      grants: [{ principalId: 'principal.a', capabilityIds: ['tool.a'] }],
    });
    const plan = createCapabilityPlan(gateway, [{ id: 'principal.a' }]);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.principals)).toBe(true);
    expect(Object.isFrozen(plan.principals[0])).toBe(true);
    expect(Object.isFrozen(plan.principals[0]?.capabilities)).toBe(true);
    expect(Object.isFrozen(plan.principals[0]?.capabilities[0])).toBe(true);
    expect(plan).not.toHaveProperty('tool');
    expect(plan).not.toHaveProperty('execute');
    expect(() => {
      (plan.principals[0]!.capabilities[0] as { id: string }).id = 'tool.changed';
    }).toThrow();
  });

  it('does not include or fingerprint an unrelated principal outside the scoped plan', () => {
    const descriptors = [
      { id: 'tool.a', integrationId: 'integration-a' },
      { id: 'tool.b', integrationId: 'integration-b' },
    ] as const;
    const scopedGateway = gatewayFor({
      descriptors,
      grants: [{ principalId: 'principal.a', capabilityIds: ['tool.a'] }],
    });
    const broaderGateway = gatewayFor({
      descriptors,
      grants: [
        { principalId: 'principal.a', capabilityIds: ['tool.a'] },
        { principalId: 'principal.unrelated', capabilityIds: ['tool.b'] },
      ],
    });

    const scoped = createCapabilityPlan(scopedGateway, [{ id: 'principal.a' }]);
    const withUnrelatedGrant = createCapabilityPlan(broaderGateway, [{ id: 'principal.a' }]);

    expect(scoped).toEqual(withUnrelatedGrant);
    expect(scoped.principals).toHaveLength(1);
  });
});
