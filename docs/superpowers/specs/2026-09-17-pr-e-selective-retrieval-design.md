# PR E — Selective Provider Retrieval and Freshness Policy

Date: 2026-09-17
Status: approved design; implementation not started

## 1. Scope and boundaries

PR D is complete at commit `983b763`. PR E implements selective provider retrieval and freshness policy for the existing Sectors API surface.

The change is limited to:

- declaring the provider data requirements of workflow nodes;
- normalizing those requirements into deterministic FileCache identities;
- deciding whether each compatible cached provider response can be reused or must be fetched;
- supporting category-specific temporal and freshness semantics;
- preserving required/optional source behavior and partial refresh;
- exposing inspectable `reuse` / `fetch` decisions and reasons;
- creating fresh execution-scoped Evidence from reused or newly fetched provider responses.

PR E does not add PR F, a Context Engine, typed artifacts, provider freshness to `session-core`, a generic provider registry, or automatic reuse of Evidence from another Execution. The existing `FileCache` remains the sole provider cache. The PR D narrow-query optimization remains deferred unless a PR E test demonstrates that it is necessary.

The worktree contains unrelated dirty-tree changes. Implementation and commit selection must include only the files required for this PR E design.

## 2. Current Sectors surface

Before choosing policy, the existing adapter behavior is treated as the contract to characterize with counting-fetch tests.

The current v2 adapter exposes these provider operations:

| Operation | Current endpoint/behavior | Temporal meaning |
| --- | --- | --- |
| company report | `/company/report/{ticker}/` | Mixed company identity, valuation, and fundamental response; `asOf` is the response's market/reference date, not automatically a financial reporting period. |
| quarterly financials | `/financials/quarterly/{ticker}/` | Period-bearing rows normalized by the adapter; `latest` is a moving request and cannot be treated as an immutable period. |
| daily transaction | `/daily/{ticker}/?start&end` | Historical daily data over the adapter's current 90-day window. |
| foreign flow | `/foreign-flow/{ticker}/?start&end` | Historical daily data over the adapter's current 90-day window. |
| news | `/news/?symbols&limit` | Recent news collection with a short-lived freshness requirement. |
| filings | `/filings/?symbol&limit` | Recent/event-oriented filing collection with its own identity and revalidation policy. |
| sentiment | Derived from news and foreign flow | No separate Sectors endpoint or independent provider cache entry. |

With both current `/judge` researcher groups enabled, the network-backed provider operations are company report, quarterly financials, daily transaction, foreign flow, news, and filings. Sentiment is derived from its dependencies; it must not become an invented provider request. If the current implementation allows news processing to obtain foreign flow indirectly when market research is disabled, PR E must make that dependency explicit while preserving the existing required/optional degradation contract rather than hiding an unrequested provider call.

The `/judge` graph remains node-owned: identify-company and financials are required; market and news groups are optional according to researcher configuration; `WorkflowRunner` continues to own execution order, cancellation, and required/optional failure handling.

## 3. Design options and decision

### Selected: Sectors-specific policy over the existing FileCache

Extend the existing `FileCache` metadata and access path as needed, and add a small Sectors-specific policy layer. The layer accepts normalized operation requirements, reads/writes the existing cache, and returns an inspectable decision with a reason. It does not become a generic provider abstraction.

This keeps cache semantics next to the Sectors adapter, permits the current endpoint behavior to drive policy, and makes call avoidance measurable with counting-fetch tests.

### Deferred: generic provider registry or capability framework

A provider registry, provider plugin interface, or cross-provider capability model would add ownership and compatibility surface without a current consumer. It is deferred until a second provider requires the same abstraction.

### Rejected: workflow-level prefetch

Prefetching all data at the workflow boundary would hide node requirements, fetch unused optional data, and make execution truth harder to inspect. Requirements remain attached to the nodes that consume them.

## 4. Requirement model

Each provider-backed node declares a lightweight Sectors data requirement containing:

- operation;
- normalized subject, when the operation is subject-specific;
- normalized arguments that affect the response;
- temporal request, including explicit period, range, or `asOf` when present;
- freshness policy/category;
- required or optional source semantics.

Declarations stay close to the `/judge` node consumers. They are not workflow/run identities and are not persisted as Evidence.

The operation's actual dependencies are declared explicitly. A derived value such as sentiment can consume cached or fetched dependency responses, but it does not acquire an independent cache identity or provider call.

## 5. Workflow-agnostic cache identity

The cache key is based only on the provider result's semantic inputs:

- provider identity;
- operation;
- normalized subject, when subject-specific;
- normalized arguments that affect the provider response;
- requested `asOf` compatibility requirement;
- requested period or date range;
- response schema version;
- adapter version.

