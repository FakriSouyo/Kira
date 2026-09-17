import type { LLMCallMetadata, LLMClientLike } from '@harness/llm';
import type { LoadedSkill, SkillProvider } from '@harness/skill-core';
import type { z } from 'zod';

/** Static specialist composition; command packages select manifests explicitly. */
export interface SubagentManifest {
  id: string;
  displayName: string;
  persona: string;
  skills: string[];
}

export interface SkillReference {
  name: string;
  contentHash: string;
}

export interface SubagentResult<T> {
  value: T;
  subagent: string;
  skills: SkillReference[];
  modelCall?: LLMCallMetadata;
}

export interface RunObjectRequest<T> {
  manifest: SubagentManifest;
  evidenceZone: string;
  prompt: string;
  schema: z.ZodType<T>;
}

function renderSkill(skill: LoadedSkill): string {
  return `<skill name="${skill.name}">\n${skill.content}</skill>`;
}

/** Resolves mandatory skills and invokes a pure specialist with stable prompt zones. */
export class SubagentRuntime {
  constructor(
    private readonly llm: LLMClientLike,
    private readonly skills: SkillProvider,
  ) {}

  async runObject<T>(request: RunObjectRequest<T>): Promise<SubagentResult<T>> {
    const loadedSkills = await Promise.all(
      request.manifest.skills.map((path) => this.skills.load(path)),
    );
    const specialistZone = [
      request.manifest.persona,
      ...loadedSkills.map(renderSkill),
    ].join('\n\n');
    const params = {
      schema: request.schema,
      prompt: request.prompt,
      system: [request.evidenceZone, specialistZone],
    };
    const generated = this.llm.generateObjectResult
      ? await this.llm.generateObjectResult(params)
      : { value: await this.llm.generateObject(params) };
    return {
      value: request.schema.parse(generated.value),
      subagent: request.manifest.id,
      skills: loadedSkills.map(({ name, contentHash }) => ({ name, contentHash })),
      ...('metadata' in generated ? { modelCall: generated.metadata } : {}),
    };
  }
}
