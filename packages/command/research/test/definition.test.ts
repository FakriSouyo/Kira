import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createResearchCommandContext,
  createResearchWorkflow,
  RESEARCH_NODE_IDS,
  RESEARCH_SERVICES,
  RESEARCH_SUBAGENTS,
  type ResearchNodeExecutors,
} from '../src/index.js';

const executors = (log: string[]): ResearchNodeExecutors => Object.fromEntries(
  RESEARCH_NODE_IDS.map((nodeId) => [nodeId, async () => { log.push(nodeId); return nodeId; }]),
) as unknown as ResearchNodeExecutors;

describe('Research workflow definition', () => {
  it('declares the canonical sequential acquisition-to-report graph', () => {
    const definition = createResearchWorkflow();
    expect(definition.id).toBe('research');
    expect(definition.nodes.map((node) => node.id)).toEqual([
      'identify-company',
      'fetch-financials',
      'fetch-news',
      'fetch-filings',
      'collect-evidence',
      'synthesize-research',
      'ground-research',
      'build-report',
    ]);
    expect(definition.nodes).toHaveLength(8);
    expect(definition.nodes.map((node) => node.dependsOn ?? [])).toEqual([
      [],
      ['identify-company'],
      ['fetch-financials'],
      ['fetch-news'],
      ['fetch-filings'],
      ['collect-evidence'],
      ['synthesize-research'],
      ['ground-research'],
    ]);
    expect(definition.nodes.filter((node) => node.required === false).map((node) => node.id))
      .toEqual(['fetch-news', 'fetch-filings']);
  });

  it('declares exactly one subagent and binds every service node', () => {
    const nodes = createResearchWorkflow().nodes;
    expect(RESEARCH_SUBAGENTS).toEqual(['researcher']);
    expect(RESEARCH_SERVICES).toEqual([
      'financial-data', 'research-evidence', 'research-grounding', 'research-report',
    ]);
    expect(nodes.filter((node) => node.executor?.kind === 'subagent').map((node) => node.id))
      .toEqual(['synthesize-research']);
    expect(nodes.filter((node) => node.executor?.kind === 'service').map((node) => node.id))
      .toEqual(nodes.filter((node) => node.id !== 'synthesize-research').map((node) => node.id));
    expect(nodes.find((node) => node.id === 'synthesize-research')?.executor)
      .toEqual({ kind: 'subagent', id: 'researcher' });
  });

  it('runs every node through an exhaustive executor map', async () => {
    const log: string[] = [];
    const definition = createResearchWorkflow();
    const context = createResearchCommandContext({ executors: executors(log) });
    for (const node of definition.nodes) await node.run(context, {}, undefined);
    expect(log).toEqual([...RESEARCH_NODE_IDS]);
    expect(Object.keys(executors([]))).toEqual([...RESEARCH_NODE_IDS]);
  });

  it('keeps the command package free of Engine and infrastructure dependencies', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      '@harness/command-core',
      '@harness/subagent-researcher',
    ]);
    const sources = [
      readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/definition.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(sources).not.toMatch(/@harness\/(engine|database|financial-data|sectors-api)/);
    expect(sources).not.toMatch(/FinHarness|Finharness|FINHARNESS|HarnessContext/);
  });
});
