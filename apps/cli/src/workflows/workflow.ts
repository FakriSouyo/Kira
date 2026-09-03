/**
 * Minimal workflow abstraction (Phase 3, §27).
 * Evaluasi LangGraph: tidak diadopsi — over-engineering untuk 2 workflow.
 * `WorkflowBuilder` hanya linear DAG + satu conditional branch, cukup untuk
 * conditional debate tanpa menambah dependency.
 */

export type WorkflowEvents = {
  phase?: (phase: string, label: string) => void;
};

export interface WorkflowStep<Ctx> {
  name: string;
  fn: (ctx: Ctx) => Promise<void>;
}

type Branch<Ctx> = {
  predicate: (ctx: Ctx) => boolean;
  workflow: Workflow<Ctx>;
};

export class Workflow<Ctx> {
  private steps: WorkflowStep<Ctx>[] = [];
  private branches: Branch<Ctx>[] = [];

  /** Tambah langkah linear. */
  step(name: string, fn: (ctx: Ctx) => Promise<void>): this {
    this.steps.push({ name, fn });
    return this;
  }

  /**
   * Conditional branch — dijalankan setelah semua step linear bila predicate true.
   * `builderFn` menerima Workflow baru untuk langkah-langkah cabang.
   */
  branch(predicate: (ctx: Ctx) => boolean, builderFn: (w: Workflow<Ctx>) => void): this {
    const branchWorkflow = new Workflow<Ctx>();
    builderFn(branchWorkflow);
    this.branches.push({ predicate, workflow: branchWorkflow });
    return this;
  }

  /** Eksekusi workflow — fail-closed: error pertama langsung throw. */
  async run(ctx: Ctx, events?: WorkflowEvents): Promise<void> {
    for (const s of this.steps) {
      events?.phase?.(s.name, s.name);
      await s.fn(ctx);
    }
    for (const b of this.branches) {
      if (b.predicate(ctx)) {
        await b.workflow.run(ctx, events);
      }
    }
  }

  get stepCount(): number {
    return this.steps.length;
  }

  get branchCount(): number {
    return this.branches.length;
  }
}

/** Helper factory — ergonomi `defineWorkflow<Ctx>((w) => {...})`. */
export function defineWorkflow<Ctx>(builderFn: (w: Workflow<Ctx>) => void): Workflow<Ctx> {
  const w = new Workflow<Ctx>();
  builderFn(w);
  return w;
}
