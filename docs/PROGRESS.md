# FinHarness Progress

Last updated: 2026-09-21

## Current state

The stateful architecture milestones **A-P** are complete on `master`. **Q1**,
**Q2**, **R1**, **R2A**, **R2B**, and **R2C1** are also complete on `master`.

The current milestone is **R2C2 — Judge Capability Migration + Durable Resume
Semantics**. **S1 — Durable File / Attachment Layer** follows it in the
canonical sequence.

The canonical future sequence and dependency rationale live in
[`docs/ROADMAP.md`](ROADMAP.md). This document is the mutable current-status
view, not a second detailed roadmap.

## Recently completed

### R2C1 — Financial Capability Composition + Screen Migration

Status: **complete on master**.

R2C1 registers all eight existing financial `ToolDefinition` values with
provider-neutral `financial-data` descriptors. The registrations preserve the
existing `createFinancialTools(provider)` bindings, so `FinancialDataProvider`
remains the domain authority seam and Sectors remains only its current concrete
provider implementation.

`buildContext()` now composes and exposes `capabilityGateway`. `/screen` supplies
the explicit `command.screen` principal and invokes `financial.screen` through
that gateway. Its policy grant contains only `financial.screen`; the other
seven registered financial capabilities remain unavailable to the Screen
principal. `ToolRuntime` still validates and executes the selected explicit
tool, and Screen filtering, ranking, rendering, and the ten-row limit remain
unchanged.

The production transition is intentionally incomplete:

```text
/screen -> CapabilityGateway -> ToolRuntime
/judge  -> direct ToolRuntime
```

Raw `toolRuntime` and `financialTools` remain in `HarnessContext` for Judge.
Judge principals/grants and capability-aware resume semantics do not exist yet;
R2C2 owns that work.

### R2B — Deterministic Policy + Capability Gateway

Status: **complete on master**.

R2B adds explicit caller principals, immutable exact-match capability grants,
deterministic `CapabilityPolicy` evaluation, and `CapabilityGateway` composition
over the R2A registry and `ToolRuntime`. Policy configuration validates IDs and
duplicates, policy discovery is detached/frozen/deterministically ordered, and
the gateway fails fast when policy grants reference capabilities absent from its
registry.

Gateway discovery is scoped to authorized data-only descriptors. Gateway
invocation validates the explicit principal and delegates the registered
`ToolDefinition` to `ToolRuntime`; it does not execute tools, validate tool I/O,
or provide workflow scheduling. Unknown capability errors remain distinct from
denials, and downstream runtime/domain error identity and cancellation
semantics are preserved.

R2B itself did not migrate production paths or add capability-aware durable
resume semantics. R2C1 now migrates Screen; Judge and durable capability
semantics remain R2C2 work.

### R2A — Capability Contracts + Immutable Registry

Status: **complete on master**.

R2A adds the domain-neutral `@harness/capability` package with:

- `CapabilityDescriptor` for safe public data-only metadata;
- `CapabilityRegistration<TTool>` for descriptor plus explicit typed tool binding;
- immutable, deterministic `CapabilityRegistry` discovery;
- typed `CapabilityRegistryError` failures;
- `list()`, `describe(id)`, and trusted lookup-only `resolveTool(id)`.

R2A validates required descriptor fields, duplicate canonical IDs, descriptor
and tool ID agreement, and the minimum structural contract for a tool binding.
It does not add authorization, policy, a gateway, production financial
migration, MCP integration, or capability-aware resume semantics. `ToolRuntime`
remains the sole execution authority.

### Q2 — Durable Model Selection + Production Integration

Q2 adds append-only, restart-persistent `SessionModelSelection` rows and keeps
default configuration, Session intent, execution runtime plans, and actual
ModelCall provenance distinct. The selected logical provider is composed into a
pure runtime plan with ordered fallbacks and effective capabilities; real
Context budgeting uses that plan.

