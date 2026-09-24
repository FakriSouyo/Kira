# Kira Roadmap

> Canonical future sequence. For mutable implementation status, see [PROGRESS.md](PROGRESS.md). For implemented architecture, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Product direction

Kira is a reusable financial research engine with an evidence-backed research
layer. Its current product direction is IDX-oriented financial research:
explicit workflows acquire and verify data, code enforces integrity, and
durable state makes context, evidence, artifacts, and decisions inspectable.

> LLMs propose. Data proves. Code verifies. Context persists. Kira decides.

The CLI is Kira's first host adapter, not the engine boundary. The target is a
shared host-neutral engine that future Desktop and Web surfaces can consume
without reimplementing Judge, Session, Context, Evidence, capabilities, or
lifecycle behavior. This is architecture direction; the current implementation
still has significant application/runtime composition in apps/cli.

## Documentation status vocabulary

Every statement in this roadmap is one of:

- **Current fact** — supported by the current implementation; master status is
  identified explicitly where relevant.
- **Future direction** — intended product or architecture direction, not yet implemented.
- **Not yet locked design** — a future decision whose exact types, schemas, APIs, or package layout remain open.

The roadmap locks sequencing and intent. Future implementation details remain
subject to source-driven design review.

When a milestone completes, this document keeps its durable architectural
summary and moves mutable implementation status to `docs/PROGRESS.md`. Detailed
future sections are expanded only as their dependencies become actionable;
completed milestones are not used to imply that later production migrations
already exist.

## Canonical high-level sequence

```text
COMPLETE ON MASTER

A-P
Q1
Q2
R1
R2A
R2B
R2C1
R2C2
S1
S2
S3
T1 Evidence Acceptance + Provenance
T2 Claim Grounding + Durable Claim Model
T3 Counterpoint Grounding + Durability
T4 Claim Graph Core
T5 Judge Integration + Release Integrity
KA Kira Identity Surface + Documentation Governance
UA1 Host-neutral Capability Runtime Extraction
UA2 Host-neutral Workflow Trace Extraction

CURRENT

UA Kira Engine Extraction
UA3 Host-neutral Screen Workflow Extraction

THEN

KB Internal Kira Identity Migration

THEN

U Research Composition / Product Completion
U1 Reusable Research Subgraph
U2 /research
U3 /compare
U4 /challenge
U5 /investigate
U6 /screen maturation
U7 /search maturation
U8 Conversation 2.0

FUTURE DECISION INTELLIGENCE

V Risk Committee
W Research Graph
X Decision Journal
Y Outcome Tracking + Reflection

FUTURE PRODUCT PLATFORM

Z
```

The sequence intentionally combines architecture evolution with user-visible
research capability maturation. Discovery and design for later milestones may
begin earlier, but production implementations must not bypass the dependency
boundaries established by earlier milestones.

## UA slice selection

**Selected slice:** UA3 — Host-neutral Screen Workflow Extraction.

UA1 — Host-neutral Capability Runtime Extraction and UA2 — Host-neutral
Workflow Trace Extraction are complete on master. UA3 moves the existing
host-neutral Screen application workflow into packages/engine (@harness/engine).
The CLI retains Screen argument parsing and rendering; the workflow invokes the
existing authorized `financial.screen` capability and preserves the current
filtering, provider order, and ten-result limit. UA3 does not complete engine
extraction.

UA4 and later slices remain provisional and unselected. Before each slice,
perform a fresh source audit and review its exact scope. This roadmap does not
lock future APIs, filenames, classes, schemas, package boundaries, or migration
behavior.

## Completed foundation — A-P, Q1, Q2, R1, R2A, R2B, R2C1, R2C2, S1, S2, S3, T1-T5 on master

The following milestones are complete in the current implementation:

