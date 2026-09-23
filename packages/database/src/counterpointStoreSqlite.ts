import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { canonicalJson } from '@harness/shared';
import {
  CitedFigureSchema,
  CounterpointEvidenceLinkSchema,
  GroundedCounterpointSchema,
  type GroundedCounterpoint,
} from '@harness/schemas';
import {
  COUNTERPOINT_POLICY_FINGERPRINT,
  COUNTERPOINT_POLICY_ID,
  type CounterpointStore,
  type StoredCounterpoint,
} from '@harness/execution';
import type { Orm } from './client';
import { claims, counterpoints, runEvidence } from './schema';

type CounterpointRow = typeof counterpoints.$inferSelect;

function assertCodeOwnedIdentity(counterpoint: GroundedCounterpoint): void {
  const prefix = `counterpoint:${counterpoint.sourceNodeId}:`;
  const ordinal = counterpoint.counterpointId.startsWith(prefix) ? counterpoint.counterpointId.slice(prefix.length) : '';
  if (!/^[1-9]\d*$/.test(ordinal)) {
    throw new Error(`Counterpoint ${counterpoint.counterpointId} has invalid code-owned identity for ${counterpoint.sourceNodeId}`);
  }
}

function assertLinkIntegrity(counterpoint: GroundedCounterpoint): void {
  if (counterpoint.evidenceIds.length !== new Set(counterpoint.evidenceIds).size) {
    throw new Error(`Counterpoint ${counterpoint.counterpointId} has duplicate Evidence IDs`);
  }
  const links = counterpoint.evidenceLinks;
  const linkIds = links.map(link => link.evidenceId);
  if (linkIds.length !== new Set(linkIds).size) {
    throw new Error(`Counterpoint ${counterpoint.counterpointId} has duplicate Evidence links`);
  }
  const linked = new Set(linkIds);
  if (counterpoint.evidenceIds.length !== linked.size || counterpoint.evidenceIds.some(id => !linked.has(id))) {
    throw new Error(`Counterpoint ${counterpoint.counterpointId} Evidence links must match evidenceIds`);
  }
  if (counterpoint.citedFigures?.some(figure => !linked.has(figure.evidenceId))) {
    throw new Error(`Counterpoint ${counterpoint.counterpointId} has an unlinked CitedFigure`);
  }
}

/** One fail-closed row projection shared by CounterpointStore and ExecutionStore. */
export function toStoredCounterpoint(row: CounterpointRow): StoredCounterpoint {
  const evidenceIds = JSON.parse(row.evidenceIds) as string[];
  const citedFigures = row.citedFigures === null ? undefined : CitedFigureSchema.array().parse(JSON.parse(row.citedFigures));
  const evidenceLinks = CounterpointEvidenceLinkSchema.array().parse(JSON.parse(row.evidenceLinks));
  if (row.policyId !== COUNTERPOINT_POLICY_ID || row.policyFingerprint !== COUNTERPOINT_POLICY_FINGERPRINT) {
    throw new Error(`Counterpoint ${row.runId}/${row.counterpointId} has corrupt grounding metadata`);
  }
  const stored: StoredCounterpoint = {
    id: row.id,
    runId: row.runId,
    messageId: row.messageId,
    counterpointId: row.counterpointId,
    sourceNodeId: row.sourceNodeId as StoredCounterpoint['sourceNodeId'],
    targetClaimId: row.targetClaimId,
    argument: row.argument,
    strength: row.strength as StoredCounterpoint['strength'],
    evidenceIds,
    ...(citedFigures !== undefined ? { citedFigures } : {}),
    evidenceLinks,
    policyId: row.policyId,
    policyFingerprint: row.policyFingerprint,
    createdAt: row.createdAt,
  };
  const canonical = GroundedCounterpointSchema.parse({
    counterpointId: stored.counterpointId,
    sourceNodeId: stored.sourceNodeId,
    targetClaimId: stored.targetClaimId,
    argument: stored.argument,
    strength: stored.strength,
    evidenceIds: stored.evidenceIds,
    ...(stored.citedFigures !== undefined ? { citedFigures: stored.citedFigures } : {}),
    evidenceLinks: stored.evidenceLinks,
    policyId: stored.policyId,
    policyFingerprint: stored.policyFingerprint,
  });
  assertCodeOwnedIdentity(canonical);
  assertLinkIntegrity(canonical);
  return stored;
}

