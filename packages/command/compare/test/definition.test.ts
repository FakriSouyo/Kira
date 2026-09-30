import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPARE_NODE_IDS,
  COMPARE_SERVICES,
  createCompareCommandContext,
  createCompareWorkflow,
  type CompareNodeExecutors,
} from '../src/index.js';

const executors = (log: string[]): CompareNodeExecutors => Object.fromEntries(
  COMPARE_NODE_IDS.map((nodeId) => [nodeId, async () => { log.push(nodeId); return nodeId; }]),
) as unknown as CompareNodeExecutors;

describe('Compare workflow definition', () => {
  it('declares the required sequential acquisition-to-report graph', () => {
    const definition = createCompareWorkflow();
    expect(definition.id).toBe('compare');
    expect(definition.nodes.map((node) => node.id)).toEqual([
      'identify-subjects',
      'fetch-financials',
      'collect-evidence',
      'normalize-comparison',
      'build-report',
    ]);
    expect(definition.nodes.map((node) => node.dependsOn ?? [])).toEqual([
      [],
      ['identify-subjects'],
      ['fetch-financials'],
      ['collect-evidence'],
      ['normalize-comparison'],
    ]);
    expect(definition.nodes.every((node) => node.required !== false)).toBe(true);
    expect(definition.nodes.map((node) => node.executor)).toEqual([
      { kind: 'service', id: 'financial-data' },
      { kind: 'service', id: 'financial-data' },
      { kind: 'service', id: 'comparison-evidence' },
      { kind: 'service', id: 'comparison-normalization' },
      { kind: 'service', id: 'comparison-report' },
    ]);
    expect(definition.nodes.some((node) => node.executor?.kind === 'subagent')).toBe(false);
  });

  it('dispatches every node through the exhaustive executor map and forwards cancellation', async () => {
    const log: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const boundExecutors = Object.fromEntries(COMPARE_NODE_IDS.map((nodeId) => [nodeId, async (
      _inputs: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ) => {
      log.push(nodeId);
      signals.push(signal);
      return nodeId;
    }])) as unknown as CompareNodeExecutors;
    const context = createCompareCommandContext({ executors: boundExecutors });
    const definition = createCompareWorkflow();
    for (const node of definition.nodes) await node.run(context, {}, controller.signal);
    expect(log).toEqual([...COMPARE_NODE_IDS]);
    expect(Object.keys(executors([]))).toEqual([...COMPARE_NODE_IDS]);
    expect(signals).toEqual(COMPARE_NODE_IDS.map(() => controller.signal));
    expect(COMPARE_SERVICES).toEqual([
      'financial-data', 'comparison-evidence', 'comparison-normalization', 'comparison-report',
    ]);
  });

  it('keeps the command package dependent only on command-core', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies)).toEqual(['@harness/command-core']);
    const sources = [
      readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/definition.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(sources).not.toMatch(/@harness\/(engine|database|financial-data|sectors-api|session-core)/);
    expect(sources).not.toMatch(/FinHarness|Finharness|FINHARNESS|HarnessContext/);
  });
});
