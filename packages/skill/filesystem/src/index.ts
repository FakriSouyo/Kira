import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  hashSkillContent,
  SkillLoadError,
  type LoadedSkill,
  type SkillProvider,
} from '@harness/skill-core';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function safePath(root: string, requested: string): { absolutePath: string; relativePath: string } {
  const absolutePath = resolve(root, requested);
  const fromRoot = relative(root, absolutePath);
  if (!requested || isAbsolute(requested) || fromRoot === '..' || fromRoot.startsWith(`..\\`) || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
    throw new SkillLoadError('INVALID_SKILL_PATH', `Skill path must remain inside its specialist package: ${requested}`);
  }
  return { absolutePath, relativePath: fromRoot.replaceAll('\\', '/') };
}

function parseSkillDocument(text: string, relativePath: string): Omit<LoadedSkill, 'contentHash' | 'relativePath'> {
  const normalized = text.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    throw new SkillLoadError('INVALID_SKILL_DOCUMENT', `${relativePath} must start with skill frontmatter`);
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    throw new SkillLoadError('INVALID_SKILL_DOCUMENT', `${relativePath} has unterminated skill frontmatter`);
  }
  const metadata = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new SkillLoadError('INVALID_SKILL_DOCUMENT', `${relativePath} contains invalid frontmatter`);
    }
    metadata.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = metadata.get('name') ?? '';
  const description = metadata.get('description') ?? '';
  const content = lines.slice(end + 1).join('\n');
  if (!SKILL_NAME.test(name) || !description || !content.trim()) {
    throw new SkillLoadError('INVALID_SKILL_DOCUMENT', `${relativePath} requires a valid name, description, and instruction body`);
  }
  return { name, description, content };
}

/** Loads mandatory specialist skills from one package-owned directory. */
export class FilesystemSkillProvider implements SkillProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async load(requestedPath: string): Promise<LoadedSkill> {
    const { absolutePath, relativePath } = safePath(this.root, requestedPath);
    let text: string;
    try {
      text = await readFile(absolutePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new SkillLoadError('SKILL_NOT_FOUND', `Mandatory skill not found: ${relativePath}`, { cause: error });
      }
      throw error;
    }
    const parsed = parseSkillDocument(text, relativePath);
    return {
      ...parsed,
      contentHash: hashSkillContent(parsed.content),
      relativePath,
    };
  }
}
