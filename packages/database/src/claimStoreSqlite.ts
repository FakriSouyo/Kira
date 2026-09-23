import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { canonicalJson } from '@harness/shared';
import { CitedFigureSchema, ClaimEvidenceLinkSchema, ClaimSchema, type Claim } from '@harness/schemas';
import { CLAIM_POLICY_FINGERPRINT, CLAIM_POLICY_ID, type ClaimStore, type GroundedClaim, type StoredClaim } from '@harness/execution';
import type { Orm } from './client';
import { claims, runEvidence } from './schema';

type ClaimRow = typeof claims.$inferSelect;

function assertLinkIntegrity(claim: Claim): void {
  if (claim.evidenceIds.length !== new Set(claim.evidenceIds).size) {
    throw new Error(`Claim ${claim.claimId} has duplicate Evidence IDs`);
  }
  const links = claim.evidenceLinks;
  if (!links || links.length !== new Set(links.map(link => link.evidenceId)).size
    || links.length !== new Set(claim.evidenceIds).size
    || claim.evidenceIds.some(id => !links.some(link => link.evidenceId === id))) {
    throw new Error(`Claim ${claim.claimId} has invalid Evidence links`);
  }
  if (claim.citedFigures?.some(figure => !links.some(link => link.evidenceId === figure.evidenceId))) {
    throw new Error(`Claim ${claim.claimId} has an unlinked CitedFigure`);
  }
}

/** One fail-closed row projection shared by ClaimStore and ExecutionStore. */
export function toStoredClaim(row: ClaimRow): StoredClaim {
  const evidenceIds = JSON.parse(row.evidenceIds) as string[];
  const citedFigures = row.citedFigures === null ? undefined : CitedFigureSchema.array().parse(JSON.parse(row.citedFigures));
  const evidenceLinks = row.evidenceLinks === null ? undefined : ClaimEvidenceLinkSchema.array().parse(JSON.parse(row.evidenceLinks));
  if (row.singleMetric !== null && row.singleMetric !== 0 && row.singleMetric !== 1) {
    throw new Error(`Claim ${row.runId}/${row.claimId} has corrupt singleMetric metadata`);
  }
  if (row.policyId === null) {
    if (row.policyFingerprint !== null || row.evidenceLinks !== null) {
      throw new Error(`Claim ${row.runId}/${row.claimId} has partial grounding metadata`);
    }
  } else if (row.policyId !== CLAIM_POLICY_ID || row.policyFingerprint !== CLAIM_POLICY_FINGERPRINT || !evidenceLinks) {
    throw new Error(`Claim ${row.runId}/${row.claimId} has corrupt grounding metadata`);
  }
  const result: StoredClaim = {
    id: row.id, runId: row.runId, messageId: row.messageId,
    claimId: row.claimId, statement: row.statement,
    confidence: row.confidence as StoredClaim['confidence'], reasoning: row.reasoning,
    evidenceIds, createdAt: row.createdAt,
    ...(citedFigures !== undefined ? { citedFigures } : {}),
    ...(row.singleMetric !== null ? { singleMetric: row.singleMetric === 1 } : {}),
    ...(evidenceLinks !== undefined ? { evidenceLinks } : {}),
    ...(row.policyId !== null ? { policyId: row.policyId, policyFingerprint: row.policyFingerprint! } : {}),
  };
  if (row.policyId !== null) assertLinkIntegrity(result as Claim);
  return result;
}

function semantic(claim: Claim): object {
  return {
    claimId: claim.claimId, statement: claim.statement, confidence: claim.confidence,
    reasoning: claim.reasoning, evidenceIds: claim.evidenceIds,
    citedFigures: claim.citedFigures, singleMetric: claim.singleMetric,
    evidenceLinks: claim.evidenceLinks, policyId: claim.policyId, policyFingerprint: claim.policyFingerprint,
  };
}

/** Immutable canonical Claim authority; current writes require a Claim Policy result. */
export class ClaimStoreSqlite implements ClaimStore {
  constructor(private readonly db: Orm) {}

  async save(params: { runId: string; messageId: string; claim: GroundedClaim }): Promise<StoredClaim> {
    const claim = ClaimSchema.parse(params.claim);
    if (claim.policyId !== CLAIM_POLICY_ID || claim.policyFingerprint !== CLAIM_POLICY_FINGERPRINT) {
      throw new Error(`Claim ${claim.claimId} requires current Claim Policy grounding`);
    }
    assertLinkIntegrity(claim);
    const membership = await this.db.select({ evidenceId: runEvidence.evidenceId }).from(runEvidence)
      .where(and(eq(runEvidence.runId, params.runId), inArray(runEvidence.evidenceId, claim.evidenceIds)));
    const accepted = new Set(membership.map(row => row.evidenceId));
    if (claim.evidenceIds.some(id => !accepted.has(id))) {
      throw new Error(`Claim ${claim.claimId} Evidence is outside Execution ${params.runId} membership`);
    }
    return this.persist({ ...params, claim });
  }

  async repairLegacyCheckpointProjection(params: { runId: string; messageId: string; claim: Claim }): Promise<StoredClaim> {
    const claim = ClaimSchema.parse(params.claim);
    if (claim.policyId !== undefined || claim.policyFingerprint !== undefined || claim.evidenceLinks !== undefined) {
      throw new Error(`Legacy checkpoint Claim ${claim.claimId} contains partial T2 grounding`);
    }
    return this.persist({ ...params, claim });
  }

  private async persist(params: { runId: string; messageId: string; claim: Claim }): Promise<StoredClaim> {
    const row: ClaimRow = {
      id: randomUUID(), runId: params.runId, messageId: params.messageId,
      claimId: params.claim.claimId, statement: params.claim.statement,
      confidence: params.claim.confidence, reasoning: params.claim.reasoning,
      evidenceIds: JSON.stringify(params.claim.evidenceIds),
      citedFigures: params.claim.citedFigures === undefined ? null : JSON.stringify(params.claim.citedFigures),
      singleMetric: params.claim.singleMetric === undefined ? null : Number(params.claim.singleMetric),
      evidenceLinks: params.claim.evidenceLinks === undefined ? null : JSON.stringify(params.claim.evidenceLinks),
      policyId: params.claim.policyId ?? null,
      policyFingerprint: params.claim.policyFingerprint ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(claims).values(row).onConflictDoNothing({ target: [claims.runId, claims.claimId] });
    const stored = await this.db.select().from(claims)
      .where(and(eq(claims.runId, params.runId), eq(claims.claimId, params.claim.claimId))).limit(1);
    if (!stored[0]) throw new Error(`Claim ${params.claim.claimId} was not persisted`);
    const result = toStoredClaim(stored[0]);
    if (result.runId !== params.runId || result.messageId !== params.messageId
      || canonicalJson(semantic(result as Claim)) !== canonicalJson(semantic(params.claim))) {
      throw new Error(`Claim ${params.runId}/${params.claim.claimId} immutable identity conflict`);
    }
    return result;
  }

  async getByRun(runId: string): Promise<StoredClaim[]> {
    const rows = await this.db.select().from(claims).where(eq(claims.runId, runId)).orderBy(asc(claims.claimId));
    return rows.map(toStoredClaim);
  }
}
