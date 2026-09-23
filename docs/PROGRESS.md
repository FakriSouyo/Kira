# FinHarness Progress

Last updated: 2026-09-23

## Current state

The stateful architecture milestones **A-P** are complete on `master`. **Q1**,
**Q2**, **R1**, **R2A**, **R2B**, **R2C1**, **R2C2**, and **S1** are also
complete on `master`.

**S2 — Workspace + File Capability** and **S3 — Document Understanding /
Retrieval** and **T1 — Evidence Acceptance + Provenance** are complete on
master. **T2 — Claim Grounding + Durable Claim Model** is complete in the
current implementation. **T3 — Counterpoint Grounding + Durability** is
implemented in the current worktree pending source review; T4 is next.

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

R2C1 established the first production transition:

```text
/screen -> CapabilityGateway -> ToolRuntime
/judge  -> direct ToolRuntime at the R2C1 boundary
```

R2C2 completes the remaining Judge migration and removes raw `toolRuntime` and
`financialTools` from `HarnessContext`.

### R2C2 — Judge Capability Migration + Durable Resume Semantics

Status: **complete on master**.

Judge now invokes its seven required financial operations through four explicit
workflow principals and the capability gateway. The mappings are:

```text
workflow.judge.identify-company -> financial.company-report
workflow.judge.fetch-financials -> financial.quarterly-financials
workflow.judge.fetch-market-data -> financial.daily-transaction, financial.foreign-flow
workflow.judge.fetch-news -> financial.news, financial.filings, financial.sentiment
```

`CapabilityPlan` is a deterministic, secret-free, data-only, deeply immutable
projection of those authorized descriptors. New Judge execution profiles store
the plan and its fingerprint. Resume planning rejects profiles without
capability semantics and rejects capability-plan drift before provider
acquisition or workflow execution. Existing profile schema/version and Judge
workflow version remain unchanged; checkpoint dependency fingerprints include
the profile fingerprint transitively.

### S1 — Durable File / Attachment Layer

Status: **complete on master**.

`/attach <path>` is an explicit user-initiated import. It creates one
canonical Turn and no Execution, snapshots exact raw bytes into
FinHarness-owned content-addressed storage, and persists immutable Attachment
metadata linked to the Session and Turn. `attachmentId` is distinct from the
SHA-256 `contentHash`; repeated identical bytes reuse one blob but create
distinct Attachment identities. Source paths are redacted to `/attach [file]`
before Turn and journal persistence, and attachment bytes do not enter model
context, Evidence, Artifacts, or any financial workflow.

### S2 — Workspace + File Capability

Status: **complete on master**.

S2 treats “workspace” as the active Session-scoped view of existing
FinHarness-owned Attachments. It adds no durable Workspace model, workspace
tables, migration, or second file identity. The single application capability
composition contains the existing eight financial registrations plus these
three raw-resource capability IDs:

```text
workspace.list-attachments
attachment.describe
attachment.read
```

The exact production grant is:

```text
command.files -> workspace.list-attachments
```

`attachment.describe` remains registered and `attachment.read` is granted only
to the explicit document-index principal. The session-scoped adapter captures
the trusted active `sessionId` in `buildContext(db, config, { sessionId })` and
rejects caller-supplied scope, paths, and content-hash locators through strict
tool schemas. It checks Session ownership before `AttachmentStore.readContent()`;
unknown and cross-Session resources fail closed at the not-found boundary, and
blob/integrity errors retain their existing identities.

The `/files` vertical slice lists safe metadata through the full authority path:

```text
/files -> command.files -> CapabilityGateway -> workspace.list-attachments
       -> ToolRuntime -> Session-scoped Attachment tool -> AttachmentStore
```

It creates one Turn, zero Executions, zero ModelCalls, and zero financial
provider calls. `/attach <path>` remains explicit user-controlled host
filesystem ingestion and does not use the capability gateway. Document
understanding, parsing, retrieval, and context injection are outside S2.

### S3 — Document Understanding / Retrieval

Status: **complete in the current implementation**.

