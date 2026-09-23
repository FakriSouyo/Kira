import { ClaimSchema, type Claim, type Evidence } from '@harness/schemas';
import { UserFriendlyError, ValidationError } from '@harness/shared';
import type { EvidenceStore } from '@harness/evidence';

const NUMERIC_TOLERANCE = 0.5; // toleransi untuk pembulatan % (mis. 30.6% vs 30.59%)

// ─────────────────────────────────────────────────────────────────────────────
// P1.1 Multi-Metric Reconciliation — flag deterministik `singleMetric`
// ─────────────────────────────────────────────────────────────────────────────
// Pasangan metrik yang harus direkonsiliasi standar (anti cherry-picking, §15):
//   1. quarterly vs cumulativeYtd — family `growth:<metric>` (revenue/netIncome)
//   2. distribution vs aggregate  — family `sentiment`
//   3. short vs long foreign window — family `foreignWindow`
// Sisi = varian yang berbeda dari metrik yang SAMA; flag muncul bila claim hanya
// mengutip satu sisi padahal sisi lain turut tersedia di evidence miliknya.
const GROWTH_METRICS = ['revenueGrowthYoy', 'netIncomeGrowthYoy'] as const;

type MetricPath = { family: string; side: string };

/** Peta path `citedFigures.path` → (family, side). null bila bukan pasangan yang dikenal. */
function classifyCitedPath(path: string): MetricPath | null {
  let m = /^quarters(?:\.\d+|\[\d+\])?\.(revenueGrowthYoy|netIncomeGrowthYoy)$/.exec(path);
  if (m) return { family: `growth:${m[1]}`, side: 'quarterly' };
  m = /^cumulativeYtd\.(revenueGrowthYoy|netIncomeGrowthYoy)$/.exec(path);
  if (m) return { family: `growth:${m[1]}`, side: 'cumulative' };
  if (/^distribution(?:\.\w+)?$/.test(path)) return { family: 'sentiment', side: 'distribution' };
  if (path === 'aggregate') return { family: 'sentiment', side: 'aggregate' };
  return null;
}

function addSide(map: Map<string, Set<string>>, family: string, side: string): void {
  let set = map.get(family);
  if (!set) map.set(family, (set = new Set()));
  set.add(side);
}

/**
 * Deteksi deterministik flag `singleMetric` (P1.1).
 *
 * Untuk tiap claim:
 * - disusun `available` = sisi pasangan metrik yang TERSEDIA di evidence yang
 *   diandalkan claim (materials di data evidence), dan
 * - `cited` = sisi yang benar-benar DIKUTIP claim via `citedFigures` (path).
 * `singleMetric === true` bila untuk suatu family kedua sisi tersedia namun claim
 * hanya mengutip salah satunya.
 *
 * foreignWindow: sisi = distinct `window` pada evidence `sectors.foreign_flow`
 * milik ticker claim (dari `evidenceById`, cakupan batch run). `single_metric`
 * bila tersedia ≥2 window berbeda namun claim hanya mengandalkan satu window.
 *
 * Murni & deterministik dari input — tanpa state eksternal. Backward-compat:
 * meng-copy claim, hanya menambahkan `singleMetric` bila terdeteksi.
 */
export function detectSingleMetricFlags(
  claims: readonly Claim[],
  evidenceById: ReadonlyMap<string, Evidence>,
): Claim[] {
  return claims.map((claim) => {
    const available = new Map<string, Set<string>>();
    const cited = new Map<string, Set<string>>();

    for (const id of claim.evidenceIds) {
      const ev = evidenceById.get(id);
      if (!ev || typeof ev.data !== 'object' || ev.data === null) continue;
      const data = ev.data as Record<string, unknown>;

      const quarters = Array.isArray(data['quarters']) ? data['quarters'] : null;
      const cumulative = data['cumulativeYtd'];
      for (const metric of GROWTH_METRICS) {
        const inQuarterly = quarters?.some(
          (q) => q !== null && typeof q === 'object' && metric in (q as Record<string, unknown>),
        );
        const inCumulative =
          cumulative !== null && typeof cumulative === 'object' && metric in (cumulative as Record<string, unknown>);
        if (inQuarterly) addSide(available, `growth:${metric}`, 'quarterly');
        if (inCumulative) addSide(available, `growth:${metric}`, 'cumulative');
      }

      if (typeof data['aggregate'] === 'number') addSide(available, 'sentiment', 'aggregate');
      const dist = data['distribution'];
      if (dist !== null && typeof dist === 'object' && Object.keys(dist as object).length > 0) {
        addSide(available, 'sentiment', 'distribution');
      }
    }

    for (const cf of claim.citedFigures ?? []) {
      const cls = classifyCitedPath(cf.path);
      if (cls) addSide(cited, cls.family, cls.side);
    }

    // Family growth & sentiment: kedua sisi tersedia, claim kutip tepat satu.
    const isOneSided = (family: string): boolean => {
      const avail = available.get(family);
      const cit = cited.get(family);
      if (!avail || avail.size < 2) return false; // sisi lawan tak tersedia → bukan kasus pairing
      if (!cit || cit.size === 0) return false; // tak ada sisi yang dikutip
      return cit.size === 1; // kutip tepat satu dari dua sisi yang tersedia
    };

    let singleMetric =
      isOneSided('sentiment') ||
      GROWTH_METRICS.some((m) => isOneSided(`growth:${m}`));

    // short vs long foreign window: bandingkan window yang dimanfaatkan claim vs
    // seluruh window foreign yang tersedia untuk ticker yang sama di batch run.
    if (!singleMetric) {
      const ticker = claim.evidenceIds
        .map((id) => evidenceById.get(id))
        .find((ev) => ev?.ticker)?.ticker;
      if (ticker) {
        const availableWindows = new Set<string>();
        for (const ev of evidenceById.values()) {
          if (ev.ticker === ticker && ev.source === 'sectors.foreign_flow' && typeof ev.data['window'] === 'string') {
            availableWindows.add(ev.data['window'] as string);
          }
        }
        if (availableWindows.size >= 2) {
          const usedWindows = new Set<string>();
          for (const id of claim.evidenceIds) {
            const ev = evidenceById.get(id);
            if (ev?.source === 'sectors.foreign_flow' && typeof ev.data['window'] === 'string') {
              usedWindows.add(ev.data['window'] as string);
            }
          }
          if (usedWindows.size >= 1 && usedWindows.size < availableWindows.size) singleMetric = true;
        }
      }
    }

    return singleMetric ? { ...claim, singleMetric: true } : claim;
  });
}

