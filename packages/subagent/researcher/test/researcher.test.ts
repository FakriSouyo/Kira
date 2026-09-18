import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { GenerateObjectParams, LLMClientLike } from '@harness/llm';
import { FilesystemSkillProvider } from '@harness/skill-filesystem';
import { SubagentRuntime } from '@harness/subagent-core';
import {
  RESEARCHER_MANIFEST,
  ResearcherAgent,
  ResearcherOutputSchema,
} from '../src/index.js';

const evidenceId = '11111111-1111-4111-8111-111111111111';

describe('ResearcherAgent', () => {
  it('owns only source-research and source-quality skills', () => {
    expect(RESEARCHER_MANIFEST).toMatchObject({
      id: 'researcher',
      displayName: 'Researcher',
      skills: [
        'skills/source-research/SKILL.md',
        'skills/source-quality/SKILL.md',
      ],
    });
  });

  it('returns cited findings, source assessments, gaps, skill hashes, and model usage', async () => {
    let captured: GenerateObjectParams<unknown> | undefined;
    const llm = {
      async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
        captured = params as GenerateObjectParams<unknown>;
        return params.schema.parse({
          summary: 'Revenue expanded, but one primary filing is still missing.',
          findings: [{
            claim: 'Reported revenue increased year over year.',
            evidenceIds: [evidenceId],
            confidence: 'high',
          }],
          sourceAssessments: [{
            evidenceId,
            quality: 'primary',
            rationale: 'Audited issuer filing.',
          }],
          gaps: ['Latest annual filing is unavailable.'],
        });
      },
      async generateObjectResult<T>(params: GenerateObjectParams<T>) {
        return {
          value: await this.generateObject(params),
          metadata: {
            provider: 'openai' as const,
            model: 'research-model',
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            latencyMs: 250,
          },
        };
      },
    } as LLMClientLike;
    const skills = new FilesystemSkillProvider(fileURLToPath(new URL('..', import.meta.url)));
    const agent = new ResearcherAgent(new SubagentRuntime(llm, skills));

    const result = await agent.research({
      ticker: 'BBCA',
      question: 'Assess revenue quality.',
      evidenceZone: 'STABLE EVIDENCE',
    });

    expect(captured?.system).toEqual([
      'STABLE EVIDENCE',
      expect.stringContaining('<skill name="source-research">'),
    ]);
    expect(captured?.system?.[1]).toContain('<skill name="source-quality">');
    expect(result.value.findings[0]?.evidenceIds).toEqual([evidenceId]);
    expect(result.skills).toHaveLength(2);
    expect(result.modelCall).toMatchObject({ model: 'research-model', totalTokens: 140 });
  });

  it('rejects uncited findings at the specialist boundary', () => {
    expect(() => ResearcherOutputSchema.parse({
      summary: 'Unsupported claim.',
      findings: [{ claim: 'Revenue grew.', evidenceIds: [], confidence: 'high' }],
      sourceAssessments: [],
      gaps: [],
    })).toThrow();
  });
});