- **A-P — Canonical lifecycle, context, evidence, artifacts, financial snapshots, and resumability:** Session → Turn → Execution, journal linkage, SessionWorkingContext, bounded context assembly, evidence and artifact authority, the provider-neutral financial seam, VerifiedFinancialSnapshot, durable profiles and checkpoints, and same-Execution `/judge` resume.
- **Q1 — Model Runtime + Provider Directory:** provider-neutral model runtime contracts, immutable provider/model directory snapshots, adapter boundaries, safe fingerprints, prepared calls, invocation metadata, and mock parity.
- **Q2 — Durable Model Selection + Production Integration:** append-only Session model intent, immutable runtime-plan composition, plan-aware context budgeting, actual model provenance, and runtime-plan-compatible Judge resume.
- **R1 — Typed Tool Runtime:** explicit typed `ToolDefinition` values, one-shot validation and execution, lifecycle observation, cancellation fencing, and explicit CLI financial adapters.
- **R2A — Capability Contracts + Immutable Registry:** domain-neutral capability descriptors, registration contracts, immutable deterministic discovery, duplicate/identity validation, and trusted lookup of explicit tool bindings.
- **R2B — Deterministic Policy + Capability Gateway:** explicit caller principals, exact-match immutable grants, deterministic policy evaluation, scoped authorized discovery, registry/policy consistency validation, and lookup-only gateway delegation to `ToolRuntime`.
- **R2C1 — Financial Capability Composition + Screen Migration:** all eight existing financial tools registered with provider-neutral descriptors, explicit least-privilege `command.screen` authorization, and production `/screen` execution through the capability gateway.
- **R2C2 — Judge Capability Migration + Durable Resume Semantics:** Judge financial operations execute through explicit workflow principals and the capability gateway, and Judge profiles pin a deterministic capability plan whose fingerprint participates in durable resume compatibility.
- **S1 — Durable File / Attachment Layer:** explicit `/attach` imports one user-selected local file into immutable Kira-owned content-addressed storage, associates safe metadata with the canonical Session/Turn lifecycle, and keeps raw bytes outside SQLite without creating an Execution or entering model context.
- **S2 — Workspace + File Capability:** one application-wide capability registry/policy/gateway/runtime composes financial and raw Attachment tools; strict Session-scoped `workspace.list-attachments`, `attachment.describe`, and `attachment.read` tools are registered. S2 introduced `command.files -> workspace.list-attachments`; `/files` lists current-Session metadata with one Turn and no Execution or ModelCall.
- **S3 — Document Understanding / Retrieval:** explicit `/doc-index` derives versioned Documents from verified Attachment bytes, and `/doc-search` returns bounded local lexical hits with citations. S3 is complete on master.
- **T1 — Evidence Acceptance + Provenance:** versioned deterministic Evidence Policy accepts verified financial observations, persists per-Execution acceptance/provenance on `run_evidence`, preserves immutable content deduplication, and exposes typed Document search candidates without persisting them.
- **T2 — Claim Grounding + Durable Claim Model:** current Bull proposals carry explicit Evidence links; deterministic Claim Policy validates scoped Evidence and literal numeric assertions, derives `singleMetric`, and persists complete canonical grounding with historical checkpoint repair.
- **T3 — Counterpoint Grounding + Durability:** current Bear proposals carry per-Counterpoint Evidence links; deterministic Counterpoint Policy validates scope, targets, links, and numeric figures, and stores canonical Counterpoints per Execution with restart repair and historical compatibility.
- **T4 — Claim Graph Core:** a deterministic execution-local graph is reconstructed from canonical Claim and Counterpoint stores; only declared `Counterpoint.targetClaimId` targets are edges.
- **T5 — Judge Integration + Release Integrity:** current Judge profiles pin release semantics, validate checkpoint/store/graph parity before completion, and publish existing artifacts plus a restart-repairable immutable graph release receipt after completion.

The current Judge graph remains the source of truth: it has 15 stable nodes,
`JUDGE_WORKFLOW_VERSION` remains `2`, and no obsolete historical Judge graph is
restored by this roadmap.

## R2 — Capability Runtime

R2 is decomposed so that capability identity, authorization, and production
integration do not become one unreviewable boundary.

### R2A — Capability Contracts + Immutable Registry

Status: **complete on `master`**.

R2A answers:

> What executable capabilities are registered and discoverable?

The `@harness/capability` package provides:

- `CapabilityDescriptor` — safe public, data-only metadata with `id`, `displayName`, `description`, `kind: 'tool'`, and `integrationId`;
- `CapabilityRegistration<TTool>` — a descriptor bound internally to an explicit `ToolDefinition`;
- `CapabilityRegistry` — immutable registration and discovery truth;
- `CapabilityRegistryError` — typed `UNKNOWN_CAPABILITY`, `DUPLICATE_CAPABILITY`, and `INVALID_CAPABILITY_REGISTRATION` failures.