function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  // Support "a.b", "quarters[0].revenueGrowthYoy", "cumulativeYtd.revenueGrowthYoy"
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Validasi claim 3 lapis (addendum §16):
 *   Layer 1 — struktur (Zod)
 *   Layer 2 — evidence ada di DB
 *   Layer 3 — evidence termasuk allowed set milik run ini
 */
export class ClaimValidator {
  constructor(private readonly evidenceStore: EvidenceStore) {}

  /**
   * Baca evidence; bila *eksekusi* store gagal (DB/network), bungkus sebagai
   * `VALIDATION_UNAVAILABLE` — fail-closed (addendum §24-B.3): jangan pernah
   * lanjut tanpa proof eksistensi. (Kegagalan *data* = store sukses tapi id
   * tak ada → ditangani pemanggil sebagai ValidationError.)
   */
  private async readEvidence(executionId: string, ids: string[]): Promise<Evidence[]> {
    try {
      return await this.evidenceStore.getManyByIdsForRun(executionId, ids);
    } catch (cause) {
      throw new UserFriendlyError(
        'VALIDATION_UNAVAILABLE',
        `Could not execute evidence validation (storage read failed): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        `Run failed because proof of evidence existence could not be checked — integrity is fail-closed (addendum §24-B.3).`,
      );
    }
  }

  /**
   * Validasi challenge Bear (Phase 1, addendum §16/§15) — run-scoped:
   *   - setiap targetClaimId harus menunjuk klaim Bull milik run ini
   *   - evidenceIds Bear harus ada di DB dan termasuk allowed set run
   * (struktur `strength`/`argument` sudah ditegakkan Zod di BearLLMOutputSchema)
   */
  async validateChallenge(
    counterpoints: Array<{ targetClaimId: string; argument: string; strength: string }>,
    bearEvidenceIds: string[],
    allowed: { executionId: string; claimIds: string[]; evidenceIds: string[] },
  ): Promise<void> {
    const allowedClaims = new Set(allowed.claimIds);
    for (const cp of counterpoints) {
      if (!allowedClaims.has(cp.targetClaimId)) {
        throw new ValidationError(
          `Challenge targets unknown claim ${cp.targetClaimId}. ` +
            `Known claim ids: ${allowed.claimIds.join(', ') || '(none)'}`,
        );
      }
    }

    const uniqueIds = [...new Set(bearEvidenceIds)];
    const existing = await this.readEvidence(allowed.executionId, uniqueIds);
    const existingIds = new Set(existing.map((e) => e.id));
    const allowedEvidence = new Set(allowed.evidenceIds);
    for (const id of uniqueIds) {
      if (!existingIds.has(id)) {
        throw new ValidationError(`Evidence ${id} does not exist in database (bear challenge)`);
      }
      if (!allowedEvidence.has(id)) {
        throw new ValidationError(
          `Evidence ${id} not in allowed set for this run (bear challenge). ` +
            `Allowed: ${allowed.evidenceIds.join(', ')}`,
        );
      }
    }
  }

  async validate(claims: Claim[], allowedEvidenceIds: string[], executionId: string): Promise<Claim[]> {
    // Layer 1: Structural validation (Zod)
    const parsed = ClaimSchema.array().parse(claims);

    // Layer 2: Evidence existence check (DB)
    const allEvidenceIds = [...new Set(parsed.flatMap((c) => c.evidenceIds))];
    const evidence = await this.readEvidence(executionId, allEvidenceIds);
    const existingIds = new Set(evidence.map((e) => e.id));
    const evidenceById = new Map(evidence.map((e) => [e.id, e]));

    for (const evidenceId of allEvidenceIds) {
      if (!existingIds.has(evidenceId)) {
        throw new ValidationError(`Evidence ${evidenceId} does not exist in database`);
      }
    }

    // Layer 3: Run membership check
    const allowed = new Set(allowedEvidenceIds);
    for (const claim of parsed) {
      for (const evidenceId of claim.evidenceIds) {
        if (!allowed.has(evidenceId)) {
          throw new ValidationError(
            `Evidence ${evidenceId} not in allowed set for this run. ` +
              `Allowed: ${allowedEvidenceIds.join(', ')}`,
          );
        }
      }
    }

    // Layer 4: Numeric grounding (P0.2) — angka di citedFigures harus cocok dengan evidence.data
    for (const claim of parsed) {
      for (const cf of claim.citedFigures ?? []) {
        const ev = evidenceById.get(cf.evidenceId);
        if (!ev) throw new ValidationError(`Claim ${claim.claimId}: evidence ${cf.evidenceId} tidak ada di DB`);
        const actual = getByPath(ev.data, cf.path);
        if (actual === undefined) {
          throw new ValidationError(`Claim ${claim.claimId}: path "${cf.path}" tidak ada di evidence ${cf.evidenceId} (period ${cf.periodLabel})`);
        }
        if (typeof actual === 'number' && typeof cf.value === 'number') {
          if (Math.abs(actual - cf.value) > NUMERIC_TOLERANCE) {
            throw new ValidationError(
              `Claim ${claim.claimId}: mengutip ${cf.value} untuk ${cf.path} (${cf.periodLabel}), evidence sebenarnya ${actual} — mismatch > ${NUMERIC_TOLERANCE}`,
            );
          }
        } else if (actual !== cf.value) {
          // Non-numeric: strict equality
          throw new ValidationError(`Claim ${claim.claimId}: value mismatch untuk ${cf.path}: klaim ${cf.value} vs evidence ${String(actual)}`);
        }
      }
    }

    // Layer 4b: Multi-Metric Reconciliation (P1.1) — anotasi deterministik
    // `singleMetric` saat claim hanya mengutip satu sisi dari pasangan metrik
    // yang tersedia (quarterly vs cumulativeYtd, distribution vs aggregate,
    // short vs long foreign window). Untuk deteksi short/long foreign window,
    // cakupan diperluas ke seluruh evidence foreign milik ticker yang sama
    // (sibling window yang TIDAK dikutip claim tetap terlihat) — cakupan ini
    // hanya dipakai untuk anotasi, tidak untuk layer validasi eksistensi/allowed
    // yang tetap ketat terhadap evidence yang di-cite.
    const reconcileScope = await this.reconcileScope(parsed, evidenceById, executionId);
    return detectSingleMetricFlags(parsed, reconcileScope);
  }

  /**
   * Bangun cakupan evidence untuk P1.1 reconciliation: map yang menggabungkan
   * evidence yang di-cite claim (strict) dengan seluruh evidence
   * `sectors.foreign_flow` milik ticker yang sama — sehingga sibling window
   * (mis. "30d" vs "90d") terlihat meski tidak dikutip claim tsb.
   */
  private async reconcileScope(
    claims: Claim[],
    claimedById: ReadonlyMap<string, Evidence>,
    executionId: string,
  ): Promise<Map<string, Evidence>> {
    const scope = new Map(claimedById);
    const tickers = new Set(claims.flatMap(c => c.evidenceIds).map(id => claimedById.get(id)?.ticker).filter((ticker): ticker is string => Boolean(ticker)));
    const rows = await this.evidenceStore.getByRun(executionId);
    for (const row of rows) {
      if (tickers.has(row.ticker) && row.source === 'sectors.foreign_flow' && !scope.has(row.id)) {
        scope.set(row.id, row);
      }
    }
    return scope;
  }

  /**
   * Invariant "yang dilihat = yang dicatat" (addendum §24-B.1) — assertion
   * **inklusi**, bukan equality: `evidenceIds` harus subset dari `seenIds`
   * (evidence block zona [1] yang benar-benar dikirim ke LLM pesan itu).
   * Melempar `ValidationError` (bukan log warning) — auditability adalah
   * jaminan, bukan niat.
   */
  assertSeenEvidence(evidenceIds: string[], seenIds: string[]): void {
    const seen = new Set(seenIds);
    for (const id of evidenceIds) {
      if (!seen.has(id)) {
        throw new ValidationError(
          `Evidence ${id} references data the agent never saw. ` +
            `Seen evidence ids: ${seenIds.join(', ') || '(none)'}`,
        );
      }
    }
  }
}