function semantic(counterpoint: GroundedCounterpoint): string {
  return canonicalJson(counterpoint);
}

/** SQLite implementation of the execution-scoped canonical Counterpoint authority. */
export class CounterpointStoreSqlite implements CounterpointStore {
  constructor(private readonly db: Orm) {}

  async save(params: { runId: string; messageId: string; counterpoint: GroundedCounterpoint }): Promise<StoredCounterpoint> {
    const point = GroundedCounterpointSchema.parse(params.counterpoint);
    if (point.policyId !== COUNTERPOINT_POLICY_ID || point.policyFingerprint !== COUNTERPOINT_POLICY_FINGERPRINT) {
      throw new Error(`Counterpoint ${point.counterpointId} requires current Counterpoint Policy grounding`);
    }
    assertCodeOwnedIdentity(point);
    assertLinkIntegrity(point);

    const [target] = await this.db.select({ claimId: claims.claimId }).from(claims)
      .where(and(eq(claims.runId, params.runId), eq(claims.claimId, point.targetClaimId))).limit(1);
    if (!target) throw new Error(`Counterpoint ${point.counterpointId} target Claim is outside Execution ${params.runId}`);

    const membership = await this.db.select({ evidenceId: runEvidence.evidenceId }).from(runEvidence)
      .where(and(eq(runEvidence.runId, params.runId), inArray(runEvidence.evidenceId, point.evidenceIds)));
    const accepted = new Set(membership.map(row => row.evidenceId));
    if (point.evidenceIds.some(id => !accepted.has(id))) {
      throw new Error(`Counterpoint ${point.counterpointId} Evidence is outside Execution ${params.runId} membership`);
    }

    const row: CounterpointRow = {
      id: randomUUID(),
      runId: params.runId,
      messageId: params.messageId,
      counterpointId: point.counterpointId,
      sourceNodeId: point.sourceNodeId,
      targetClaimId: point.targetClaimId,
      argument: point.argument,
      strength: point.strength,
      evidenceIds: JSON.stringify(point.evidenceIds),
      citedFigures: point.citedFigures === undefined ? null : JSON.stringify(point.citedFigures),
      evidenceLinks: JSON.stringify(point.evidenceLinks),
      policyId: point.policyId,
      policyFingerprint: point.policyFingerprint,
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(counterpoints).values(row)
      .onConflictDoNothing({ target: [counterpoints.runId, counterpoints.counterpointId] });
    const [stored] = await this.db.select().from(counterpoints)
      .where(and(eq(counterpoints.runId, params.runId), eq(counterpoints.counterpointId, point.counterpointId))).limit(1);
    if (!stored) throw new Error(`Counterpoint ${point.counterpointId} was not persisted`);
    const result = toStoredCounterpoint(stored as CounterpointRow);
    const canonicalStored: GroundedCounterpoint = {
      counterpointId: result.counterpointId,
      sourceNodeId: result.sourceNodeId,
      targetClaimId: result.targetClaimId,
      argument: result.argument,
      strength: result.strength,
      evidenceIds: result.evidenceIds,
      ...(result.citedFigures !== undefined ? { citedFigures: result.citedFigures } : {}),
      evidenceLinks: result.evidenceLinks,
      policyId: result.policyId,
      policyFingerprint: result.policyFingerprint,
    };
    if (result.runId !== params.runId || result.messageId !== params.messageId || semantic(canonicalStored) !== semantic(point)) {
      throw new Error(`Counterpoint ${params.runId}/${point.counterpointId} immutable identity conflict`);
    }
    return result;
  }

  async getByRun(runId: string): Promise<StoredCounterpoint[]> {
    const rows = await this.db.select().from(counterpoints).where(eq(counterpoints.runId, runId))
      .orderBy(asc(counterpoints.sourceNodeId), asc(counterpoints.counterpointId));
    return rows.map(row => toStoredCounterpoint(row as CounterpointRow));
  }
}
