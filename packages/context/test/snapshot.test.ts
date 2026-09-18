import { describe, expect, it } from 'vitest';
import {
  ContextPacketSchema,
  ContextSnapshotRefSchema,
  ContextSnapshotSchema,
  createContextSnapshot,
  type ContextPacket,
  type ContextSnapshotId,
} from '../src/index.js';

const BASE_PACKET: ContextPacket = {
  schemaVersion: 1,
  sessionId: 'session-1',
  turnId: 'turn-1',
  activeSubjects: [{ ticker: 'BBRI' }, { ticker: 'BMRI' }],
  intent: { command: 'conversation' },
  focusTopics: [{ topic: 'valuation' }],
  artifacts: [],
  userAssertions: [{ kind: 'USER_ASSERTION', id: 'assert-1', text: 'NIM akan turun', turnId: 'turn-1' }],
  assumptions: [{ kind: 'ASSUMPTION', id: 'assume-1', text: 'margin stays flat', turnId: 'turn-1' }],
  unresolvedQuestions: [{ kind: 'OPEN_QUESTION', id: 'question-1', text: 'why did BBRI fall?', turnId: 'turn-1' }],
  provenance: {
    sessionId: 'session-1', turnId: 'turn-1', workingContextVersion: 4, sourceContextSequence: 12,
    sourceRefs: [], selectedArtifactIds: [], diagnostics: [],
  },
};

function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return { ...BASE_PACKET, ...overrides } as ContextPacket;
}

function snapshot(input: Partial<Parameters<typeof createContextSnapshot>[0]> = {}) {
  return createContextSnapshot({
    sessionId: 'session-1', turnId: 'turn-1', packet: BASE_PACKET,
    createdAt: '2026-09-18T00:00:00.000Z', ...input,
  });
}

describe('ContextSnapshot contract', () => {
  it('creates a schema-versioned durable snapshot with a stable identity', () => {
    const value = snapshot();
    expect(value).toMatchObject({ schemaVersion: 1, sessionId: 'session-1', turnId: 'turn-1', workingContextVersion: 4 });
    expect(value.snapshotId).toMatch(/^snapshot_[0-9a-f]{64}$/);
    expect(value.packetFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ContextSnapshotSchema.parse(value)).toEqual(value);
    expect(ContextSnapshotRefSchema.parse({ snapshotId: value.snapshotId })).toEqual({ snapshotId: value.snapshotId });
  });

  it('rejects malformed snapshot IDs and unsupported snapshot versions', () => {
    expect(() => ContextSnapshotSchema.parse({ ...snapshot(), snapshotId: 'turn-1' })).toThrow();
    expect(() => ContextSnapshotSchema.parse({ ...snapshot(), schemaVersion: 2 })).toThrow();
    expect(() => ContextSnapshotRefSchema.parse({ snapshotId: '' })).toThrow();
  });

  it('preserves the exact structured packet and trust distinctions', () => {
    const value = snapshot();
    expect(ContextPacketSchema.parse(value.packet)).toEqual(BASE_PACKET);
    expect(value.packet.userAssertions[0]?.kind).toBe('USER_ASSERTION');
    expect(value.packet.assumptions[0]?.kind).toBe('ASSUMPTION');
    expect(value.packet.unresolvedQuestions[0]?.kind).toBe('OPEN_QUESTION');
    expect(value.packet.activeSubjects).toEqual([{ ticker: 'BBRI' }, { ticker: 'BMRI' }]);
  });

  it('uses deterministic canonical JSON for equal semantic packets', () => {
    const reordered: ContextPacket = {
      ...BASE_PACKET,
      provenance: {
        diagnostics: [], selectedArtifactIds: [], sourceRefs: [], sourceContextSequence: 12,
        workingContextVersion: 4, turnId: 'turn-1', sessionId: 'session-1',
      },
    };
    const first = snapshot({ packet: BASE_PACKET });
    const second = snapshot({ packet: reordered });
    expect(second.packetFingerprint).toBe(first.packetFingerprint);
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it('changes fingerprint and identity when meaningful packet content changes', () => {
    const first = snapshot();
    const second = snapshot({ packet: packet({ focusTopics: [{ topic: 'risk' }] }) });
    expect(second.packetFingerprint).not.toBe(first.packetFingerprint);
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });

  it('excludes operational creation time from semantic identity', () => {
    const first = snapshot({ createdAt: '2026-09-18T00:00:00.000Z' });
    const second = snapshot({ createdAt: '2026-09-18T01:00:00.000Z' });
    expect(second.packetFingerprint).toBe(first.packetFingerprint);
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it('allows an explicit valid identity for immutable conflict detection', () => {
    const snapshotId = 'snapshot_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as ContextSnapshotId;
    expect(snapshot({ snapshotId }).snapshotId).toBe(snapshotId);
  });

  it('rejects packet/session/turn mismatches and malformed packets', () => {
    expect(() => createContextSnapshot({ sessionId: 'session-2', turnId: 'turn-1', packet: BASE_PACKET })).toThrow(/session/i);
    expect(() => createContextSnapshot({ sessionId: 'session-1', turnId: 'turn-2', packet: BASE_PACKET })).toThrow(/turn/i);
    expect(() => createContextSnapshot({ sessionId: 'session-1', turnId: 'turn-1', packet: { ...BASE_PACKET, schemaVersion: 2 } as never })).toThrow();
  });

  it('does not mutate the input packet or add persistence identity to it', () => {
    const before = structuredClone(BASE_PACKET);
    const value = snapshot();
    expect(BASE_PACKET).toEqual(before);
    expect(value.packet).not.toHaveProperty('snapshotId');
    expect(value.packet).not.toHaveProperty('packetFingerprint');
  });
});
