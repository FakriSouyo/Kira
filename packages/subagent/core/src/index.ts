import type { LLMCallMetadata, LLMClientLike } from '@harness/llm';
import {
  budgetSpecialistContext,
  createContextSnapshot,
  renderSpecialistContext,
  type ContextModelCapabilities,
  type ContextSnapshotStore,
  type SpecialistContextPacket,
} from '@harness/context';
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
  /** Actual metadata from the successful model-backed invocation. */
  modelCall: LLMCallMetadata;
  contextSnapshotId?: string | null;
}

/** Historical restore values may predate result-bearing model metadata. */
export type RestoredSubagentResult<T> = Omit<SubagentResult<T>, 'modelCall'> & { modelCall?: LLMCallMetadata };

export type SubagentResultLike<T> = SubagentResult<T> | RestoredSubagentResult<T>;

export interface RunObjectRequest<T> {
  manifest: SubagentManifest;
  /** Legacy zone for researcher and direct non-lifecycle callers. */
  evidenceZone?: string;
  /** Lifecycle `/judge` calls use a typed, immutable specialist packet. */
  specialistContext?: SpecialistContextPacket;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface SubagentRuntimeOptions {
  readonly contextSnapshotStore?: ContextSnapshotStore;
  readonly budget?: {
    readonly modelCapabilities: ContextModelCapabilities;
    readonly reservedOutputTokens: number;
    readonly safetyMarginTokens: number;
  };
}

function renderSkill(skill: LoadedSkill): string {
  return `<skill name="${skill.name}">\n${skill.content}</skill>`;
}

/** Resolves mandatory skills and invokes a pure specialist with stable prompt zones. */
export class SubagentRuntime {
  constructor(
    private readonly llm: LLMClientLike,
    private readonly skills: SkillProvider,
    private readonly options: SubagentRuntimeOptions = {},
  ) {}

  async runObject<T>(request: RunObjectRequest<T>): Promise<SubagentResult<T>> {
    const loadedSkills = await Promise.all(
      request.manifest.skills.map((path) => this.skills.load(path)),
    );
    const specialistZone = [
      request.manifest.persona,
      ...loadedSkills.map(renderSkill),
    ].join('\n\n');
    let evidenceZone = request.evidenceZone;
    let roleZone: string | undefined;
    let contextSnapshotId: string | null | undefined;
    if (request.specialistContext) {
      if (!this.options.budget) throw new Error('Specialist runtime requires context budget options');
      const budgeted = budgetSpecialistContext({
        context: request.specialistContext,
        modelCapabilities: this.options.budget.modelCapabilities,
        basePrompt: specialistZone,
        currentUserMessage: request.prompt,
        reservedOutputTokens: this.options.budget.reservedOutputTokens,
        safetyMarginTokens: this.options.budget.safetyMarginTokens,
      });
      const rendered = renderSpecialistContext(budgeted.finalPacket);
      evidenceZone = rendered.evidenceZone;
      roleZone = rendered.roleZone;
      if (this.options.contextSnapshotStore) {
        const snapshot = createContextSnapshot({
          sessionId: budgeted.finalPacket.sessionId,
          turnId: budgeted.finalPacket.turnId,
          packet: budgeted.finalPacket,
        });
        const stored = await this.options.contextSnapshotStore.save(snapshot);
        contextSnapshotId = stored.snapshotId;
      } else {
        contextSnapshotId = null;
      }
    }
    if (evidenceZone === undefined) throw new Error('Subagent runtime requires evidenceZone or specialistContext');
    const params = {
      schema: request.schema,
      prompt: request.prompt,
      system: [evidenceZone, roleZone ? `${roleZone}\n\n${specialistZone}` : specialistZone],
    };
    const generated = await this.llm.generateObjectResult(params);
    return {
      value: request.schema.parse(generated.value),
      subagent: request.manifest.id,
      skills: loadedSkills.map(({ name, contentHash }) => ({ name, contentHash })),
      modelCall: generated.metadata,
      ...(request.specialistContext ? { contextSnapshotId } : {}),
    };
  }
}