The registry supports `list()`, `describe(id)`, and trusted lookup-only
`resolveTool(id)`. Discovery returns detached frozen descriptors ordered by
canonical capability ID. Construction rejects empty required fields, invalid
tool bindings, duplicate IDs, and descriptor/tool ID disagreement.

The authorities remain separate:

```text
CapabilityDescriptor
    = safe public discovery data

CapabilityRegistration
    = descriptor + explicit ToolDefinition binding

CapabilityRegistry
    = immutable registration/discovery truth

resolveTool()
    = trusted lookup-only binding access

ToolRuntime
    = execution authority
```

R2A is not authorization, execution, policy, workflow scheduling, provider
routing, persistence, MCP integration, or durable capability-plan semantics.
Financial tools have not been moved into the registry, and Judge/Screen
production paths have not been migrated.

### R2B — Deterministic Policy + Capability Gateway

Status: **complete on `master`**.

R2B answers:

> Who may use which registered capability?

The implemented boundary is:

```text
Caller
  |
  v
explicit caller identity
  |
  v
Capability Gateway
  |          |
  |          +--> Capability Registry
  |
  +-------------> Capability Policy
  |
  v
explicit ToolDefinition
  |
  v
ToolRuntime
```

R2B provides `CapabilityPrincipal`, immutable `CapabilityGrant` allowlists,
`CapabilityPolicy`, focused policy/access errors, and `CapabilityGateway` in
`@harness/capability`. Policy configuration rejects empty IDs, duplicate
principal grants, and duplicate capability IDs. Policy evaluation allows only
exact principal/capability matches; unknown principals and ungranted
capabilities deny by default. Policy listings are detached, frozen, and sorted
by principal ID and capability ID.

The gateway validates every policy capability against its supplied registry at
construction. Its public `list(principal)` and `describe(principal, id)`
methods expose only authorized data-only descriptors. Its `invoke(...)` path
validates the explicit principal, preserves unknown-versus-denied errors,
looks up the registered explicit `ToolDefinition`, and delegates exactly once
to `ToolRuntime`. The gateway does not expose `resolveTool()`, validate tool
I/O, execute tools directly, schedule workflows, or replace runtime events.
`ToolRuntime` remains the sole execution authority and downstream runtime or
domain errors retain their identity.

R2B is not production financial migration, Judge/Screen migration, durable
capability execution plans, capability-aware resume semantics, persistence,
MCP integration, roles, wildcards, conditional policy, or an autonomous tool
loop. `CapabilityRegistry` is not authorization, `CapabilityGateway` is not
`ToolRuntime`, and `resolveTool()` is not an authorization boundary.

### R2C1 — Financial Capability Composition + Screen Migration

Status: **complete**.

R2C1 registers the existing financial operations as explicit, provider-neutral
capabilities and routes the first production migration through the R2 policy
and gateway boundary. The registered tool IDs are
`financial.company-report`, `financial.quarterly-financials`,
`financial.screen`, `financial.daily-transaction`, `financial.foreign-flow`,
`financial.news`, `financial.filings`, and `financial.sentiment`.

The implemented Screen composition is:

```text
/screen
   |
   v
command.screen
   |
   v
CapabilityGateway
   |          |
   v          v
Policy     Registry
              |
              v
       financial.screen
              |
              v
         ToolRuntime
              |
              v
   FinancialDataProvider
```

Descriptors use provider-neutral integration identity `financial-data`, and
every registration binds the existing `ToolDefinition` created by
`createFinancialTools(provider)` rather than recreating provider adapters. The
registry knows all eight capabilities, while `command.screen` is granted only
`financial.screen`. `HarnessContext` exposes `capabilityGateway`; R2C2 completes
the Judge migration so raw `toolRuntime` and `financialTools` are no longer
part of that context. Screen's filtering, ranking, result rendering, and
ten-row limit are unchanged.

### R2C2 — Judge Capability Migration + Durable Resume Semantics

Status: **complete on `master`**.

R2C2 migrates Judge's required operations through explicit capability
principals, policy, gateway, and `ToolRuntime` without inferring authorization
from `WorkflowNode.executor`, specialist skills, persona, model output, or
workflow ownership. The implemented mappings are:

```text
identify-company
    -> financial.company-report

fetch-financials
    -> financial.quarterly-financials

fetch-market-data
    -> financial.daily-transaction
    -> financial.foreign-flow

fetch-news
    -> financial.news
    -> financial.filings
    -> financial.sentiment
```