MainFinHarnessAgent and SubagentRuntime use result-bearing runtime calls, and
durable ModelCalls persist actual provider/model, adapter, protocol, and
secret-free runtime fingerprints. Judge profiles pin the semantic runtime plan
while older PR P profiles remain readable. Resume remains same-Execution and
same-Turn behavior.

### R1 — Typed Tool Runtime

R1 provides explicit typed `ToolDefinition` contracts, one-shot ToolRuntime
validation and execution, lifecycle and cancellation semantics, and explicit
CLI financial adapters. R1 did not add capability discovery, policy,
integrations, or durable tool authority.

### PR O / PR P — Durable Resumability and Judge Resume

PR O provides immutable lifecycle profiles, typed node outputs, generation
fencing, startup reconciliation, and generic restored-node support. PR P
connects those contracts to the production 15-node Judge graph for validated
same-Execution `/resume` and `/continue`, projection repair, and idempotent
publication.

### PR M / PR N — Financial Provider Seam and Verified Snapshot

Financial workflows depend on the provider-neutral `FinancialDataProvider`
contract. Provider results are verified and finalized into an immutable,
execution-scoped `VerifiedFinancialSnapshot` before reasoning.

## Current command status

```text
/judge
implemented, mature research workflow

/screen
implemented, future maturation

/search
implemented, future maturation

/research
stub

/compare
stub

/challenge
stub

/investigate
stub
```

The broader CLI also contains implemented lifecycle, setup, export, web,
configuration, and session-control commands. `/judge` is the current mature
research vertical; `/screen` and `/search` are implemented but remain open to
future maturation. `/research`, `/compare`, `/challenge`, and `/investigate`
remain planned stubs.

## Current conversation status

Implemented conversation foundation includes:

- durable `ConversationJournal`;
- `ConversationController` and streaming conversation output;
- durable `SessionWorkingContext`;
- artifact-aware context retrieval;
- `ContextPacket` and immutable `ContextSnapshot`;
- token budgeting and deterministic compaction;
- same-session research-context follow-up;
- restart-safe durable research context.

Current production conversation preparation explicitly passes
`conversationHistory: ''`. Therefore full general retained multi-turn transcript
injection, bounded recent-turn selection, conversation-summary composition, and
robust cross-turn reference resolution are not yet implemented as a general
conversation system.

`ConversationJournal`, `ConversationSummary`, `SessionWorkingContext`,
`ContextPacket`, and `Evidence` remain distinct authorities. In particular:

```text
ConversationSummary != Evidence
```

Conversation-derived claims remain conversational/user context until they are
independently verified by an evidence-producing research workflow.

Natural-language conversation does not silently execute `/judge`, `/research`,
`/compare`, `/challenge`, `/investigate`, or `/screen`. Fresh research remains
an explicit command boundary.

## Next milestone

### R2C2 — Judge Capability Migration + Durable Resume Semantics

Status: **current / next implementation milestone**.

R2C2 will migrate Judge through explicit caller identity, policy, gateway, and
`ToolRuntime` composition and will address capability-related execution
semantic compatibility for durable resume. Current source requires
`financial.company-report` for `identify-company`,
`financial.quarterly-financials` for `fetch-financials`, daily transaction plus
foreign flow for `fetch-market-data`, and news, filings, plus sentiment for
`fetch-news`.

Exact Judge principal IDs and grant decomposition remain unlocked.
`WorkflowNode.executor` is not a principal and skills are not grants. Current
execution profiles do not pin capability policy, grants, or binding semantics;
no finalized capability plan or fingerprint contract exists yet.

## Maintenance policy

Update this file when:

- a major architecture PR merges;
- the current milestone changes;
- the next milestone changes materially;
- a command changes between implemented and stub status.

Do not create a new progress folder or per-PR status file. Git history records
previous versions; [`docs/ROADMAP.md`](ROADMAP.md) owns future detail.
