import { readFileSync, writeFileSync } from 'node:fs';

/** Snapshot terekam untuk replay keyless (Phase 2 Task 5 · §24-B.2). */
export interface ReplaySnapshot {
  ticker: string;
  judgment: {
    score: number;
    stance: string;
    confidence: string;
    breakdown: Record<string, number | null>;
  };
  messages: Array<{ sequenceOrder: number; agent: string }>;
  createdAt?: string;
}

/** Muat fixture JSONL (satu baris JSON per file). */
export function loadFixture(path: string): ReplaySnapshot {
  const raw = readFileSync(path, 'utf8').trim();
  // dukung JSON tunggal atau JSONL (ambil baris pertama non-kosong)
  const line = raw.split('\n').find((l) => l.trim().length > 0) ?? raw;
  return JSON.parse(line) as ReplaySnapshot;
}

/** Simpan snapshot ke fixture (record). */
export function saveFixture(path: string, snapshot: ReplaySnapshot): void {
  writeFileSync(path, JSON.stringify(snapshot) + '\n', 'utf8');
}

/** Bandingkan actual vs expected snapshot — kembalikan true bila cocok. */
export function compareSnapshot(actual: ReplaySnapshot, expected: ReplaySnapshot): { ok: boolean; diffs: string[] } {
  const diffs: string[] = [];
  if (actual.ticker !== expected.ticker) diffs.push(`ticker: ${actual.ticker} != ${expected.ticker}`);
  if (actual.judgment.score !== expected.judgment.score) diffs.push(`judgment.score: ${actual.judgment.score} != ${expected.judgment.score}`);
  if (actual.judgment.stance !== expected.judgment.stance) diffs.push(`judgment.stance: ${actual.judgment.stance} != ${expected.judgment.stance}`);
  const actualSeq = actual.messages.map((m) => m.sequenceOrder);
  const expectedSeq = expected.messages.map((m) => m.sequenceOrder);
  if (JSON.stringify(actualSeq) !== JSON.stringify(expectedSeq)) diffs.push(`sequenceOrder: ${JSON.stringify(actualSeq)} != ${JSON.stringify(expectedSeq)}`);
  return { ok: diffs.length === 0, diffs };
}
