import { describe, it, expect } from 'vitest';
import { Workflow, defineWorkflow } from '../src/workflows/workflow.js';

describe('Workflow abstraction (Phase 3 Task 1)', () => {
  it('menjalankan steps linear berurutan', async () => {
    const order: string[] = [];
    const w = new Workflow<{ n: number }>();
    w.step('a', async (ctx) => { order.push('a'); ctx.n += 1; });
    w.step('b', async (ctx) => { order.push('b'); ctx.n += 1; });
    const ctx = { n: 0 };
    await w.run(ctx);
    expect(order).toEqual(['a', 'b']);
    expect(ctx.n).toBe(2);
  });

  it('conditional branch taken saat predicate true', async () => {
    const order: string[] = [];
    const w = defineWorkflow<{ flag: boolean }>((wf) => {
      wf.step('base', async () => { order.push('base'); });
      wf.branch((ctx) => ctx.flag, (b) => {
        b.step('extra', async () => { order.push('extra'); });
      });
    });
    await w.run({ flag: true });
    expect(order).toEqual(['base', 'extra']);
  });

  it('conditional branch skipped saat predicate false', async () => {
    const order: string[] = [];
    const w = defineWorkflow<{ flag: boolean }>((wf) => {
      wf.step('base', async () => { order.push('base'); });
      wf.branch((ctx) => ctx.flag, (b) => {
        b.step('extra', async () => { order.push('extra'); });
      });
    });
    await w.run({ flag: false });
    expect(order).toEqual(['base']);
  });

  it('fail-closed: error di step menghentikan workflow', async () => {
    const order: string[] = [];
    const w = new Workflow<Record<string, never>>();
    w.step('a', async () => { order.push('a'); });
    w.step('b', async () => { throw new Error('boom'); });
    w.step('c', async () => { order.push('c'); });
    await expect(w.run({} as never)).rejects.toThrow('boom');
    expect(order).toEqual(['a']);
  });

  it('events.phase dipanggil per step', async () => {
    const phases: string[] = [];
    const w = new Workflow<{ x: number }>();
    w.step('researcher', async () => {});
    w.step('judge', async () => {});
    await w.run({ x: 1 }, { phase: (p) => phases.push(p) });
    expect(phases).toEqual(['researcher', 'judge']);
  });
});