The key must not include the command, workflow name, Turn, Execution, run ID, journal correlation/causation IDs, or other lifecycle identifiers unless the provider response genuinely depends on that value. Credentials and local storage location are not response identity either.

Consequences:

- an identical compatible financials requirement from `/research BBCA` and `/judge BBCA` reuses one valid provider response;
- a repeated request in another run is not forced to miss because its run identity changed;
- subject-specific `financials(BBCA)` and `financials(BBRI)` have different identities and cannot cross-reuse;
- a genuinely subject-independent operation may reuse across subjects because no subject is placed in its identity, but no such new operation is invented for demonstration.

The current `screen(criteria)` operation is universe-level and intentionally remains uncached. Therefore the implementation must document the subject-independent cache test as not applicable to the current cached Sectors surface unless characterization identifies an existing truly subject-independent provider operation. The test must not manufacture a shared sector or macro request merely to satisfy this case.

Only identical or semantically compatible normalized requirements may share an entry. Different ranges, periods, `asOf` constraints, response schema versions, or adapter versions are misses or incompatible entries as appropriate.

## 6. FileCache and decision contract

`FileCache` remains the only provider cache. Existing safe properties remain mandatory:

- atomic writes;
- sanitized deterministic filenames or equivalent deterministic paths;
- missing entries are misses;
- corrupt entries are safe misses;
- schema-version or adapter-version incompatibility is a safe miss;
- restart/recovery can reuse valid entries already on disk.

Cache metadata distinguishes at least:

- `fetchedAt` — when this response was obtained;
- `dataAsOf` — the provider's data/reference date, when supplied;
- `period` — reporting period, when supplied;
- requested period/range/as-of dimensions used for compatibility;
- response schema version;
- adapter version;
- provider source identity.

The policy returns an inspectable decision of `reuse` or `fetch`, with a stable reason such as `fresh`, `period-valid`, `asof-compatible`, `missing`, `stale`, `period-mismatch`, `asof-mismatch`, `schema-mismatch`, `adapter-mismatch`, or `force-refresh`. The observation mechanism is testable and local to the Sectors policy; it is not a prompt, a session event, or a generic telemetry system.

Partial refresh is allowed: an invalid market operation does not force valid financial or news entries to refetch, and a news refresh does not invalidate financials. The policy operates per normalized requirement, while derived values reuse the dependency responses participating in the current node execution.

## 7. Freshness and temporal policy

The implementation must characterize endpoint semantics before assigning durations. Durations come from the existing Sectors configuration and observable endpoint behavior, not from a blanket calendar-day rule.

### Company identity/profile

The current company report is a mixed response rather than a dedicated immutable identity endpoint. It may use the existing configured long-lived/periodic policy for compatible reuse, with `dataAsOf` retained as provider metadata. The implementation must not label the market/reference `asOf` as a financial reporting period. If the current endpoint cannot separate profile from valuation, PR E does not invent a split or a shared macro request.

### Historical daily market data

Daily transaction and foreign-flow results are historical date-range responses. Their normalized identity includes the exact requested range. Validity is trading-day/calendar-aware for completed historical data, subject to the endpoint's inclusive/exclusive date behavior. The current adapter's 90-day range must be represented in the identity rather than hidden in a ticker-only filename.

### Current/recent market state

If a current or recent market snapshot endpoint is introduced later, its policy must support short-lived freshness appropriate to that endpoint's semantics. The current Sectors surface has daily historical and foreign-flow windows but no separate current snapshot endpoint, so PR E must not pretend that all market data has calendar-day freshness and must not create a snapshot operation solely for this specification.

### News and filings

News uses a configured short TTL, currently characterized by the existing one-hour default, rather than a calendar-day cache rule. Filings have a separate normalized operation identity even when stored under the same cache directory. Their policy is event/revalidation-oriented when the endpoint supplies event identity; otherwise it uses the smallest configured bounded freshness policy compatible with the current endpoint. News and filings must not share entries merely because both are recent text responses.

### Quarterly financials

An explicit historical request such as `financials(period = Q2 2026)` is compatible only with a response covering that period and the applicable schema/adapter/revision policy. It may remain reusable according to that period policy.

`financials(latest)` is different: it represents the latest period available at request time. A cached Q2 response cannot satisfy it indefinitely after Q3 becomes available. Latest responses use bounded revalidation based on the existing configured policy and endpoint semantics. This does not fetch on every request and does not invent a revision endpoint; it ensures that a latest cache entry periodically becomes eligible for a check that can discover a newer period or revision. `fetchedAt`, reporting period, and provider `dataAsOf` remain separate fields.

