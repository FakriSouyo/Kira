import { describe, expect, it } from 'vitest';
import { MockLLMClient, type LLMClientLike } from '@harness/llm';
import { SubagentRuntime } from '@harness/subagent-core';
import { ChallengeAnalystOutputSchema, ChallengerAgent } from '../src/index.js';

const evidenceId = '11111111-1111-4111-8111-111111111111';
const modelCall = {
  provider: 'mock' as const,
  model: 'challenger-test',
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: null,
  totalTokens: 2,
  finishReason: 'stop',
  latencyMs: 1,
};

class FixedSkills {
  async load(relativePath: string) {
    expect(relativePath).toContain('SKILL.md');
    const name = relativePath.includes('source-quality') ? 'source-quality' : 'thesis-challenge';
    return {
      name,
      description: 'Challenge claims without deciding them.',
      content: 'Separate evidence from assumptions.\n',
      contentHash: `hash-${name}`,
      relativePath,
    };
  }
}

function analystOutput() {
  return {
    thesis: 'BBCA can sustain its current profitability.',
    summary: 'Profitability has support, while resilience remains an assumption.',
    supportingCase: [{
      statement: 'ROE is 22.4%.',
      evidenceIds: [evidenceId],
      confidence: 'high' as const,
      citedFigures: [{ evidenceId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' }],
    }],
    counterCase: [],
    unsupportedAssumptions: ['Margins remain resilient.'],
    failureConditions: ['Persistent margin pressure would weaken the thesis.'],
    evidenceThatWouldChangeThesis: ['A later report showing margin compression.'],
    sourceAssessments: [{ evidenceId, quality: 'primary' as const, rationale: 'Issuer report.' }],
    gaps: ['No later reporting period was supplied.'],
    coverage: [{ source: 'sectors.company_report', evidenceIds: [evidenceId] }],
  };
}

describe('ChallengerAgent', () => {
  it('keeps metric, unit, and currency interpretation out of the analyst schema', () => {
    const output = analystOutput();
    const figure = output.supportingCase[0]!.citedFigures![0]! as unknown as Record<string, unknown>;
    figure.metric = 'roe';
    expect(ChallengeAnalystOutputSchema.safeParse(output).success).toBe(false);
  });

  it('requires a nonempty combination of supporting and counter findings', () => {
    const output = analystOutput();
    output.supportingCase = [];
    expect(ChallengeAnalystOutputSchema.safeParse(output).success).toBe(false);
  });

  it('receives an explicit thesis and immutable Evidence zone and returns an auditable specialist result', async () => {
    const systems: Array<string | string[] | undefined> = [];
    const prompts: string[] = [];
    const llm = {
      async generateObjectResult(params) {
        systems.push(params.system);
        prompts.push(params.prompt);
        return {
          value: params.schema.parse(analystOutput()),
          metadata: modelCall,
        };
      },
    } as LLMClientLike;
    const agent = new ChallengerAgent(new SubagentRuntime(llm, new FixedSkills() as never));

    const result = await agent.challenge({
      ticker: 'BBCA',
      thesis: 'BBCA can sustain its current profitability.',
      evidenceZone: 'IMMUTABLE EVIDENCE ZONE',
    });

    expect(systems[0]).toEqual([
      'IMMUTABLE EVIDENCE ZONE',
      expect.stringContaining('Challenge Analyst Agent'),
    ]);
    expect(prompts[0]).toContain('BBCA');
    expect(prompts[0]).toContain('BBCA can sustain its current profitability.');
    expect(result).toMatchObject({
      value: { thesis: 'BBCA can sustain its current profitability.' },
      subagent: 'challenger',
      skills: [
        { name: 'thesis-challenge', contentHash: 'hash-thesis-challenge' },
        { name: 'source-quality', contentHash: 'hash-source-quality' },
      ],
      modelCall,
    });
  });

  it('provides a deterministic offline response through the Challenge Analyst marker', async () => {
    const output = await new MockLLMClient().generateObject({
      schema: (await import('../src/schema.js')).ChallengeAnalystOutputSchema,
      system: [
        'EVIDENCE BLOCK\n- Evidence ID: 11111111-1111-4111-8111-111111111111\n  Source: sectors.company_report\n  Data: {"ticker":"BBCA","asOf":"2025-12-31","financials":{"roe":22.4},"valuation":{}}',
        'You are the Challenge Analyst Agent.',
      ],
      prompt: 'Challenge target: BBCA\nExplicit thesis: BBCA can sustain profitability.',
    });
    expect(output).toMatchObject({
      thesis: 'BBCA can sustain profitability.',
      sourceAssessments: [{ evidenceId, quality: 'primary' }],
      coverage: [{ source: 'sectors.company_report', evidenceIds: [evidenceId] }],
    });
  });
});