The current production authority boundary is explicit:

```text
/screen -> CapabilityGateway -> ToolRuntime
/judge  -> workflow.judge.* principal -> CapabilityGateway -> ToolRuntime
```

Judge uses four explicit principals: `workflow.judge.identify-company`,
`workflow.judge.fetch-financials`, `workflow.judge.fetch-market-data`, and
`workflow.judge.fetch-news`. The resulting seven-capability grant set is
scoped to the operation each principal performs; `command.screen` remains
granted only `financial.screen`.

`CapabilityPlan` schema version 1 is a deterministic, secret-free, data-only,
deeply immutable projection of the authorized capability descriptors for those
principals. Its fingerprint is stored in new Judge execution profiles. Resume
planning rejects capability-less historical Judge profiles and rejects a
different capability-plan fingerprint before provider acquisition or workflow
execution. The existing generic profile schema and Judge workflow version are
unchanged; checkpoint dependency fingerprints include the profile fingerprint
transitively.

## Authorization boundaries

These distinctions are architectural invariants:

```text
WorkflowNode.executor != authorization
Subagent skill != executable permission
Skill content != capability grant
CapabilityRegistry != policy
CapabilityGateway != ToolRuntime
ToolRuntime != workflow scheduler
```

`WorkflowNode.executor` remains audit ownership metadata only. A subagent does
not receive executable capabilities merely because of `manifest.skills`,
`executor.id`, persona, agent name, or workflow ownership.

## Why the milestone ordering exists

The dependency order is intentional:

```text
R
controlled executable capabilities

S
durable external/user-provided knowledge inputs

T
stronger evidence and claim semantics

U
user-visible research products composed from those foundations

V-Y
higher-order decision and longitudinal research intelligence

Z
product surfaces over the mature shared core
```

Capability authority must be explicit before file, document, or external
knowledge inputs become reusable capabilities. Durable attachments and document
understanding should precede stronger evidence and claim relationships. Those
foundations then support complete research products, decision intelligence, and
finally cross-surface product delivery.

## S — Files & Documents

S is knowledge-input work. It is deliberately distinct from Evidence, Artifacts,
Context, and Memory. S1-S3 and T1-T5 are complete on master. The current and
next slice sequence is maintained in the canonical high-level sequence above.

### S1 — Durable File / Attachment Layer

Status: **complete on master**.

The implemented `/attach <path>` command is explicit user ingestion, not a
Capability, ToolDefinition, agent-selected file read, workspace browser, or
document parser. It creates one canonical Turn and no Execution. The source
file is copied into Kira-owned content-addressed storage and the durable
metadata records only the safe basename, media type, byte size, SHA-256 hash,
attachment identity, and Session/Turn association.

```text
user file
   |
   v
durable attachment identity
   |
   +--> content hash
   +--> metadata
   +--> Session/Turn association
```

Attachment metadata and raw bytes are immutable in S1. `attachmentId` is a
durable record identity and is distinct from `contentHash`; identical bytes
may back multiple Attachment records while sharing one durable blob. Content
is integrity-checked on read. The original source path is transient ingestion
input and is not persisted in attachment metadata, the journal, or Turn input.

```text
Attachment != Document != Evidence != Artifact != Context
```

`AttachmentStore` is raw-file identity, metadata, and durable-byte authority.
`ArtifactStore` remains semantic research-output authority. S3 adds a separate
Document authority, and attachment bytes do not automatically enter Context,
Evidence, Artifacts, or any model prompt.

### S2 — Workspace + File Capability

Status: **complete on master**.

S2 is the controlled raw-resource slice built on the R2 capability system.
“Workspace” is only the active Session-scoped view of existing Attachments;
there is no durable Workspace model, workspace table, migration, or second
file identity. The registered IDs are:

```text
workspace.list-attachments
attachment.describe
attachment.read
```

The application has one combined financial/attachment registry, policy,
CapabilityGateway, and ToolRuntime. The only production file grant is:

```text
command.files -> workspace.list-attachments
```

`attachment.describe` remains registered and `attachment.read` is granted only
to the explicit document-index principal. `/files`
lists safe metadata for the active Session and creates one Turn, zero
Executions, zero ModelCalls, and no financial provider calls. `/attach` remains
explicit host-file ingestion outside the capability path. Cross-Session
metadata and byte access fail closed as not-found, and AttachmentStore
integrity errors retain their identity. S2 itself does not add parsing,
retrieval, Document objects, or model context injection.