### As-of compatibility

An as-of request may reuse only a response that is point-in-time compatible with the requested boundary. A newer response that could include information after a historical as-of boundary is not a valid substitute. Current/latest requests may not be silently served by a historical entry with incompatible temporal meaning.

## 8. Provider response versus Evidence

The cache stores reusable provider response data, not workflow Evidence. On every current Execution, the flow is:

```text
node requirement
  -> normalized cache identity
  -> FileCache inspection
  -> reuse/fetch decision
  -> provider response normalization
  -> new current-Execution Evidence membership
  -> ClaimValidator
```

A cache hit means only that the provider response is reused. The response is still attached to the current Execution's Evidence set with the current run correlation and causal journal relationships. Previous Execution Evidence is never imported automatically. All existing evidence-scope, seen-evidence, numeric-grounding, and deterministic-parity guarantees remain release gates.

Provider cache reuse or refresh does not update session working context. Context update semantics remain governed by the PR D/session-core contract, including CAS/version behavior and canonical Turn sequencing.

## 9. Error, cancellation, and recovery behavior

Required provider requirements preserve the current fail-closed behavior. Optional requirements preserve the current degradation behavior and do not turn an optional source failure into a workflow failure. The runner's cancellation and node ordering rules remain unchanged.

Cache corruption, missing metadata, unsupported legacy shape, schema mismatch, and adapter mismatch are safe misses followed by a normal fetch when the node is still eligible to run. Atomic replacement preserves the last readable complete entry if a write fails. No distributed locking or cross-process coordination is introduced in PR E.

If an in-flight HTTP request cannot be aborted by the existing adapter contract, cancellation still prevents downstream node work and persistence according to the existing runner semantics; PR E does not broaden cancellation into a new transport abstraction.

## 10. Test and acceptance plan

The implementation is accepted only when the following focused coverage is green:

1. Counting-fetch characterization establishes the current Sectors operation surface, including derived sentiment dependencies, and proves unused operations are not called.
2. The same compatible provider operation is reused across different workflow/consumer labels; changing command, workflow, run, Turn, or Execution labels alone does not change identity or force a miss.
3. Subject-specific BBCA data cannot satisfy BBRI, while a real subject-independent cached operation, if one exists in the characterized surface, is reusable across subjects. If none exists, the test records that the case is not applicable and keeps `screen` uncached.
4. A second run avoids compatible provider calls; a restart reuses valid on-disk entries; corrupt and incompatible entries safely refetch.
5. Partial refresh invalidates only the affected requirement. Market, news, filings, company, and financial operations keep independent identities and policies.
6. Historical daily/foreign data observes exact ranges and trading-day-aware validity. News observes the configured short TTL. No current snapshot policy is claimed for an endpoint that does not exist.
7. Explicit financial periods require period compatibility. `latest` has bounded revalidation and can discover a newer period or revision without fetching every request.
8. As-of compatibility prevents a response containing later information from satisfying a historical boundary.
9. Required and optional failures, cancellation, and direct zero-Execution Turns retain existing behavior.
10. A provider cache hit creates new current-Execution Evidence, preserves Evidence scope and seen-evidence rules, passes ClaimValidator numeric grounding, and preserves deterministic output parity.
11. Provider cache reuse/refetch emits no session context update and introduces no `session-core` provider dependency.
12. All PR A-D regressions, journal correlation/causation, prompt-cache invariants, typecheck, lint, and the full suite remain green.

Later verification will run the focused PR E tests, existing Sectors cache/client tests, `/judge` parity and Evidence tests, PR A-D regression groups, `pnpm typecheck`, `pnpm lint`, and `pnpm test`.

## 11. Planned implementation surface

The eventual PR E change is expected to stay within the following areas, adjusted only when tests demonstrate a necessary adjacent file:

- `packages/sectors-api/src/cache.ts` for provider-cache metadata/access support;
- a small Sectors policy/requirements module and its package exports;
- `packages/sectors-api/src/client.ts` for normalized identities, policy decisions, and endpoint-specific temporal semantics;
- Sectors cache/client tests and the package README;
- `/judge` node requirement declarations and node tests in `apps/cli/src/workflows/`;
- the minimal `ARCHITECTURE.md` note needed to document the corrected provider `source`/freshness boundary.

No provider freshness logic is added to `session-core`, and no PR F/context-engine files are included.

## 12. Completion gate

Stop after the selectively staged PR E commit. The completion report must include the commit hash, focused and regression test results, typecheck, lint, full-suite result, and confirmation that unrelated dirty-tree work was left untouched. PR F must not begin in the same work cycle.
