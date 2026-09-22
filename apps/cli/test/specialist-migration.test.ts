import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '@harness/database';
import { loadConfig } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('/judge specialist migration', () => {
  it('returns package-owned skill hashes for Bull, Bear, and Judge calls', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'finharness-specialist-migration-'));
    homes.push(homeDir);
    const db = openDb({ homeDir });
    try {
      const context = buildContext(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { sessionId: 'specialist-migration-test-session' });
      const result = await judgeWorkflow(context, 'BBCA');
      expect(result.subagentAudit.bull.map((skill) => skill.name)).toEqual(['evidence-backed-thesis']);
      expect(result.subagentAudit.bear.map((skill) => skill.name)).toEqual(['adversarial-challenge']);
      expect(result.subagentAudit.judge.map((skill) => skill.name)).toEqual(['evidence-weighing']);
      expect(result.subagentAudit.bull[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.raw.close();
    }
  });
});