### S3 — Document Understanding / Retrieval

Status: **complete on master**.

S3 is the explicit Attachment-to-Document boundary. The new
`@harness/document` package detects and extracts only local PDF, UTF-8 text,
Markdown, JSON, CSV, and TSV; rejects unsupported, binary, malformed, empty,
and over-limit content; normalizes text; and chunks it deterministically.
Verified PDF magic takes precedence over advisory filename and media type. PDF
chunks never cross pages, text chunks retain line ranges, Markdown chunks retain
the active heading section, and every Document/Chunk has stable SHA-256
identity and content hashes.

The exact pinned PDF.js parser and current document extraction/chunking pipeline
version participate in Document identity. One Attachment can have distinct
derivations across versions. `textHash` records the normalized text before
chunking; that stream is not stored separately, so read-time validation checks
the persisted Document/chunk identities, hashes, ordinals, and counts while
re-indexing detects a changed `textHash` as an immutable conflict.

`documents` and `document_chunks` are durable SQLite authorities with strict
schema versions, Session/Attachment/Turn ownership validation, ordered chunk
constraints, immutable conflict detection, idempotent re-indexing, and restart
coverage. `document.search` performs local case-insensitive exact-phrase and
token-coverage retrieval with stable ties and a twenty-result cap. The CLI
surfaces are:

```text
/doc-index <attachmentId>
  -> command.doc-index -> attachment.read -> extract/chunk -> DocumentStore

/doc-search <query> [--document <id>] [--limit N]
  -> command.doc-search -> document.search -> citations
```

S3 has no OCR, DOCX/XLSX/PPTX/HTML parsing, remote fetch, embeddings, vector
database, Evidence persistence, Context injection, or model call. Documents
remain distinct from Attachments, Evidence, Artifacts, and Context.

Implemented direction:

```text
Attachment
   |
   v
Document
   |
   v
structured pages/sections/chunks
   |
   v
retrieval
   |
   v
citation/provenance
   |
   v
citation/provenance candidate
```

## T — Evidence Policy + Claim Graph

T is split into independently reviewable implementation slices:

```text
T1 Evidence Acceptance + Provenance
T2 Claim Grounding + Durable Claim Model
T3 Counterpoint Grounding + Durability
T4 Claim Graph Core
T5 Judge Integration + Release Integrity
```

Status: **T1-T5 complete on master**. See the canonical high-level sequence
above for the current and next slices.

### T1 — Evidence Acceptance + Provenance

T1 adds `EvidenceCandidate` and an explicit `evidence-policy-v1` contract with
a deterministic fingerprint. Financial candidates are adapted only from
`PresentFinancialObservation` values and rechecked through the existing
`verifyFinancialObservation` authority. Accepted Evidence retains provider
origin, full `FinancialDataMetadata`, `ObservationVerification`, retrieval
time, and acceptance time. `dataAsOf` remains provenance and does not become
`validAt`.

`evidence` remains the immutable content authority, deduplicated by content
hash, ticker, and source. `run_evidence` remains execution membership and now
stores the policy identity, candidate kind, source origin, relevant times, and
structured provenance for each accepting Execution. Execution-scoped reads
set `Evidence.runId` to that accepting Execution. Pre-T1 memberships are
returned with explicit `legacy-v0` provenance and unknown acceptance fields.

S3 `DocumentSearchHit` / `DocumentCitation` values can be wrapped as typed
Evidence candidates when a future research Execution supplies scope. T1 does
not make `/doc-search` persist Evidence or create an Execution/ModelCall.

### T2 — Claim Grounding + Durable Claim Model

`ClaimProposalSchema` is the current Bull model-write contract and requires
explicit producer-supplied Evidence relationships. `ClaimSchema` remains
backward-readable for stored Claims, artifacts, and Judge checkpoints. The
model cannot author `singleMetric` or the `claim-policy-v1` identity. Claim
Policy checks link/ID parity, response Evidence coverage, allowed and seen
scope, execution-scoped membership, and CitedFigure paths and values. It also
requires a matching figure for literal `%`, `x`, and `bps` statement assertions;
period labels alone do not trigger that rule. This is deterministic grounding,
not semantic support classification.

