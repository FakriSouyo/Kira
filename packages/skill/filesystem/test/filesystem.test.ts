import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemSkillProvider } from '../src/index.js';

function createSkill(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

describe('FilesystemSkillProvider', () => {
  it('loads a manifest-declared skill with stable metadata and content hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finharness-skill-'));
    createSkill(root, 'source-research/SKILL.md', [
      '---',
      'name: source-research',
      'description: Find primary financial sources.',
      '---',
      'Prefer filings and issuer disclosures.',
      '',
    ].join('\n'));

    const provider = new FilesystemSkillProvider(root);
    const loaded = await provider.load('source-research/SKILL.md');

    expect(loaded).toEqual({
      name: 'source-research',
      description: 'Find primary financial sources.',
      content: 'Prefer filings and issuer disclosures.\n',
      contentHash: 'a744e9ab6490fa6604ae5e0a51518e731937b0c58221ab9bd9c579b4292198b4',
      relativePath: 'source-research/SKILL.md',
    });
  });

  it('fails before invocation when a mandatory skill is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finharness-skill-'));
    const provider = new FilesystemSkillProvider(root);

    await expect(provider.load('missing/SKILL.md')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
  });

  it('rejects a manifest path that escapes the specialist package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finharness-skill-'));
    const provider = new FilesystemSkillProvider(root);

    await expect(provider.load('../secret.md')).rejects.toMatchObject({
      code: 'INVALID_SKILL_PATH',
    });
  });
});
