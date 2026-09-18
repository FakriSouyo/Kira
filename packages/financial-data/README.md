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