Migration `0018` preserves `citedFigures`, code-derived `singleMetric`,
`evidenceLinks`, and Claim Policy identity in canonical `claims`. Historical
rows and checkpoints remain readable without invented T2 metadata; projection
repair restores both current and historical Claims. The 15-node Judge graph,
workflow version, capability plan, verdict scoring, and artifact kinds are
unchanged.

### T3 — Counterpoint Grounding + Durability

Status: **complete on master**.

Current Bear model output uses a strict proposal schema with per-Counterpoint
Evidence IDs, explicit Evidence links, and optional CitedFigures. The model
cannot supply Counterpoint identity or Policy metadata. Historical Bear output
and the existing `BEAR_CASE` artifact kind remain readable. `counterpoint-policy-v1`
checks target Claim membership, response/selected/seen Evidence scope,
execution-scoped Evidence membership, per-point Evidence/link parity, and
numeric assertions against linked CitedFigures. Code assigns deterministic
source-node-scoped identities and a policy fingerprint.

Migration `0019` adds the canonical `counterpoints` table with immutable
execution identity, source node, target Claim, full Evidence/link/figure data,
and Policy identity. The canonical execution projection and
`CounterpointStoreSqlite` share one fail-closed row mapper. Current checkpoints
restore proposal responses and grounded Counterpoints separately; projection
repair is idempotent and does not call a provider. Historical checkpoints keep
their old Counterpoint shape and are never upgraded by inventing grounding.
Typed Bear-to-Bull and Judge contexts retain the complete grounded records.
`BEAR_CASE` projects the round-one grounded points while the durable store also
retains conditional re-challenge points. The 15-node Judge graph, workflow
version, capability plan, deterministic verdict scoring, and artifact kinds
remain unchanged.

### T4 — Claim Graph Core

T4 adds an execution-local typed Claim Graph as a deterministic projection of
the canonical `ClaimStore` and current `CounterpointStore` authorities. Nodes
remain owned by those stores. `Counterpoint.targetClaimId` is the sole durable
Claim/Counterpoint relationship and is projected as
`Counterpoint --targets--> Claim`; no graph edge table or duplicate migration
is needed. `ClaimGraphReaderSqlite` reconstructs graphs from durable rows, and
`ExecutionArtifacts` exposes the same result through the shared pure builder.

Historical Claims remain nodes without fabricated T2 metadata, while historical
pre-T3 Bear Counterpoints are not fabricated as graph nodes. Claim proposals do
not name a specific Counterpoint, so T4 creates no rebuttal relationships.
Reads reject cross-Execution rows, duplicate identities, missing targets, and
corrupt canonical projections. T4 does not alter Judge artifacts, release
semantics, the 15-node Judge graph, or workflow version 2.

### T5 — Judge Integration + Release Integrity

New lifecycle Judge profiles pin a deterministic release contract for the
current Claim and Counterpoint policies, Claim Graph contract, and existing
artifact kinds/schema. Before completion, T5 validates final checkpoint data
against canonical Claim/Counterpoint rows and their complete execution-local
graph. After completion it publishes the existing three artifacts and an
immutable release receipt that maps each artifact to the graph subset it
represents. Startup reconstructs and repairs partial artifact/receipt
publication without model/provider calls. Historical pre-T5 profiles retain
legacy artifact semantics and do not receive fabricated receipts. T5 leaves
the 15-node Judge workflow, version 2, and artifact v1 payload schemas intact.

T strengthens explicit relationships among Evidence, Claims, Theses,
Counterclaims, and Artifacts:

```text
Evidence A --supports--> Claim 1
Evidence B --contradicts--> Claim 1
Claim 1 --supports--> Thesis A
Claim 2 --challenges--> Thesis A
```

Later T slices may add typed `supports`, `contradicts`, `qualifies`,
`depends_on`, and `derived_from` relationships as source explicitly supports
them. T1's Evidence Policy accepts scoped candidates, and T2 records explicit
Claim Evidence relationships. T4 currently projects only the declared
Counterpoint target relation; other graph relationships remain future work.

## U — Research Composition + Product Completion

U is a milestone family, not one implementation PR:

```text
U1 - Reusable Research Subgraph Foundation
U2 - /research
U3 - /compare
U4 - /challenge
U5 - /investigate
U6 - /screen maturation
U7 - /search maturation
U8 - Conversation 2.0
```

