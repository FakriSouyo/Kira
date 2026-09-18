import { createHash } from 'node:crypto';
import { canonicalJson } from '@harness/shared';
import { z } from 'zod';
import {
  ContextPacketSchema,
  type ContextPacket,
} from './contracts.js';

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const ContextSnapshotIdSchema = z.string().regex(/^snapshot_[0-9a-f]{64}$/);
export type ContextSnapshotId = string;

export const ContextSnapshotRefSchema = z.object({ snapshotId: ContextSnapshotIdSchema }).strict();
export type ContextSnapshotRef = { readonly snapshotId: ContextSnapshotId };

export const ContextSnapshotSchema = z.object({
  snapshotId: ContextSnapshotIdSchema,
  schemaVersion: z.literal(CONTEXT_SNAPSHOT_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  workingContextVersion: z.number().int().nonnegative(),
  packetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  packet: ContextPacketSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export interface ContextSnapshot<TPacket extends ContextPacket = ContextPacket> {
  readonly snapshotId: ContextSnapshotId;
  readonly schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly turnId: string;
  readonly workingContextVersion: number;
  readonly packetFingerprint: string;
  readonly packet: TPacket;
  readonly createdAt: string;
}

export interface CreateContextSnapshotParams<TPacket extends ContextPacket = ContextPacket> {
  readonly sessionId: string;
  readonly turnId: string;
  readonly packet: TPacket;
  readonly snapshotId?: ContextSnapshotId;
  readonly createdAt?: string;
}

export interface ContextSnapshotStore {
  save(snapshot: ContextSnapshot): Promise<ContextSnapshot>;
  getById(snapshotId: ContextSnapshotId): Promise<ContextSnapshot | null>;
}

export class ContextSnapshotConflictError extends Error {
  readonly code = 'CONTEXT_SNAPSHOT_CONFLICT';

  constructor(readonly snapshotId: ContextSnapshotId, message: string) {
    super(message);
    this.name = 'ContextSnapshotConflictError';
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function freezeContextSnapshot<TPacket extends ContextPacket>(value: ContextSnapshot<TPacket>): ContextSnapshot<TPacket> {
  return deepFreeze(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function contextPacketFingerprint(packet: ContextPacket): string {
  return digest(packet);
}

/** Creates an immutable envelope without changing the ContextPacket instance. */
export function createContextSnapshot<TPacket extends ContextPacket>(params: CreateContextSnapshotParams<TPacket>): ContextSnapshot<TPacket> {
  const packet = ContextPacketSchema.parse(structuredClone(params.packet));
  if (packet.sessionId !== params.sessionId || packet.provenance.sessionId !== params.sessionId) {
    throw new Error(`ContextSnapshot packet belongs to session ${packet.sessionId}, not ${params.sessionId}`);
  }
  if (packet.turnId !== params.turnId || packet.provenance.turnId !== params.turnId) {
    throw new Error(`ContextSnapshot packet belongs to turn ${packet.turnId}, not ${params.turnId}`);
  }
  const packetFingerprint = contextPacketFingerprint(packet);
  const snapshotId = params.snapshotId ?? (`snapshot_${digest({ sessionId: params.sessionId, turnId: params.turnId, packetFingerprint })}` as ContextSnapshotId);
  ContextSnapshotIdSchema.parse(snapshotId);
  const value = ContextSnapshotSchema.parse({
    snapshotId,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    sessionId: params.sessionId,
    turnId: params.turnId,
    workingContextVersion: packet.provenance.workingContextVersion,
    packetFingerprint,
    packet,
    createdAt: params.createdAt ?? new Date().toISOString(),
  });
  return freezeContextSnapshot(value as unknown as ContextSnapshot<TPacket>);
}

export function contextSnapshotSemanticJson(snapshot: ContextSnapshot): string {
  return canonicalJson({
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    turnId: snapshot.turnId,
    workingContextVersion: snapshot.workingContextVersion,
    packetFingerprint: snapshot.packetFingerprint,
    packet: snapshot.packet,
  });
}

export function sameContextSnapshot(left: ContextSnapshot, right: ContextSnapshot): boolean {
  return contextSnapshotSemanticJson(left) === contextSnapshotSemanticJson(right);
}
