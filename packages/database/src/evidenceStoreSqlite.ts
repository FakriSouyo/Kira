import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { canonicalJson } from '@harness/shared';
import { canonicalHash, EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID, type AcceptedEvidenceDecision, type EvidenceAcceptance, type EvidenceStore } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import type { Orm } from './client';
import { evidence, runEvidence } from './schema';

export interface EvidenceRow {
  id: string; runId: string; ticker: string; source: string; sourceType: string;
  contentHash: string; retrievedAt: string; validAt: string | null;
  data: string; provenance: string | null; createdAt: string;
}

type Membership = typeof runEvidence.$inferSelect;

function acceptanceOf(membership: Membership): Evidence['acceptance'] {
  if (membership.policyId === null) {
    if (membership.policyFingerprint !== null || membership.candidateKind !== null || membership.sourceOrigin !== null
      || membership.retrievedAt !== null || membership.acceptedAt !== null || membership.validAt !== null || membership.provenanceJson !== null) {
      throw new Error(`Evidence membership ${membership.runId}/${membership.evidenceId} has partial acceptance metadata`);
    }
    return {
      policyId: 'legacy-v0', policyFingerprint: null, candidateKind: 'legacy', sourceOrigin: null,
      retrievedAt: null, acceptedAt: null, validAt: null, provenance: {}, legacy: true,
    };
  }
  if (membership.policyId !== EVIDENCE_POLICY_ID || membership.policyFingerprint !== EVIDENCE_POLICY_FINGERPRINT || membership.candidateKind !== 'financial'
    || !membership.sourceOrigin || !membership.acceptedAt || !membership.provenanceJson) {
    throw new Error(`Evidence membership ${membership.runId}/${membership.evidenceId} is corrupt`);
  }
  const provenance = JSON.parse(membership.provenanceJson) as Record<string, unknown>;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error(`Evidence membership ${membership.runId}/${membership.evidenceId} has invalid provenance`);
  }
  return {
    policyId: membership.policyId, policyFingerprint: membership.policyFingerprint, candidateKind: 'financial', sourceOrigin: membership.sourceOrigin,
    retrievedAt: membership.retrievedAt, acceptedAt: membership.acceptedAt,
    validAt: membership.validAt, provenance,
  };
}

/** Global reads retain content-row provenance; scoped reads project the accepting Execution. */
export function toEvidence(row: EvidenceRow, membership?: Membership): Evidence {
  const acceptance = membership ? acceptanceOf(membership) : undefined;
  return {
    id: row.id, runId: membership?.runId ?? row.runId, ticker: row.ticker,
    source: row.source,
    sourceType: membership?.policyId ? sourceType(membership.sourceOrigin) : row.sourceType as Evidence['sourceType'],
    contentHash: row.contentHash, retrievedAt: acceptance?.retrievedAt ?? row.retrievedAt,
    validAt: acceptance ? acceptance.validAt : row.validAt,
    data: JSON.parse(row.data) as Record<string, unknown>,
    provenance: acceptance?.provenance ?? (row.provenance ? JSON.parse(row.provenance) as Record<string, unknown> : null),
    ...(acceptance ? { acceptance } : {}), createdAt: row.createdAt,
  };
}

function sourceType(origin: string | null): Evidence['sourceType'] {
  switch (origin) {
    case 'CACHE': return 'cached';
    case 'MOCK': return 'mock';
    case 'DERIVED': return 'derived';
    case 'DOCUMENT': return 'document';
    default: return 'api';
  }
}

export class EvidenceStoreSqlite implements EvidenceStore {
  constructor(private readonly db: Orm) {}

