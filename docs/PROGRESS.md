# FinHarness Progress

Last updated: 2026-09-20

## Current state

The stateful architecture milestones **A-P** are complete on `master`. **Q1**,
**Q2**, **R1**, and **R2A** are also complete on `master`.

The current next milestone is **R2B — Deterministic Policy + Capability
Gateway**. **R2C — Production Capability Integration + Resume Semantics** is
future work.

The canonical future sequence and dependency rationale live in
[`docs/ROADMAP.md`](ROADMAP.md). This document is the mutable current-status
view, not a second detailed roadmap.

## Recently completed

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
implemented

/search
implemented

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

Natural-language conversation does not silently execute `/judge`, `/research`,
`/compare`, `/challenge`, `/investigate`, or `/screen`. Fresh research remains
an explicit command boundary.

## Next milestone

### R2B — Deterministic Policy + Capability Gateway

Status: **next**.

R2B is future authorization work: explicit caller identity, deterministic
policy, and a gateway that mediates access to registered capabilities before a
trusted `ToolDefinition` reaches `ToolRuntime`. Exact principals, grants,
policy representation, and gateway APIs are not yet locked.

### R2C — Production Capability Integration + Resume Semantics

Status: **future**.

R2C will move production capabilities through the future gateway while
preserving `FinancialDataProvider` as the financial seam and will address
capability-related execution semantic compatibility for durable resume. No
finalized capability plan or fingerprint contract exists yet.

## Maintenance policy

Update this file when:

- a major architecture PR merges;
- the current milestone changes;
- the next milestone changes materially;
- a command changes between implemented and stub status.

Do not create a new progress folder or per-PR status file. Git history records
previous versions; [`docs/ROADMAP.md`](ROADMAP.md) owns future detail.
