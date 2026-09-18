# `@harness/context`

PR G provides the provider-neutral Context Engine construction pipeline:

```text
SessionWorkingContext → Reference Resolver → Context Policy → Context Assembler → ContextPacket
```

`SessionWorkingContext` is durable, versioned relevance state. `ContextPacket` is
an immutable, invocation-scoped structured projection of that state; it is not a
journal replay, provider cache, prompt string, or persisted snapshot.

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
