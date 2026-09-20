import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';

let db: FinharnessDatabase;
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'finharness-cli-selection-'));
  writeFileSync(join(homeDir, 'config.json'), JSON.stringify({
    llm: { agent: { provider: 'openai', model: 'configured-model' }, router: { provider: 'openai', model: 'router-model' } },
  }));
  db = openDb({ homeDir });
});

afterEach(() => {
  if (db.raw.open) db.raw.close();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('session-local model selection', () => {
  it('persists selection without modifying global config.json', async () => {
    const before = readFileSync(join(homeDir, 'config.json'), 'utf8');
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));

    await session.setModel('session-only-model');

    expect(readFileSync(join(homeDir, 'config.json'), 'utf8')).toBe(before);
    expect(await db.sessions.getCurrentModelSelection(session.conversation.id)).toMatchObject({
      providerId: 'openai', modelId: 'session-only-model', source: 'user', version: 2,
    });
    await session.close();
  });

  it('seeds /new from the global default instead of the previous Session selection', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));
    const firstSessionId = session.conversation.id;
    await session.setModel('session-only-model');

    await session.commands.get('new')!([], { input: '/new' });

    expect(session.conversation.id).not.toBe(firstSessionId);
    expect(await db.sessions.getCurrentModelSelection(firstSessionId)).toMatchObject({ version: 2, modelId: 'session-only-model', source: 'user' });
    expect(await db.sessions.getCurrentModelSelection(session.conversation.id)).toMatchObject({ version: 1, providerId: 'openai', modelId: 'configured-model', source: 'initial' });
    await session.close();
  });
});
