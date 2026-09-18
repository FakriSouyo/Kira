import { describe, expect, it } from 'vitest';
import {
  WorkflowRunner,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '../src/index.js';

describe('WorkflowRunner', () => {
  it('awaits durable completion event handling before starting dependent work', async () => {
    const calls: string[] = [];
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const definition: WorkflowDefinition<{}> = {
      id: 'durable-events',
      nodes: [
        { id: 'research', label: 'Research', run: async () => 'evidence' },
        { id: 'judge', label: 'Judge', dependsOn: ['research'], run: async () => { calls.push('judge'); } },
      ],
    };
    const running = new WorkflowRunner({
      onEvent: async (event) => {
        if (event.type === 'workflow.step.completed' && event.nodeId === 'research') await persistence;
      },
    }).run(definition, {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([]);
    releasePersistence();
    await running;
    expect(calls).toEqual(['judge']);
  });

  it('records disabled profile nodes as skipped and lets dependent nodes continue', async () => {
    const events: WorkflowEvent[] = [];
    const definition: WorkflowDefinition<{ reasoning: boolean }> = {
      id: 'profile-aware',
      nodes: [
        { id: 'research', label: 'Research', run: async () => 'evidence' },
        {
          id: 'debate',
          label: 'Debate',
          dependsOn: ['research'],
          enabled: (context) => context.reasoning,
          run: async () => 'deep debate',
        },
        {
          id: 'summary',
          label: 'Summary',
          dependsOn: ['research', 'debate'],
          run: async (_context, inputs) => inputs.debate ?? 'usual summary',
        },
      ],
    };

    const result = await new WorkflowRunner({ onEvent: (event) => events.push(event) })
      .run(definition, { reasoning: false });

    expect(result).toMatchObject({ research: 'evidence', debate: undefined, summary: 'usual summary' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'workflow.step.skipped',
      nodeId: 'debate',
      reason: 'disabled',
    }));
    expect(events.some((event) => event.type === 'workflow.step.started' && event.nodeId === 'debate')).toBe(false);
  });

  it('propagates cancellation and never starts dependent nodes', async () => {
    const events: WorkflowEvent[] = [];
    const controller = new AbortController();
    const definition: WorkflowDefinition<{}> = {
      id: 'cancellable',
      nodes: [
        {
          id: 'research',
          label: 'Research',
          run: async (_context, _inputs, signal) => await new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        },
        { id: 'judge', label: 'Judge', dependsOn: ['research'], run: async () => 'must not run' },
      ],
    };

    const running = new WorkflowRunner({ onEvent: (event) => events.push(event) })
      .run(definition, {}, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new DOMException('Stopped by user', 'AbortError'));

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'workflow.step.cancelled',
      nodeId: 'research',
    }));
    expect(events.some((event) => event.type === 'workflow.step.started' && event.nodeId === 'judge')).toBe(false);
  });

  it('runs independent nodes together and waits for both before their dependent node', async () => {
    const calls: string[] = [];
    let releaseMarket!: () => void;
    let releaseFinancials!: () => void;
    const marketReady = new Promise<void>((resolve) => { releaseMarket = resolve; });
    const financialsReady = new Promise<void>((resolve) => { releaseFinancials = resolve; });
    const definition: WorkflowDefinition<{}> = {
      id: 'parallel-research',
      nodes: [
        { id: 'market', label: 'Market', run: async () => { calls.push('market:start'); await marketReady; return 'market-data'; } },
        { id: 'financials', label: 'Financials', run: async () => { calls.push('financials:start'); await financialsReady; return 'financial-data'; } },
        { id: 'judge', label: 'Judge', dependsOn: ['market', 'financials'], run: async (_context, inputs) => { calls.push(`judge:${inputs.market}+${inputs.financials}`); return 'done'; } },
      ],
    };

    const running = new WorkflowRunner().run(definition, {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['market:start', 'financials:start']);
    releaseMarket();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).not.toContain('judge:market-data+financial-data');
    releaseFinancials();

    await expect(running).resolves.toEqual({
      market: 'market-data',
      financials: 'financial-data',
      judge: 'done',
    });
    expect(calls.at(-1)).toBe('judge:market-data+financial-data');
  });

  it('records optional enrichment failure and still runs dependent synthesis', async () => {
    const events: WorkflowEvent[] = [];
    const definition: WorkflowDefinition<{}> = {
      id: 'optional-risk',
      nodes: [
        { id: 'research', label: 'Research', run: async () => 'evidence' },
        { id: 'risk', label: 'Risk', dependsOn: ['research'], required: false, run: async () => { throw new Error('news unavailable'); } },
        { id: 'summary', label: 'Summary', dependsOn: ['research', 'risk'], run: async (_context, inputs) => inputs.risk ?? 'summary-without-risk' },
      ],
    };

    const result = await new WorkflowRunner({ onEvent: (event) => events.push(event) }).run(definition, {});

    expect(result.summary).toBe('summary-without-risk');
    expect(events).toContainEqual(expect.objectContaining({ type: 'workflow.step.failed', nodeId: 'risk', required: false }));
  });

  it('fails the command when a required node fails and never starts its dependent node', async () => {
    const events: WorkflowEvent[] = [];
    const definition: WorkflowDefinition<{}> = {
      id: 'required-evidence',
      nodes: [
        { id: 'evidence', label: 'Evidence', run: async () => { throw new Error('source rejected'); } },
        { id: 'judge', label: 'Judge', dependsOn: ['evidence'], run: async () => 'must not run' },
      ],
    };

    await expect(new WorkflowRunner({ onEvent: (event) => events.push(event) }).run(definition, {})).rejects.toMatchObject({
      code: 'WORKFLOW_STEP_FAILED',
      nodeId: 'evidence',
    });
    expect(events.some((event) => event.type === 'workflow.step.started' && event.nodeId === 'judge')).toBe(false);
  });
});