Each U2-U8 capability should be implemented and reviewed as an independent
vertical slice, with smaller architecture PRs where necessary. Workflow graphs,
node counts, package topology, specialist assignments, artifact schemas, and
public APIs are not finalized by this roadmap.

### `/judge` current role

Current fact: `/judge` is the mature research vertical used to establish and
validate Kira lifecycle, evidence, specialist-context, artifact,
workflow, model-runtime, and resumability architecture. It is not intended to
be Kira's only research product. The current 15-node Judge graph remains
source truth.

### U1 — Reusable Research Subgraph Foundation

Future goal: avoid building every research command as an independent monolithic
workflow. Directional reusable operations may include company resolution,
financial/market/news/filing retrieval, verified snapshot construction,
evidence selection, fundamental/growth/valuation/risk analysis, source
verification, period normalization, and contradiction resolution. Fixed APIs,
node graphs, and package locations are not locked.

### U2 — `/research`

Current status: **stub**.

Future `/research` is a non-debate, evidence-backed company research product;
`/research` is not `/judge`. Directional output may cover company overview,
financial health, growth, profitability, valuation, market position, recent
developments, risks, open questions, evidence coverage, data freshness, and
confidence.

Directional flow:

```text
resolve company
     |
select required data/capabilities
     |
verified financial input
     |
evidence collection
     |
fundamentals / market / valuation / risk / developments
     |
claim verification
     |
research product
```

Exact output schemas are not locked.

### U3 — `/compare`

Current status: **stub**.

Future `/compare` should normalize comparable companies before comparison; it
should not produce unrelated reports and ask an LLM to compare them.

```text
Company A
Company B
Company C
    |
    v
comparable normalization
    |
    +--> periods
    +--> units
    +--> metrics
    +--> freshness
    |
    v
comparative research
```

Possible output includes comparable metrics, quality/growth/valuation
differences, risk trade-offs, strengths, weaknesses, normalization warnings,
and evidence coverage. Exact metrics and workflow graph are not locked.

### U4 — `/challenge`

Current status: **stub**.

Future `/challenge` stress-tests an explicit thesis or research claim; it is
not simply “run Bear”.

```text
parse thesis
   |
extract claims
   |
retrieve supporting and contradicting evidence
   |
verify sources
   |
identify unsupported assumptions and failure conditions
   |
produce challenge result
```

Possible outputs include the strongest supporting case, strongest counter-case,
unsupported assumptions, contradictions, failure conditions, and evidence that
would change the thesis. Artifact shape is not locked.

### U5 — `/investigate`

Current status: **stub**.

Future `/investigate` is a scoped investigation workflow:

```text
scope question
   |
retrieve filings/news/financial observations
   |
build timeline
   |
rank primary evidence
   |
detect contradictions
   |
assess materiality
   |
findings and unresolved questions
```

Possible outputs include a timeline, primary sources, claims, contradictions,
material impact, confidence, and unresolved issues. Exact nodes are not locked.

### U6 — `/screen` maturation

Current status: **implemented**.

Future maturation may add criteria parsing, universe selection, deterministic
hard filters, deterministic ranking, selective verification, and a richer
screen research product. Hard filters, ranking rules, and numeric calculations
remain deterministic; the LLM must not freely invent screening scores.

### U7 — `/search` maturation

Current status: **implemented**.

Future maturation may retrieve across Evidence, Documents, and Artifacts or
research products using keyword retrieval, semantic retrieval, deduplication,
source quality, freshness/validity, and ranking. `/search` is not unrestricted
arbitrary internet browsing; any external web access must remain an explicit
capability.

### U8 — Conversation 2.0: Retained Conversational Continuity and Composition

Current fact: conversation infrastructure already exists. It includes
`ConversationJournal`, `ConversationController`, `SessionWorkingContext`,
artifact-aware context retrieval, `ContextPacket`, `ContextSnapshot`, token
budgeting, same-session research-context follow-up, streaming output, and
restart-safe durable research context.

Current limitation: production conversation preparation explicitly passes
`conversationHistory: ''`. Kira therefore does not yet provide full
general retained multi-turn transcript injection to the model.

Future Conversation 2.0 may add bounded recent turns, summaries, reference
resolution, relevance-aware retrieval, research artifact and document context,
token-budgeted composition, and auditable ContextSnapshots. It must remain
bounded, relevance-aware, token-budgeted, and auditable rather than blindly
injecting the raw transcript.

