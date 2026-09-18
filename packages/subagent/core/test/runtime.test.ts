import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GenerateObjectParams, LLMClientLike, LLMResult } from '@harness/llm';
import type { LoadedSkill, SkillProvider } from '@harness/skill-core';
import { assembleSpecialistContext, renderSpecialistContext, type ContextSnapshot } from '@harness/context';
import type { Evidence } from '@harness/schemas';
import { SubagentRuntime, type SubagentManifest } from '../src/index.js';

const skill: LoadedSkill = {
  name: 'source-quality',
  description: 'Assess source reliability.',
  content: 'Prefer primary, recent, attributable evidence.\n',
  contentHash: 'hash-source-quality',
  relativePath: 'skills/source-quality/SKILL.md',
};

class FixedSkillProvider implements SkillProvider {
  async load(relativePath: string): Promise<LoadedSkill> {
    expect(relativePath).toBe(skill.relativePath);
    return skill;
  }
}

function manifest(persona: string): SubagentManifest {
  return {
    id: 'researcher',
    displayName: 'Researcher',
    persona,
    skills: [skill.relativePath],
  };
}

describe('SubagentRuntime', () => {
  it('keeps evidence in cache zone one and injects persona plus mandatory skills into zone two', async () => {
    let capturedSystem: string | string[] | undefined;
    const llm = {
      async generateObject(params) {
        capturedSystem = params.system;
        return { summary: 'Primary source verified' };
      },
    } as LLMClientLike;
    const runtime = new SubagentRuntime(llm, new FixedSkillProvider());

    const result = await runtime.runObject({
      manifest: manifest('You are the Researcher Agent.'),
      evidenceZone: 'STABLE EVIDENCE BLOCK',
      prompt: 'Inspect the sources.',
      schema: z.object({ summary: z.string() }),
    });

    expect(capturedSystem).toEqual([
      'STABLE EVIDENCE BLOCK',
      'You are the Researcher Agent.\n\n<skill name="source-quality">\nPrefer primary, recent, attributable evidence.\n</skill>',
    ]);
    expect(result).toEqual({
      value: { summary: 'Primary source verified' },
      subagent: 'researcher',
      skills: [{ name: 'source-quality', contentHash: 'hash-source-quality' }],
    });
  });

  it('does not let different specialist personas alter the shared evidence zone', async () => {
    const systems: Array<string | string[]> = [];
    const llm = {
      async generateObject(params) {
        systems.push(params.system ?? '');
        return { summary: 'ok' };
      },
    } as LLMClientLike;
    const runtime = new SubagentRuntime(llm, new FixedSkillProvider());
    const request = {
      evidenceZone: 'BYTE-IDENTICAL',
      prompt: 'Analyze.',
      schema: z.object({ summary: z.string() }),
    };

    await runtime.runObject({ ...request, manifest: manifest('Research persona') });
    await runtime.runObject({ ...request, manifest: manifest('Risk persona') });

    expect(systems.map((system) => Array.isArray(system) ? system[0] : system)).toEqual([
      'BYTE-IDENTICAL',
      'BYTE-IDENTICAL',
    ]);
  });

  it('propagates model-call metadata for durable usage accounting', async () => {
    const llm: LLMClientLike = {
      async generateObject<T>(): Promise<T> {
        throw new Error('value-only API must not be used when metadata is available');
      },
      async generateObjectResult<T>(params: GenerateObjectParams<T>): Promise<LLMResult<T>> {
        return {
          value: params.schema.parse({ summary: 'audited' }),
          metadata: {
            provider: 'openai' as const,
            model: 'usage-model',
            inputTokens: 25,
            outputTokens: 8,
            cachedInputTokens: 10,
            totalTokens: 33,
            finishReason: 'stop',
            latencyMs: 120,
          },
        };
      },
      async streamObject<T>(): Promise<T> { throw new Error('unexpected streamObject'); },
      async generateText(): Promise<string> { throw new Error('unexpected generateText'); },
      streamText(): AsyncIterable<string> { throw new Error('unexpected streamText'); },
    };

    const result = await new SubagentRuntime(llm, new FixedSkillProvider()).runObject({
      manifest: manifest('Research persona'),
      evidenceZone: 'EVIDENCE',
      prompt: 'Analyze.',
      schema: z.object({ summary: z.string() }),
    });

    expect(result.modelCall).toEqual(expect.objectContaining({ model: 'usage-model', totalTokens: 33 }));
  });

  it('budgets and snapshots specialist context before a mock model call with truthful null usage', async () => {
    const evidence: Evidence[] = [{
      id: '11111111-1111-4111-8111-111111111111', runId: 'execution-1', ticker: 'BBCA', source: 'sectors.company_report',
      sourceType: 'api', contentHash: 'hash-a', retrievedAt: '2026-09-18T00:00:00.000Z', data: { financials: { roe: 18.4 } },
    }];
    const context = assembleSpecialistContext({
      sessionId: 'session-1', turnId: 'turn-1', executionId: 'execution-1', ticker: 'BBCA', roundNumber: 1,
      evidence, role: 'BULL', phase: 'THESIS',
    });
    const rendered = renderSpecialistContext(context);
    const order: string[] = [];
    const snapshots: ContextSnapshot[] = [];
    let capturedSystem: string | string[] | undefined;
    const llm = {
      async generateObject(params) {
        order.push('model');
        capturedSystem = params.system;
        return { summary: 'specialist complete' };
      },
    } as LLMClientLike;
    const runtime = new SubagentRuntime(llm, new FixedSkillProvider(), {
      contextSnapshotStore: {
        async save(snapshot) { order.push('snapshot'); snapshots.push(snapshot); return snapshot; },
        async getById() { return snapshots[0] ?? null; },
      },
      budget: { modelCapabilities: { contextWindowTokens: 8192 }, reservedOutputTokens: 128, safetyMarginTokens: 32 },
      modelIdentity: { provider: 'mock', model: 'mock-specialist' },
    });

    const result = await runtime.runObject({
      manifest: manifest('You are the Bull Agent.'), specialistContext: context, prompt: 'Analyze.',
      schema: z.object({ summary: z.string() }),
    });

    expect(order).toEqual(['snapshot', 'model']);
    expect(snapshots).toHaveLength(1);
    expect(capturedSystem).toEqual([
      rendered.evidenceZone,
      expect.stringContaining(rendered.roleZone),
    ]);
    expect(result.contextSnapshotId).toBe(snapshots[0]!.snapshotId);
    expect(result.modelCall).toEqual(expect.objectContaining({
      provider: 'mock', model: 'mock-specialist', inputTokens: null, outputTokens: null, totalTokens: null,
    }));
  });
});
