# FinHarness Roadmap

> Canonical roadmap. For current implementation status, see [PROGRESS.md](PROGRESS.md).

## Product direction

FinHarness is a stateful agent harness runtime with a financial-native evidence
and research layer. It keeps lifecycle, context, evidence, workflow execution,
and research products durable and inspectable while leaving model-generated
reasoning inside explicit command boundaries.

## Completed foundation

- **A — Canonical lifecycle:** Session → Turn → Execution is the durable request model.
- **B — Production lifecycle and journal linkage:** live requests share canonical lifecycle and append-only conversation audit state.
- **C — WorkflowRunner-owned `/judge`:** the production Judge graph runs through one generic dependency-aware workflow runtime.
- **D — SessionWorkingContext:** durable relevance state is versioned separately from journal history.
- **E — Selective retrieval and freshness:** financial retrieval follows explicit source policy and cache/freshness rules.
- **F — Durable typed artifacts:** Bull, Bear, and Verdict products use immutable execution-scoped envelopes.
- **G — Context Resolver / Policy / Assembler:** model inputs are selected and assembled through a bounded context engine.
- **H — ContextSnapshot and ModelCall linkage:** the exact model packet and usage linkage are durable.
- **I — Conversational context integration:** ordinary conversation can reuse valid same-session research context without silently running Judge.
- **J — Token budgeting and deterministic compaction:** context size is bounded by deterministic selection and compaction.
- **K — Specialist execution context:** Bull, Bear, and Judge receive typed, scoped execution context.
- **L — Artifact-aware retrieval and validity:** prior artifacts are reusable context references only when valid and in scope.
- **M — Financial Data Provider Seam:** workflow code depends on a provider-neutral financial contract.
- **N — Verified Financial Snapshot:** provider results are verified and finalized into an immutable execution-scoped input boundary.
- **O — Durable Resumability Foundation:** interrupted lifecycle state, immutable profiles and node outputs, generation fencing, startup reconciliation, and generic restored-node runner support are available.
- **P — `/judge` Same-Execution Checkpoint / Resume:** typed Judge checkpoints, validated DAG restoration, same-Execution continuation, `/resume`, `/continue`, projection repair, and idempotent publication are complete.

## Current milestone

### Q — Model Runtime

- **Q1 — Model Runtime + Provider Directory:** provider-neutral runtime
  contracts, immutable provider/model directory snapshots, adapter boundaries,
  safe runtime descriptors, one-shot prepared calls, actual invocation
  metadata, and compatibility-facade integration.
- **Q2 — Durable Model Selection + Production Integration:** planned; not part
  of Q1.

## Future milestones

### R — Capability Runtime

- R1 — Typed Tool Runtime
- R2 — Capability Registry + Policy + Integrations

### S — Files & Documents

- S1 — Durable File / Attachment Layer
- S2 — Workspace + File Capability
- S3 — Document Understanding / Retrieval

### T — Evidence Intelligence

- Evidence Policy + Claim Graph

### U — Research Composition

- Reusable Research Subgraphs

### V — Decision Intelligence

- Risk Committee

### W — Long-Term Research State

- Research Graph

### X — Decision Memory

- Decision Journal

### Y — Learning Loop

- Outcome Tracking + Reflection

### Z — Product Platform

- Z1 — Application Host / API Boundary
- Z2 — Web Surface
- Z3 — Desktop Host + Desktop Shell
- Z4 — Cross-Surface Integration / Final Polish

### Semantic grouping

**Reliable Research Execution:** provider seam, verified snapshot, evidence,
debate, verdict, and same-Execution resume.

**Composable Intelligence:** model runtime, capabilities, documents, claim
graph, reusable research subgraphs, and Risk Committee.

**Learning Research System:** Research Graph, Decision Journal, outcomes, and
reflection.

These groupings describe direction only; they do not imply that future
milestones are implemented.
