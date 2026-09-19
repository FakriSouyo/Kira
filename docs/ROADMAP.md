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

## Next

### P — `/judge` Same-Execution Checkpoint / Resume

**Implementation complete on the current feature branch; pending review/merge.**
PR P:

- validate an interrupted Execution;
- reconstruct valid workflow state;
- restore the FinancialSnapshot and accepted Evidence;
- restore exact typed Bull, Bear, Rebuttal, and Judge outputs;
- compute a DAG-safe resumable frontier;
- continue the **same** Execution;
- exposes `/resume <executionId>` and an unambiguous `/continue` path;
- repair or complete idempotent final publication.

PR O remains the generic foundation. PR P is the first milestone that provides
true same-Execution Judge continuation; `/session <executionId>` remains the
read-only session/execution viewer.

## Later milestones

1. **Model Runtime Generalization**
2. **Capability Registry + Typed Tool Runtime**
3. **Document & File Workspace**
4. **Evidence Policy + Claim Graph**
5. **Reusable Research Subgraphs**
6. **Risk Committee**
7. **Research Graph**
8. **Decision Journal**
9. **Outcome Tracking + Reflection**
10. **UI Integration / Final Polish**

### Semantic grouping

**Reliable Research Execution:** provider seam, verified snapshot, evidence,
debate, verdict, and same-Execution resume.

**Composable Intelligence:** model runtime, capabilities, documents, claim
graph, reusable research subgraphs, and Risk Committee.

**Learning Research System:** Research Graph, Decision Journal, outcomes, and
reflection.

These groupings describe direction only; they do not imply that future
milestones are implemented.