Conversation-derived claims remain conversational/user context unless verified
through an explicit evidence-producing research workflow.

## V — Risk Committee

Future direction: structured multi-dimensional risk assessment, not merely the
Bear agent. Possible dimensions include financial, valuation, market, business,
evidence, and freshness risk. Possible outputs include risk factors, severity,
supporting evidence, contradictions, failure scenarios, and monitoring
triggers. Specialist composition and schema are not locked.

## W — Research Graph

Future direction: durable long-term research state linking subjects, claims,
evidence, artifacts, investigations, and research products.

```text
BBRI
 |
 +-- Claim A
 |    +-- Evidence
 |    +-- superseded by Claim B
 |
 +-- Research report
 +-- Investigation
 +-- Risk assessment
```

The Research Graph is not the Context Engine. Context consumes selected
projections from durable research state:

```text
ResearchGraph != ContextPacket
ResearchGraph != SessionWorkingContext
```

The database model is not locked.

## X — Decision Journal

Future direction: explicit durable decisions and their reasoning context.
Conceptual fields may include decision, date, research references, claim
references, assumptions, conditions, and confidence.

```text
Decision:
Watch BBRI

Rationale:
valuation attractive but margin risk remains

Conditions:
reconsider if condition X changes
```

```text
DecisionJournal != conversation history
```

The schema is not locked.

## Y — Outcome Tracking + Reflection

Future direction:

```text
research / decision
       |
       v
observed later outcome
       |
       v
comparison with original assumptions
       |
       v
explicit reflection
```

Reflection may ask which assumptions were correct, which evidence was missing,
which signals mattered, and what changed after the decision. This is explicit
durable research output/state, not self-training model weights, autonomous model
modification, or uncontrolled long-term learning.

## Z — Product Platform

The product-platform family is:

- **Z1 — Application Host / API Boundary:** Future direction: shared runtime/business logic behind a service boundary rather than duplicated per surface. Exact transport is not locked.
- **Z2 — Web Surface:** Future direction: a web product surface over the same canonical runtime and durable state; it does not own independent research logic.
- **Z3 — Desktop Host + Desktop Shell:** a future host/shell around shared Kira application logic, without duplicating lifecycle, context, or research implementations.
- **Z4 — Cross-Surface Integration / Final Polish:** final cross-surface integration for this roadmap generation, not a declaration that Kira can never receive another feature.

The desired consistency is:

```text
CLI
Web
Desktop
   |
   v
same Sessions
same Turns
same Executions
same Artifacts
same capabilities
same research products
same durable state
```

## Invariant ledger

These distinctions should remain visible in the appropriate canonical
documents:

```text
context != storage
context != full history
working context != ContextPacket
cache != memory
workflow != intelligence
agent != data source
LLM != calculator

provider response != provider cache
provider cache != normalized observation
normalized observation != VerifiedFinancialSnapshot
VerifiedFinancialSnapshot != Evidence
Evidence != Artifact
Artifact != Context
Context != Memory

Artifact != WorkflowNodeOutput
Artifact != ContextSnapshot
checkpoint/resume != provider cache reuse
checkpoint/resume != artifact reuse
checkpoint/resume != context replay
checkpoint/resume != journal replay

ConversationJournal != ConversationSummary
ConversationSummary != SessionWorkingContext
ConversationSummary != Evidence
SessionWorkingContext != ContextPacket
ContextPacket != Evidence
Evidence != Artifact
Artifact != ResearchGraph
ResearchGraph != DecisionJournal

skill != capability
executor metadata != authorization
registry != policy
gateway != ToolRuntime
```

## What this roadmap does not lock

The following remain future design work:

- exact U workflow node counts, package topology, specialist mapping, future artifact schemas, and public APIs;
- exact conversation-summary schema, Research Graph database model, and Decision Journal schema;
- exact desktop framework, web framework, and API transport;
- any future MCP adapter/client or autonomous tool loop.

This documentation PR creates no placeholder interfaces, packages, migrations,
runtime classes, or TODO implementation surfaces.

## Historical guardrails

Current source wins over historical design documents. The retired Phase 0-9
roadmap structures, obsolete specialist lists, obsolete persistence assumptions,
old UI assumptions, and obsolete 20-node Judge workflow are not canonical. The
current Judge definition has 15 nodes and remains authoritative.
