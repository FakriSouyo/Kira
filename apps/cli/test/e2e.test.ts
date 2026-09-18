import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const CLI_ENTRY = join(ROOT, 'apps/cli/src/index.ts');
const TSX_CLI = join(ROOT, 'node_modules/tsx/dist/cli.mjs');

const CLI_TIMEOUT_MS = 90_000;
const homes: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'finharness-e2e-'));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(homeDir: string, input: string): Promise<CliRun> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, '--mock-sectors', '--mock-llm', '--home', homeDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out after ${CLI_TIMEOUT_MS}ms. stdout: ${stdout.slice(-500)}`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function openHomeDb(homeDir: string): FinharnessDatabase {
  return openDb({ homeDir });
}

describe('E2E — /judge offline (mock sectors + mock LLM)', () => {
  it('menjalankan flow penuh dengan Debate ronde dan menyimpan state DB lengkap', async () => {
    const home = freshHome();
    const run = await runCli(home, '/judge BBCA\n/exit\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('FINANCIAL AGENT HARNESS');
    expect(run.stdout).toContain('🔍 RESEARCHER');
    expect(run.stdout).toContain('🐂 BULL AGENT');
    expect(run.stdout).toContain('🐻 BEAR AGENT');
    expect(run.stdout).toContain('🐂 BULL AGENT — REBUTTAL');
    expect(run.stdout).toContain('⚖️ JUDGE');
    expect(run.stdout).toContain('BBCA · FINAL JUDGMENT');
    expect(run.stdout).toMatch(/Score\s+\d+ \/ 100/);
    expect(run.stdout).toMatch(/Run ID\s+run_/);
    // Evidence ter-ground: ticker dalam output, bukan placeholder
    expect(run.stdout).toContain('BBCA');

    const db = openHomeDb(home);
    try {
      const executions = db.raw.prepare('SELECT * FROM executions').all() as Array<{
        ticker: string;
        command: string;
        status: string;
        execution_time: number | null;
      }>;
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({ ticker: 'BBCA', command: 'judge', status: 'completed' });
      expect(executions[0].execution_time).toBeGreaterThan(0);

      const evidence = db.raw.prepare('SELECT id, source FROM evidence').all() as Array<{ id: string; source: string }>;
      expect(evidence).toHaveLength(7);
      const sources = evidence.map((e) => e.source).sort();
      expect(sources).toEqual([
        'sectors.company_report',
        'sectors.daily_transaction',
        'sectors.filings',
        'sectors.foreign_flow',
        'sectors.news',
        'sectors.quarterly_financials',
        'sectors.sentiment',
      ]);

      const messages = db.raw
        .prepare('SELECT agent, message_type FROM agent_messages ORDER BY sequence_order')
        .all() as Array<{ agent: string; message_type: string }>;
      expect(messages).toEqual([
        { agent: 'researcher', message_type: 'observation' },
        { agent: 'bull', message_type: 'claim' },
        { agent: 'bear', message_type: 'challenge' },
        { agent: 'bull', message_type: 'response' },
        { agent: 'judge', message_type: 'decision' },
      ]);

      // Bear challenge berisi counterpoint terstruktur yang menarget klaim Bull
      const bearMessage = db.raw
        .prepare("SELECT content FROM agent_messages WHERE agent = 'bear' AND message_type = 'challenge'")
        .get() as { content: string };
      expect(bearMessage.content).toContain('Challenge #1 (targets claim ');
      expect(bearMessage.content).toContain('claim_1');

      // Integrity: evidenceIds claim ⊆ evidence milik run (anti-hallucination, addendum §16)
      const evidenceIds = new Set(evidence.map((e) => e.id));
      const claims = db.raw
        .prepare('SELECT claim_id, evidence_ids FROM claims')
        .all() as Array<{ claim_id: string; evidence_ids: string }>;
      // 2 klaim Bull + klaim rebuttal (id dinormalisasi rebuttal_N)
      expect(claims.length).toBeGreaterThanOrEqual(3);
      const claimIds = new Set(claims.map((c) => c.claim_id));
      expect(claimIds.has('claim_1')).toBe(true);
      expect([...claimIds].some((id) => id.startsWith('rebuttal_'))).toBe(true);
      for (const claim of claims) {
        for (const id of JSON.parse(claim.evidence_ids) as string[]) {
          expect(evidenceIds.has(id)).toBe(true);
        }
      }

      const judgments = db.raw
        .prepare('SELECT score, stance, breakdown FROM judgments')
        .all() as Array<{ score: number; stance: string; breakdown: string }>;
      expect(judgments).toHaveLength(1);
      expect(judgments[0].score).toBeGreaterThanOrEqual(0);
      expect(judgments[0].score).toBeLessThanOrEqual(100);
      const breakdown = JSON.parse(judgments[0].breakdown) as Record<string, unknown>;
      // Market & News tersedia (mock) → momentum & risk non-null (addendum §24-A.5)
      expect(typeof breakdown.marketMomentum).toBe('number');
      expect(typeof breakdown.risk).toBe('number');
      // Skor konsisten dengan breakdown (renormalisasi atas 100 — 5 kategori penuh)
      const expected = Math.round(
        ((breakdown.financialHealth as number) * 25 +
          (breakdown.growth as number) * 20 +
          (breakdown.valuation as number) * 20 +
          (breakdown.marketMomentum as number) * 20 +
          (breakdown.risk as number) * 15) /
          100,
      );
      expect(judgments[0].score).toBe(expected);

      // Invariant §24-B.1: bull/bear/rebuttal mencatat seenEvidenceIds = evidence yang dilihat
      const seen = db.raw
        .prepare("SELECT agent, metadata FROM agent_messages WHERE agent IN ('bull','bear') ORDER BY sequence_order")
        .all() as Array<{ agent: string; metadata: string | null }>;
      for (const row of seen) {
        const meta = JSON.parse(row.metadata ?? '{}') as { seenEvidenceIds?: string[] };
        expect(Array.isArray(meta.seenEvidenceIds)).toBe(true);
        expect(meta.seenEvidenceIds!.length).toBeGreaterThanOrEqual(7);
      }
    } finally {
      db.raw.close();
    }
  }, CLI_TIMEOUT_MS);

  it('ticker tidak ditemukan → error ramah user + run gagal di DB', async () => {
    const home = freshHome();
    const run = await runCli(home, '/judge ZZZZ\n/exit\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('NOT_FOUND');
    expect(run.stdout).toContain('Suggestion:');

    const db = openHomeDb(home);
    try {
      const executions = db.raw.prepare('SELECT status, error FROM executions').all() as Array<{ status: string; error: string }>;
      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('failed');
      expect(executions[0].error).toContain('ZZZZ');
      const evidenceCount = (db.raw.prepare('SELECT COUNT(*) c FROM evidence').get() as { c: number }).c;
      expect(evidenceCount).toBe(0);
    } finally {
      db.raw.close();
    }
  }, CLI_TIMEOUT_MS);
});

describe('E2E — natural language → MainFinHarnessAgent', () => {
  it('does not auto-route a company question into /judge', async () => {
    const home = freshHome();
    const run = await runCli(home, 'Apakah BBRI layak dibeli?\n/exit\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Apakah BBRI layak dibeli?');
    expect(run.stdout).not.toContain('Routing to /judge BBRI');
    expect(run.stdout).not.toContain('FINAL JUDGMENT');

    const db = openHomeDb(home);
    try {
      const executions = (db.raw.prepare('SELECT COUNT(*) c FROM executions').get() as { c: number }).c;
      expect(executions).toBe(0);
    } finally {
      db.raw.close();
    }
  }, CLI_TIMEOUT_MS);

  it('keeps an ambiguous context-free message in normal conversation', async () => {
    const home = freshHome();
    const run = await runCli(home, 'hmm interesting\n/exit\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('hmm interesting');
    expect(run.stdout).not.toContain('FINAL JUDGMENT');

    const db = openHomeDb(home);
    try {
      const executions = (db.raw.prepare('SELECT COUNT(*) c FROM executions').get() as { c: number }).c;
      expect(executions).toBe(0);
    } finally {
      db.raw.close();
    }
  }, CLI_TIMEOUT_MS);
});

describe('E2E — /screen dan command lainnya', () => {
  it('/screen profitable growing meranking mock universe', async () => {
    const home = freshHome();
    const run = await runCli(home, '/screen profitable growing\n/exit\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Screening stocks: profitable + growing');
    expect(run.stdout).toContain('BBCA (100/100)');
    expect(run.stdout).toContain('BBRI');
    expect(run.stdout).toContain('Historical patterns, not predictions');
  }, CLI_TIMEOUT_MS);

  it('/help, stub roadmap, dan /exit', async () => {
    const home = freshHome();
    const run = await runCli(home, '/help\n/challenge BBCA overvalued?\n/unknown\n/exit\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('/judge [TICKER]');
    expect(run.stdout).toContain('/auth-set KEY=VALUE');
    expect(run.stdout).toContain('/challenge is in active development');
    expect(run.stdout).toContain('Unknown command: /unknown');
    expect(run.stdout).toContain('Goodbye');
  }, CLI_TIMEOUT_MS);

  it('/auth-set menulis kredensial ke .credentials.json tanpa API key/network', async () => {
    const home = freshHome();
    const run = await runCli(home, '/auth-set SECTORS=sk-e2e LLM.AGENT=sk-agent-e2e\n/exit\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Credentials saved to');
    const json = JSON.parse(readFileSync(join(home, '.credentials.json'), 'utf8')) as {
      sectors_api: { key: string };
      llm: { agent: { api_key: string } };
    };
    expect(json.sectors_api.key).toBe('sk-e2e');
    expect(json.llm.agent.api_key).toBe('sk-agent-e2e');
  }, CLI_TIMEOUT_MS);
});
