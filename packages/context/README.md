# `@harness/context`

PR G provides the provider-neutral Context Engine construction pipeline:

```text
SessionWorkingContext → Reference Resolver → Context Policy → Context Assembler → ContextPacket
```

`SessionWorkingContext` is durable, versioned relevance state. `ContextPacket` is
an immutable, invocation-scoped structured projection of that state; it is not a
journal replay, provider cache, prompt string, or persisted snapshot.

PR K also defines an explicit `SPECIALIST` packet for lifecycle-backed `/judge`
calls. It carries execution-owned Evidence plus typed upstream Bull claims, Bear
counterpoints, rebuttal claims, and Judge discussion for the role/phase. It is
assembled from the current execution only: it creates no Evidence, calls no
provider, reads no history, and shares no cross-session memory. All specialist
roles render the same canonical Evidence zone; debate state is a separately
labelled role zone.

- `resolveContextCandidates` resolves only explicit active/pinned references
  through the `ArtifactStore` boundary and reports legacy, missing, and skipped
  references with structured diagnostics. A typed `activeThesisRef` uses the
  existing PR F Bull artifact semantics because PR F has no separate Thesis kind.
- `selectContextCandidates` applies deterministic structured focus rules; it does
  not infer intent with an LLM or search historical artifacts.
- `assembleContext` creates schema-versioned packet data in stable thesis, Bull,
  Bear, Verdict, then pinned order, deduplicating by canonical artifact ID while
  retaining role/source provenance.

The package has no Sectors/provider dependency and performs no writes, workflow
execution, Evidence expansion, freshness decisions, prompt rendering, or model
call integration. PR H adds the immutable `ContextSnapshot` envelope and
fingerprint, persists it through `@harness/database`, and gives existing
`ModelCall` rows nullable `contextSnapshotId` linkage. Calls not yet supplied a
PR G packet remain explicitly unlinked; no empty snapshots are fabricated.

PR J adds `budgetContext` after assembly and before snapshotting. It measures the
pure rendered context with a deterministic conservative estimator, accounting for
the configured model window, output reserve, protected system/current-user input,
history, and safety margin. Structural compaction removes lower-priority whole
items or reduces typed artifact projections in stable order; it never calls a
provider or model, mutates durable artifacts or `SessionWorkingContext`, merges
trust classes, or chops financial text. If the required focus context cannot fit,
`ContextBudgetError` fails before snapshot persistence. The snapshot therefore
always contains the final post-budget packet, and the coordinator retains the
budget report as operational diagnostics rather than adding it to model-visible
context.

PR K reuses that accounting for specialist packets. Evidence and typed claims
are authoritative; Judge discussion is the first lower-priority material that
may be removed structurally. If required Evidence cannot fit, budgeting fails
before the model call or snapshot. Specialist snapshots use
`workingContextVersion: 0` as an explicit sentinel because they are
execution-scoped and do not represent a `SessionWorkingContext` version;
conversation packets retain their existing version semantics.
