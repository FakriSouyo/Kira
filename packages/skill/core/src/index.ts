import { createHash } from 'node:crypto';

/** Fully loaded reusable instructions supplied to one specialist subagent. */
export interface LoadedSkill {
  name: string;
  description: string;
  content: string;
  contentHash: string;
  relativePath: string;
}

/** Provider-neutral lookup used by the subagent runtime. */
export interface SkillProvider {
  load(relativePath: string): Promise<LoadedSkill>;
}

export type SkillLoadErrorCode =
  | 'INVALID_SKILL_PATH'
  | 'SKILL_NOT_FOUND'
  | 'INVALID_SKILL_DOCUMENT';

/** Typed configuration failure raised before a model invocation begins. */
export class SkillLoadError extends Error {
  constructor(
    readonly code: SkillLoadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SkillLoadError';
  }
}

/** Hashes exact instruction bytes so a completed run can identify its skill version. */
export function hashSkillContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
