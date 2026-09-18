# PR N — Verified Financial Snapshot Design

## Context

PR M provides the provider-neutral `FinancialDataProvider` seam, but `/judge`
still turns provider responses directly into Evidence. PR N inserts an
execution-scoped, immutable financial-input boundary without changing the
Evidence, Artifact, ContextSnapshot, or model-runtime responsibilities.

The current repository has one real provider, Sectors, and a deterministic
mock. The provider cache already persists truthful `fetchedAt`, optional
`dataAsOf`, and financial `period` metadata, but the public provider contract
currently returns only data. Current `/judge` writes required Evidence in the
first two research nodes and optional Evidence in `collect-sources`.

## Goals and invariants

- Every successful `/judge` financial-input phase creates exactly one durable
  `VerifiedFinancialSnapshot` for that Execution.
- Required company and quarterly observations must pass deterministic shape,
  subject, provenance, and temporal checks before finalization.
- Optional observations explicitly use `PRESENT`, `NOT_REQUESTED`, or
  `UNAVAILABLE`; unavailable data is never converted to a financial zero.
- Evidence is materialized only from accepted observations.
- Evidence's existing cross-execution deduplication and `run_evidence`
  membership semantics remain unchanged.
- Snapshot identity is execution-scoped. A new Execution creates a new
  snapshot even when the provider reuses a cache entry.
- Same Execution plus the same canonical semantic payload is idempotent;
  same Execution plus a different payload is a deterministic conflict.
- Snapshot finalization happens before `select-supporting-evidence` and before
  the first Bull model call.
- Snapshot verification is deterministic code only; no LLM participates.
- Provider freshness remains owned by the Sectors cache policy. PR N records
  metadata but does not decide whether to fetch or reuse.
- Financial snapshots do not enter ContextPacket, SessionWorkingContext,
  artifact retrieval, or specialist inputs.

## Provider-neutral result and observation model

`@harness/financial-data` will add a result envelope for the seven `/judge`
operations while `/screen` keeps its existing list return shape:

```ts
interface FinancialDataMetadata {
  providerId: string;
  source: string;
  origin: 'PROVIDER' | 'CACHE' | 'MOCK' | 'DERIVED';
  fetchedAt: string | null;
  dataAsOf: string | null;
  requestedAsOf: string | null;
  period: string | null;
  derivedFrom: FinancialObservationKind[];
}

interface FinancialDataResult<T> {
  data: T;
  metadata: FinancialDataMetadata;
}
```

Null means the runtime does not know the value; PR N will not fabricate
execution time as `requestedAsOf` or rewrite cached `fetchedAt`. Sectors will
surface the existing cache timestamp and data/period metadata. Derived
sentiment will identify the actual `news` and `foreign_flow` dependencies and
will not add an endpoint or paid call.

The snapshot contains one typed observation for each current `/judge` kind:

- required: `company_report`, `quarterly_financials`
- optional: `daily_transaction`, `foreign_flow`, `news`, `filings`,
  `sentiment`

A present observation stores typed data, provider-neutral metadata,
deterministic verification outcomes, and the Evidence IDs materialized from
that observation. An unavailable/not-requested observation stores a stable
reason only; it does not store raw provider bodies, secrets, headers, or stack
traces.

Verification checks schema compatibility, ticker equality, required presence,
provenance presence, and supported temporal contradictions. It does not impose
unsupported financial-value rules such as positive PE or bounded ROE. Required
verification failure aborts before persistence. Optional verification failure
becomes `UNAVAILABLE` and preserves the current degradation behavior.

## Durable storage

The database will add migration `0012_financial_snapshots.sql` and a
`financial_snapshots` table with:

- `snapshot_id` primary key;
- `schema_version`;
- `session_id`, `turn_id`, `execution_id` foreign keys;
- `ticker`;
- canonical `payload_json`;
- `fingerprint`;
- `created_at` and `finalized_at`;
- unique `execution_id` ownership.

The database package will expose a focused `FinancialSnapshotStoreSqlite` with
`save`, `getById`, and `getByExecutionId`. It will validate Session → Turn →
Execution linkage, command/ticker ownership, and the one-snapshot-per-
Execution invariant. It will use the repository's canonical JSON and SHA-256
patterns. The semantic fingerprint excludes `snapshotId`, `createdAt`, and
`finalizedAt`; the deterministic ID includes the Execution ID so equal payloads
from separate Executions remain distinct.

The store is insert-only. An identical retry returns the stored row, while a
same-Execution fingerprint mismatch raises a conflict. No latest pointer,
mutable update, cross-session search, or semantic retrieval API is introduced.

## Workflow integration

The existing 15-node graph and node IDs remain unchanged. Research nodes return
provider result envelopes rather than persisting Evidence immediately.

`collect-sources` becomes the sole financial-input boundary:

1. inspect required and optional node results, including disabled/failure state;
2. verify required observations and fail closed on invalid/missing data;
3. verify optional observations or record explicit unavailable/not-requested
   state;
4. materialize Evidence from accepted observations using the existing source,
   payload, and dedup semantics;
5. build and persist the immutable snapshot manifest with the Evidence IDs;
6. return the existing Evidence collections and availability flags.

`select-supporting-evidence` and all reasoning nodes continue to receive only
Evidence. `JudgeArtifacts`, artifact payloads, SessionWorkingContext, and
conversational context remain unchanged; snapshot audit is available through
the database store by Execution ID.

## Test strategy

TDD order:

1. provider envelope and observation contract tests;
2. verifier tests for required mismatch/missing, optional unavailable,
   not-requested, provenance, temporal unknown/contradiction, and permissive
   financial values;
3. snapshot canonicalization and deterministic identity tests;
4. migration/store tests for restart, linkage, idempotency, conflict, and
   cross-Execution identity;
5. materialization tests proving rejected payloads never become Evidence and
   dedup remains intact;
6. `/judge` integration tests for finalization ordering, required/optional
   failure, cancellation, post-finalization reasoning failure, and one
   snapshot per Execution;
7. provider-call parity tests proving no paid sentiment endpoint or extra
   fetches;
8. existing context, specialist, artifact, routing, and offline E2E suites.

The final floor is `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm test`, `pnpm lint`, and `git diff --check`, plus focused suites for
financial-data, snapshot/store, cache/freshness, `/judge`, Evidence,
artifacts, SessionWorkingContext, Context Engine, specialist context, and
offline E2E.

## Explicit non-goals

PR N does not add another provider, fallback/reconciliation, provider scoring,
Capability Registry, generic Tool Runtime, model-visible financial tools,
checkpoint/resume, Evidence Policy, Claim Graph, research graphs, semantic
snapshot retrieval, `/compare`, `/research`, UI redesign, or model-runtime
changes.
