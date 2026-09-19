# `@harness/financial-data`

Provider-neutral financial data contracts for deterministic research consumers.

The package contains the canonical domain shapes and `FinancialDataProvider`
interface for company reports, quarterly financials, screening, market data,
news, filings, and sentiment. It has no HTTP, cache, provider credentials,
workflow, Evidence, Artifact, Context, or model dependencies.

The current implementation is supplied by
`@harness/sectors-api` through `SectorsFinancialDataProvider`. Sectors-specific
transport and provenance remain inside that adapter; consumers depend only on
this contract.

Research operations return `FinancialDataResult<T>`, which pairs the typed
observation with truthful provider-neutral metadata: provider/source identity,
origin (`PROVIDER`, `CACHE`, `MOCK`, or `DERIVED`), known `fetchedAt`,
`dataAsOf`, `requestedAsOf`, period semantics, and derived lineage. Unknown
values are `null`; the contract does not fabricate timestamps.

The package also owns the PR N `VerifiedFinancialSnapshot` domain model and
deterministic verifier. It defines the seven `/judge` observation kinds and
explicit `PRESENT`, `NOT_REQUESTED`, and `UNAVAILABLE` states. The snapshot is
execution-scoped financial input state, not a cache, Evidence row, Artifact,
ContextSnapshot, or model context. SQLite persistence lives in
`@harness/database`; this package has no database or provider implementation
dependency.