S3 adds a domain-independent `@harness/document` package and durable
versioned `documents` and `document_chunks` tables. `/doc-index <attachmentId>`
uses only the active Session's `attachment.read` capability, extracts supported
local PDF/UTF-8 text/Markdown/JSON/CSV/TSV content, chunks it deterministically,
and persists immutable provenance. `/doc-search <query>` uses only the active
Session's `document.search` capability and returns bounded lexical candidates
with Attachment/Document/Chunk citations.

Document identity is deterministic and idempotent over the source Attachment,
content hash, exact parser version, and FinHarness pipeline version. One
Attachment may retain different derivations across pipeline versions.
Persistence validates source and Turn ownership, source hashes, chunk hashes
and IDs, ordinals, counts, conflicts, and restart behavior. `textHash` is
provenance over the normalized pre-chunk extraction stream, which is not stored
separately; re-indexing under the same pipeline still detects changes to it as
an immutable conflict. S3 does not add OCR, Office parsing, HTML, network fetch,
embeddings, vector search, Evidence writes, Context injection, or model calls.

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
resume semantics. R2C1 then migrated Screen, and R2C2 completes the Judge
migration and capability-semantic resume boundary.

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

/attach
implemented, explicit user file import; not a capability or document parser

/files
implemented, current Session attachment metadata listing through capabilities

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

## Current T milestone

### T1 — Evidence Acceptance + Provenance

Status: **complete in the current implementation**.

`@harness/evidence` defines `EvidenceCandidate`, `evidence-policy-v1`, and a
deterministic policy fingerprint. Verified financial observations become
candidates through an adapter and are checked again by the existing financial
verifier before acceptance. Their provider origin, complete metadata,
verification result, retrieval time, and acceptance time are retained per
Execution. The policy never derives `validAt` from `dataAsOf`.

The immutable `evidence` content row remains deduplicated by content hash,
ticker, and source. `run_evidence` remains the membership authority and stores
the acceptance identity and provenance. Execution-scoped reads return the
accepting Execution in `Evidence.runId`; historical rows are explicitly marked
`legacy-v0` with acceptance details left unknown. Document search hits and
citations can be represented as typed candidates, but T1 does not persist them
or change `/doc-search` lifecycle behavior.

T1 does not add Claim policy, Counterpoint storage, Claim Graph edges, or Judge
release checks.

### T2 — Claim Grounding + Durable Claim Model

Status: **complete in the current implementation**.

Bull model output now uses a strict Claim proposal with explicit Evidence links
and no model-owned `singleMetric`. `claim-policy-v1` checks execution-scoped
Evidence membership, allowed and seen scope, link parity, response coverage,
exact CitedFigure paths and values, and literal `%`, `x`, and `bps` statement
assertions. Code derives `singleMetric`. Migration `0018` stores full grounding
and policy identity on canonical Claims. Historical rows and Judge checkpoints
remain readable without fabricated links; projection repair is idempotent for
current and historical Claims. Judge nodes, workflow version, capabilities,
verdict scoring, and artifact kinds are unchanged.

### T3 — Counterpoint Grounding + Durability

Status: **implemented in the current worktree pending source review**.

Bear model output now uses a strict proposal schema with Evidence links and
optional CitedFigures for each Counterpoint. `counterpoint-policy-v1` checks
targets, allowed/seen/response Evidence scope, execution membership, link
integrity, and numeric assertions against linked CitedFigures. Code owns the
source-node-scoped IDs and policy fingerprint. Migration `0019` stores complete
canonical Counterpoints per Execution, and ExecutionStore exposes the same
fail-closed projection as CounterpointStore.

Current checkpoints keep model proposals separate from grounded Counterpoints;
resume and projection repair restore full durable rows idempotently without
model calls. Historical checkpoints remain readable without fabricated T3
grounding. Specialist contexts preserve all current Evidence, link, figure,
identity, and policy fields. `BEAR_CASE` keeps its existing kind and includes
the round-one grounded points; conditional re-challenge points are also
durable. The 15-node Judge graph, workflow version, capability plan, verdict
scoring, and artifact kinds are unchanged. T4 Claim Graph and T5 release
integrity remain future work.

## Maintenance policy

Update this file when:

- a major architecture PR merges;
- the current milestone changes;
- the next milestone changes materially;
- a command changes between implemented and stub status.

Do not create a new progress folder or per-PR status file. Git history records
previous versions; [`docs/ROADMAP.md`](ROADMAP.md) owns future detail.