  async accept(params: { runId: string; ticker: string; source: string; data: Record<string, unknown>; acceptance: AcceptedEvidenceDecision }): Promise<Evidence> {
    const sourceMetadata = params.acceptance.provenance.metadata as Record<string, unknown> | undefined;
    if (params.acceptance.policyId !== EVIDENCE_POLICY_ID || params.acceptance.policyFingerprint !== EVIDENCE_POLICY_FINGERPRINT || params.acceptance.candidateKind !== 'financial'
      || params.acceptance.executionId !== params.runId || params.acceptance.ticker !== params.ticker
      || !params.acceptance.sourceOrigin || !params.acceptance.acceptedAt || !params.acceptance.accepted
      || !sourceMetadata || typeof sourceMetadata !== 'object' || Array.isArray(sourceMetadata)
      || sourceMetadata.source !== params.source || sourceMetadata.origin !== params.acceptance.sourceOrigin
      || canonicalJson(params.data) !== canonicalJson(params.acceptance.data)) {
      throw new Error('Evidence acceptance receipt is invalid');
    }
    return this.#persist({ ...params, acceptance: {
      policyId: params.acceptance.policyId, policyFingerprint: params.acceptance.policyFingerprint, candidateKind: params.acceptance.candidateKind,
      sourceOrigin: params.acceptance.sourceOrigin, retrievedAt: params.acceptance.retrievedAt,
      acceptedAt: params.acceptance.acceptedAt, validAt: params.acceptance.validAt,
      provenance: params.acceptance.provenance,
    } });
  }

  async #persist(params: { runId: string; ticker: string; source: string; data: Record<string, unknown>; acceptance: EvidenceAcceptance }): Promise<Evidence> {
    const contentHash = canonicalHash(params.data);
    return this.db.transaction((tx) => {
      let row = tx.select().from(evidence).where(and(
        eq(evidence.contentHash, contentHash), eq(evidence.ticker, params.ticker), eq(evidence.source, params.source),
      )).limit(1).get() as EvidenceRow | undefined;
      if (!row) {
        const now = new Date().toISOString();
        row = {
          id: randomUUID(), runId: params.runId, ticker: params.ticker, source: params.source,
          sourceType: sourceType(params.acceptance.sourceOrigin), contentHash,
          retrievedAt: params.acceptance.retrievedAt ?? now, validAt: params.acceptance.validAt,
          data: JSON.stringify(params.data), provenance: canonicalJson(params.acceptance.provenance),
          createdAt: now,
        };
        tx.insert(evidence).values(row).run();
      }
      const membership = {
        runId: params.runId, evidenceId: row.id,
        policyId: params.acceptance.policyId,
        policyFingerprint: params.acceptance.policyFingerprint,
        candidateKind: params.acceptance.candidateKind,
        sourceOrigin: params.acceptance.sourceOrigin,
        retrievedAt: params.acceptance.retrievedAt,
        acceptedAt: params.acceptance.acceptedAt,
        validAt: params.acceptance.validAt,
        provenanceJson: canonicalJson(params.acceptance.provenance),
      };
      tx.insert(runEvidence).values(membership).onConflictDoNothing().run();
      const stored = tx.select().from(runEvidence).where(and(eq(runEvidence.runId, params.runId), eq(runEvidence.evidenceId, row.id))).get();
      if (!stored) {
        throw new Error(`Evidence ${params.runId}/${row.id} immutable acceptance conflict`);
      }
      const { acceptedAt: _storedAcceptedAt, ...storedSemantics } = stored;
      const { acceptedAt: _requestedAcceptedAt, ...requestedSemantics } = membership;
      if (canonicalJson(storedSemantics) !== canonicalJson(requestedSemantics)) {
        throw new Error(`Evidence ${params.runId}/${row.id} immutable acceptance conflict`);
      }
      return toEvidence(row, stored);
    });
  }

  async getManyByIds(ids: string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(evidence).where(inArray(evidence.id, ids));
    const byId = new Map(rows.map(row => [row.id, toEvidence(row as EvidenceRow)]));
    return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
  }

  async getManyByIdsForRun(runId: string, ids: string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select({ evidence, membership: runEvidence }).from(runEvidence)
      .innerJoin(evidence, eq(runEvidence.evidenceId, evidence.id))
      .where(and(eq(runEvidence.runId, runId), inArray(runEvidence.evidenceId, ids)));
    const byId = new Map(rows.map(row => [row.evidence.id, toEvidence(row.evidence as EvidenceRow, row.membership)]));
    return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
  }

  async getByTicker(ticker: string): Promise<Evidence[]> {
    const rows = await this.db.select().from(evidence).where(eq(evidence.ticker, ticker));
    return rows.map(row => toEvidence(row as EvidenceRow));
  }

  async getByRun(runId: string): Promise<Evidence[]> {
    const rows = await this.db.select({ evidence, membership: runEvidence }).from(runEvidence)
      .innerJoin(evidence, eq(runEvidence.evidenceId, evidence.id)).where(eq(runEvidence.runId, runId));
    return rows.map(row => toEvidence(row.evidence as EvidenceRow, row.membership));
  }
}
