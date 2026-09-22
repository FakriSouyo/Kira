# FinHarness Architecture

This document describes the current runtime architecture and its invariants.
It is not a chronological implementation diary. The canonical roadmap is
[`docs/ROADMAP.md`](docs/ROADMAP.md), and current project status is
[`docs/PROGRESS.md`](docs/PROGRESS.md).

## System shape

```text
apps/cli
  explicit slash commands + natural-language conversation
          │
          ▼
packages/orchestrator + packages/routing
          │
          ▼
packages/context
  resolver → retrieval → validity → policy → assembler
          │
          ├───────────────┬─────────────────┐
          ▼               ▼                 ▼
packages/command   packages/subagent   packages/financial-data
WorkflowRunner     Bull/Bear/Judge     provider-neutral seam
          │               │                 │
          └───────────────┴─────────────────┘
                          ▼
     evidence / execution / session / conversation
                          │
                          ▼
                   packages/database
```

External seams are explicit: `packages/llm` owns model clients,
`packages/financial-data` owns the provider-neutral financial contract, and
`packages/sectors-api` is the current financial provider implementation.

## Model runtime — Q1 / Q2

`packages/llm` is the canonical model-runtime boundary. It separates logical
provider route, provider-owned model identity, adapter implementation, and wire
protocol:

```text
ProviderDirectory snapshot
  providerId + modelId + safe capabilities
              │
              ▼
        ModelRuntime
              │ prepareCall(route, controls)
              ▼
     PreparedModelCall
       one immutable route snapshot
              │
              ▼
        ModelAdapter
       OpenAI-compatible / Anthropic / mock
```

The directory is an immutable, detached composition snapshot. Replacing it
affects only later preparations; an existing prepared call retains its resolved
provider, model, adapter, protocol, endpoint identity, effective capabilities,
generation controls, and runtime fingerprint. A prepared call is one-shot and
never switches route internally. Compatibility retry/fallback orchestration
creates a separate prepared call for each attempt, so result metadata reports
the route that actually succeeded.

`ModelRuntimeDescriptor` is safe for audit or persistence: it contains no API
keys, session affinity IDs, request IDs, timestamps, functions, paths, mutable
SDK clients, or abort controllers. Its deterministic SHA-256 fingerprint is
based on canonical semantic JSON and changes with route, model, adapter,
protocol, endpoint identity, capabilities, and generation controls. API-key
rotation and request/session-affinity changes do not affect it.

The Q1 runtime exposes effective context, structured-output, and streaming
capabilities without making `@harness/llm` depend on the Context Engine. Native
provider structured-output support remains distinguishable from effective
runtime support because custom Responses endpoints may use text JSON plus local
Zod validation. Existing `LLMClientLike` value-only methods remain available;
result-bearing object/text and metadata-capable stream paths are provided by the
compatibility facade. Q2 connects these descriptors to durable Session model
selection, production Context capability resolution, and persistence.

### Durable model selection and execution plans — Q2

Model choice has four distinct authorities:

```text
default configuration
        ↓ initial composition
SessionModelSelection  ── durable user intent, per Session
        ↓ resolve
ExecutionRuntimePlan   ── primary/fallback semantic runtime snapshot
        ↓ invoke
ModelCall              ── actual successful route and usage audit
```

`SessionModelSelection` is append-only and versioned. It survives database
recreation, is isolated by Session, and session-local setters do not write
`config.json`. Legacy `research_sessions.provider/model` fields remain readable
and existing Sessions are backfilled as `source: legacy` selections.

The runtime plan is a pure, side-effect-free description of the selected route,
ordered fallback routes, effective capabilities, generation controls, and the
secret-free semantic runtime fingerprint. Logical provider identity remains
distinct from transport family, adapter, protocol, and model identity. A
selected OpenRouter route therefore retains logical provider `openrouter` while
using the `openai-compatible` adapter. API keys and private request/session
affinity are excluded from the fingerprint.

The production Context budget uses the capabilities of the exact runtime plan
for real providers. MainFinHarnessAgent and SubagentRuntime use result-bearing
runtime calls; durable ModelCall rows record the actual provider/model,
adapter, protocol, runtime fingerprint, and usage. Fallback still creates a
new one-shot PreparedModelCall per attempt, and successful metadata identifies
the route that actually succeeded.

New Judge execution profiles pin the semantic runtime-plan fingerprint while
remaining compatible with PR P profiles that contain only provider/model.
Resume validation still occurs before acquisition and allows credential
rotation when semantic runtime identity is unchanged. Q2 does not change the
15-node Judge graph or introduce a new checkpoint/resume lifecycle.

## Capability runtime — R2A, R2B, R2C1, and R2C2

R2A and R2B add the domain-neutral `@harness/capability` package. R2C1 consumes
that package in the CLI composition layer for the first production migration.
The package dependency direction remains deliberately small:

```text
@harness/command-judge
          |
          v
@harness/capability ----> @harness/tool-runtime
          |
          v
   @harness/shared
```

The implemented contracts are:

```text
CapabilityDescriptor
    = safe public data-only metadata

CapabilityRegistration<TTool>
    = descriptor + explicit ToolDefinition binding

CapabilityRegistry
    = immutable registration and discovery truth

resolveTool(id)
    = trusted lookup-only access to the registered ToolDefinition

CapabilityPrincipal
    = explicit caller identity with a stable non-empty ID

CapabilityGrant
    = immutable exact-match principal-to-capability allowlist

CapabilityPolicy
    = deterministic policy evaluation and safe grant discovery

CapabilityGateway
    = authorized discovery and lookup-only delegation boundary

ToolRuntime
    = execution authority
```

`CapabilityRegistry.list()` and `describe(id)` return detached frozen public
descriptors ordered by canonical capability ID. Construction validates required
descriptor fields, duplicate IDs, minimum tool-definition structure, and exact
descriptor/tool ID agreement. `resolveTool()` returns the registered explicit
`ToolDefinition`; it does not execute, invoke, wrap, schedule, authorize, or
otherwise become another runtime.

R2B adds immutable policy grants with exact matching, default denial for
unknown principals or ungranted capabilities, duplicate/empty-ID validation,
and deterministic frozen listings. `CapabilityGateway` validates policy IDs
against the registry at construction, exposes only authorized descriptors via
scoped discovery, and delegates an authorized explicit binding once to
`ToolRuntime`. Unknown capability failures remain distinct from access denial;
gateway code does not validate tool I/O or catch and replace downstream
runtime/domain errors.

R2A/R2B alone are not production financial migration, durable capability
execution plans, capability-aware resume compatibility, persistence, MCP
integration, roles, wildcards, conditional policy, or an autonomous tool loop.
`CapabilityRegistry` is not authorization, `CapabilityGateway` is not
`ToolRuntime`, and `resolveTool()` is not an authorization boundary.

### Financial capability composition and Screen migration — R2C1

The CLI application layer registers the eight existing financial tools under
their canonical IDs:

```text
financial.company-report
financial.quarterly-financials
financial.screen
financial.daily-transaction
financial.foreign-flow
financial.news
financial.filings
financial.sentiment
```

Each registration binds a safe data-only descriptor with integration identity
`financial-data` to the exact `ToolDefinition` produced by
`createFinancialTools(provider)`. No tool or provider wrapper is recreated.
`FinancialDataProvider` remains the provider-neutral domain seam, and Sectors
remains its current concrete implementation.

The implemented production Screen path is:

```text
/screen
  ↓
command.screen
  ↓
CapabilityGateway
  ↓
CapabilityPolicy + CapabilityRegistry
  ↓
financial.screen ToolDefinition
  ↓
ToolRuntime
  ↓
FinancialDataProvider
```

The registry contains all eight financial capabilities. The `command.screen`
principal is granted only `financial.screen`; it cannot discover, describe, or
invoke the other seven through the gateway. `HarnessContext` exposes the
gateway without exposing raw Registry or Policy instances.

R2C1 established the first production transition. R2C2 completes the Judge
migration:

```text
Screen = CapabilityGateway → ToolRuntime
Judge  = explicit workflow.judge.* principal → CapabilityGateway → ToolRuntime
```

`HarnessContext` exposes `capabilityGateway` and the current `judgeCapabilityPlan`
but does not expose raw `toolRuntime` or `financialTools`. The existing 15-node
Judge graph and `JUDGE_WORKFLOW_VERSION` remain unchanged.

### Judge capability migration and durable resume — R2C2

Judge uses four explicit capability principals:

```text
workflow.judge.identify-company -> financial.company-report
workflow.judge.fetch-financials -> financial.quarterly-financials
workflow.judge.fetch-market-data -> financial.daily-transaction, financial.foreign-flow
workflow.judge.fetch-news -> financial.news, financial.filings, financial.sentiment
```

The seven registered financial bindings are invoked through
`CapabilityGateway`; no Judge production node calls raw `ToolRuntime` or raw
financial tool definitions from `HarnessContext`. `WorkflowNode.executor`
remains audit ownership metadata and is not capability authorization.

`CapabilityPlan` schema version 1 is a deterministic, secret-free, data-only,
deeply immutable projection of the authorized descriptors for the Judge
principals. A new Judge execution profile stores the plan and its fingerprint.
Resume planning requires that fingerprint, rejects a capability-less historical
Judge profile as `INCOMPATIBLE_CHECKPOINT`, and rejects a different current plan
as `CAPABILITY_MISMATCH` before provider acquisition or workflow execution.
Checkpoint dependency fingerprints include the profile fingerprint
transitively. This preserves the existing generic profile schema and Judge
workflow version while making capability semantics part of Judge resume
compatibility.

## Core boundaries and invariants

- `Session → Turn → Execution` is the canonical lifecycle. A conversational
  Turn may have zero ResearchExecutions.
- `/judge` is an explicit workflow boundary. It owns the Researcher → Bull →
  Bear → rebuttal → Judge → deterministic evidence check → Verdict path.
- Bull, Bear, and Judge are workflow-scoped specialists. Other commands do not
  implicitly invoke the debate pipeline.
- Natural-language input is handled by `MainFinHarnessAgent`; it does not
  silently execute `/judge`, `/research`, `/compare`, `/challenge`,
  `/investigate`, or `/screen`.
- Provider cache/freshness, Evidence, artifacts, context, and workflow
  execution are separate storage and authority boundaries.
- `SessionWorkingContext` is durable relevance state, `ContextPacket` is a
  model-invocation projection, and `ContextSnapshot` records the exact final
  packet used by a ModelCall.
- Historical artifacts can be reused as bounded same-session context, but they
  do not memoize a new `/judge` or become authoritative current-run evidence.
- Persistence is owned by workflow/composition boundaries, not by model output.
- `CapabilityRegistry` is discovery truth, not policy or execution authority.
- `CapabilityPolicy` is deterministic policy data/evaluation, not execution,
  workflow scheduling, persistence, or an authorization principal inference
  mechanism.
- `CapabilityGateway` is the R2B authorization composition boundary, not a
  tool runtime; it accepts only explicit caller identity and delegates to
  `ToolRuntime`.
- `ToolRuntime` remains the sole authority for executing an explicit `ToolDefinition`.
- `WorkflowNode.executor` remains audit ownership metadata, not authorization.
- Skills and skill content are instructions, not capability grants.

## Canonical lifecycle

```text
Session
  └─ Turn
      └─ zero or more Execution attempts
          └─ WorkflowStep / ModelCall / Evidence / Artifact records
```

Every accepted input creates one Turn. A Judge command creates a canonical
Execution for that Turn. Execution attempts preserve session and turn ownership,
and terminal state is durable and idempotently enforced.

The canonical execution states are:

```text
running ───────→ completed
   │             failed
   │             cancelled
   └───────────→ interrupted ───────→ running
                                  resumeGeneration + 1
```

`interrupted` is non-terminal. `completed`, `failed`, and `cancelled` are
terminal. A terminal execution cannot be reopened. Reacquisition updates the
same Execution row and ID; it does not create a retry Execution.

## Command boundaries

The implemented command surface includes `/judge`, `/screen`, `/search`,
`/attach`, `/files`, `/history`, `/session`, `/resume`, `/web`, `/export`, `/version`,
setup/status commands, and local session controls. `/judge` is the current
mature research vertical; `/screen` and `/search` are implemented, and
`/attach` is explicit user-file ingestion. `/challenge`, `/compare`,
`/investigate`, and `/research` remain planned stubs.

`/resume <executionId>` validates and continues an interrupted canonical Judge
Execution in its original Turn. `/continue` selects exactly one interrupted
Judge Execution from the current Session; it never searches globally. `/session`
remains the read-only session/execution viewer.

## Financial evidence flow

```text
FinancialDataProvider
        ↓
selective retrieval + freshness policy
        ↓
provider normalization and deterministic verification
        ↓
Evidence Store
        ↓
VerifiedFinancialSnapshot
        ↓
Bull / Bear / Judge reasoning
```

Required Company Report and Quarterly Financials must verify before reasoning.
Optional Market and News enrichment is represented explicitly as
`NOT_REQUESTED` or `UNAVAILABLE` when absent. Sentiment is derived from the
accepted financial observations rather than treated as an untracked paid call.

Every canonical Execution receives its own immutable verified snapshot. A
provider cache is an acquisition optimization, not a snapshot or Evidence
authority.

Evidence is execution-scoped for reasoning and carries provenance and content
identity. Claims must reference allowed Evidence, Bear challenges must target
valid Bull claims, and score/stance normalization is deterministic code.

## Context engine

```text
SessionWorkingContext
        ↓
reference resolution + bounded artifact retrieval
        ↓
artifact validity
        ↓
context policy
        ↓
context assembler
        ↓
token budget + deterministic compaction
        ↓
ContextSnapshot → ModelCall
```

Working context is a versioned materialized view of durable relevance, not a
journal replay. Context snapshots are immutable invocation records. Model calls
link to the exact snapshot when one is used. Conversation context may reuse
valid same-session research references, but it does not turn historical output
into current-run evidence or trigger a hidden workflow.

The current conversation preparation path explicitly passes
`conversationHistory: ''` to the context budgeter. Durable research-context
follow-up is implemented, but general retained multi-turn transcript injection,
summary composition, and robust cross-turn reference resolution are not yet a
general model-context feature.

The authorities remain distinct:

```text
ConversationJournal != ConversationSummary
ConversationSummary != SessionWorkingContext
ConversationSummary != Evidence
SessionWorkingContext != ContextPacket
ContextPacket != Evidence
```

Conversation-derived claims remain conversational/user context until an
explicit evidence-producing research workflow independently verifies them.

## Workflow runtime

`WorkflowRunner` is the generic dependency-aware scheduler. A definition
contains stable node IDs, dependency IDs, required/optional semantics, optional
profile gates, and composition-owned adapters. The runner:

- validates node identity and dependency references;
- computes a DAG frontier rather than assuming a linear sequence;
- runs independent ready nodes concurrently;
- propagates required failures and optional degradation;
- supports cancellation at node boundaries;
- emits workflow lifecycle events for projection and trace persistence.

The production `/judge` definition has 15 stable nodes. Financial retrieval,
Evidence policy, model calls, and persistence adapters remain outside the
generic runner and are supplied by the command composition layer.

## Durable resumability and Judge resume — PR O / PR P

PR O is complete and merged. It provides the generic lifecycle, immutable
profile/output, generation-fencing, startup reconciliation, and restored-node
runner primitives. PR P connects those primitives to the production Judge graph
and is complete on master.

```text
ResearchExecution
  ├─ lifecycle status
  ├─ resume generation
  ├─ immutable ExecutionProfile
  ├─ WorkflowStep diagnostic trace
  └─ immutable WorkflowNodeOutput
            ↓
  PR P Resume Planner
            ↓
profile/version and typed checkpoint validation
            ↓
domain rehydration + idempotent projection repair
            ↓
atomic same-Execution acquire
            ↓
WorkflowRunner(restored)
            ↓
same Execution completion and artifact publication
```

### Restart reconciliation

On local CLI startup, abandoned `running` canonical Executions are reconciled
to `interrupted`. The parent Turn remains `running` while it has only an
interrupted attempt. Reconciliation does not acquire, rerun, or create a new
Execution. Completed Judge v2 executions with missing final artifacts are
repaired from validated final checkpoints without provider/model work;
interrupted executions remain available for explicit `/resume` or `/continue`.

The local CLI assumes the previous runtime is gone when it starts. There is no
heartbeat, distributed lease, worker registry, or multi-process liveness claim.

### ExecutionProfile

`ExecutionProfile` is the immutable semantic configuration for one canonical
Execution. The generic envelope contains execution identity, workflow ID and
version, deterministic graph fingerprint, command, ticker, typed JSON payload,
semantic fingerprint, and creation metadata. The Judge payload records the
actual reasoning mode, conditional flag, researcher flags, provider, and model
captured before provider/model work.

The profile fingerprint is canonical JSON hashed with SHA-256. It excludes
timestamps, function source, machine paths, and environment-specific metadata.
The profile is saved before lifecycle-backed `/judge` provider or model work.
Same-semantic retries are idempotent; semantic drift conflicts and never
overwrites the original profile.

### Workflow identity

Judge uses an explicit workflow version. The generic graph fingerprint covers
workflow identity/version, node IDs, dependency arrays, required/optional
semantics, executor identity, and whether a node is conditionally enabled. It
does not serialize JavaScript functions, closures, labels, timestamps, or paths.
Runtime profile data distinguishes conditional execution configuration without
hashing executable predicates.

### WorkflowNodeOutput

`WorkflowNodeOutput` is a separate immutable, data-only envelope for a future
restore planner. It contains execution and workflow identity, node identity,
status (`completed` or `skipped`), output kind, dependency fingerprint, payload
or references, output fingerprint, completion generation, and creation time.

The store requires a canonical lifecycle Execution and matching ExecutionProfile,
enforces workflow identity and current resume generation, rejects stale writers,
and allows one output per Execution + node. Semantic retries are idempotent;
conflicting values fail closed. Generation fences writers but is not part of
semantic output identity.

Payloads are JSON data only. They must not contain functions, clients, streams,
open handles, abort controllers, credentials, or raw provider transport state.

### Restore contract

The generic runner accepts validated completed/skipped restore seeds:

```ts
type WorkflowRestoreSeed =
  | { nodeId: string; status: 'completed'; value: unknown }
  | { nodeId: string; status: 'skipped' };
```

Restored nodes do not execute `node.run`. Completed values are available to
downstream inputs; skipped nodes satisfy dependencies with `undefined`. The
runner rejects unknown/duplicate nodes, invalid statuses, disabled-state
contradictions, and missing restored dependencies. Restored nodes emit
`workflow.step.restored`, not synthetic `started` or `completed` events.

The diagnostic `workflow_steps` trace is not automatically a checkpoint. PR P
requires a valid immutable node output before reusing a completed step and may
repair a stale workflow-step projection without fabricating historical timing.

### Production Judge resume

The Judge-specific planner validates the current Session-owned interrupted
Execution, immutable `ExecutionProfile`, workflow version/graph identity,
provider/model compatibility, output envelopes, dependency fingerprints,
FinancialSnapshot ownership, ContextSnapshot ownership, and referenced
Evidence. It derives a DAG-safe restore frontier; missing outputs leave nodes
pending, while invalid or conflicting outputs reject resume before acquisition.

Restoration is not a rerun, provider-cache lookup, artifact reuse, or journal
replay. Accepted provider and model results become typed data-only
`WorkflowNodeOutput` checkpoints. The collect-sources checkpoint is a compact
manifest over the authoritative FinancialSnapshot and Evidence rows. Optional
Market/News failure checkpoints preserve the continuation value `undefined`
while their historical workflow step remains `failed`; skipped nodes remain
durably skipped.

The profile's provider/model and researcher/reasoning/conditional flags remain
authoritative on resume. Changing current UI settings cannot silently change an
existing Execution. A model node without a committed semantic checkpoint is
rerun as a new attempt with a new ContextSnapshot; partial token streams are
never resumed.

## Storage authority matrix

| Store | Authority |
|---|---|
| ConversationJournal | append-only conversation audit and projection input |
| AttachmentStore | immutable user-provided raw-file identity, metadata, and durable bytes |
| SessionWorkingContext | versioned durable relevance state |
| Evidence | accepted source observations and provenance |
| FinancialSnapshot | verified execution-scoped financial input manifest |
| ContextSnapshot | exact model invocation context |
| ArtifactStore | semantic Bull/Bear/Verdict research products |
| WorkflowStep | diagnostic execution trace |
| WorkflowNodeOutput | immutable same-Execution continuation data |
| ExecutionProfile | immutable run configuration |

These stores are intentionally not interchangeable. Checkpoint/resume is not
provider-cache reuse, artifact reuse, context replay, or journal replay.

## Durable file attachments — S1

S1 adds a separate raw-file authority:

```text
AttachmentStore
  = immutable user-provided raw-file identity + metadata + durable bytes

ArtifactStore
  = semantic research output

Evidence
  = accepted source observation/provenance

Document
  = not implemented yet

Context
  = selected model input
```

The explicit `/attach <path>` command creates one canonical Turn and no
Execution. It snapshots exact raw bytes into FinHarness-owned content-addressed
storage below the configured data directory:

```text
<homeDir>/attachments/sha256/<first-two-hash-chars>/<full-content-hash>
```

The database stores immutable Attachment metadata and the filesystem stores
the immutable raw blob. `attachmentId != contentHash`; the former identifies
one metadata record and the latter identifies the exact SHA-256 byte content.
The source path is transient ingestion input, not a durable identity or
locator. `/attach` persists `/attach [file]` as safe Turn/journal input and
does not place attachment bytes into `ConversationJournal`, Context,
Evidence, Artifacts, Judge, Screen, or model prompts.

The existing `FilesystemSkillProvider` remains a package-owned `SKILL.md`
loader whose paths stay inside specialist package roots. It is not user-file
storage and does not read Attachment blobs. S2 adds controlled raw Attachment
capabilities without changing `/attach`; document parsing/retrieval belongs to
future S3.

```text
Attachment != Document != Evidence != Artifact != Context
```

## Session-scoped raw file capabilities — S2

S2 adds controlled access to existing FinHarness-owned Attachments. It does not
introduce a durable `Workspace`, a second file identity, a new migration, a
Document model, parsing, retrieval, context injection, or host filesystem
access. In S2, “workspace” is only the active Session-scoped view:

```text
Session
  |
  +-- Attachment A
  +-- Attachment B
  +-- Attachment C
```

The application composes one capability registry, policy, gateway, and
ToolRuntime for both financial and attachment tools:

```text
explicit caller
    |
    v
CapabilityPrincipal -> CapabilityPolicy -> CapabilityGateway
                                              |
                                              v
                                         ToolRuntime
                                              |
                                              v
                              Session-scoped Attachment tools
                                              |
                                              v
                                       AttachmentStore
```

The registered raw-resource capability IDs are:

```text
workspace.list-attachments
attachment.describe
attachment.read
```

The production grant is intentionally minimal:

```text
command.files -> workspace.list-attachments
```

`attachment.describe` and `attachment.read` are registered controlled raw-file
capabilities but have no invented production consumer or principal yet. The
attachment tool adapter captures the trusted active `sessionId` from
application composition; tool input cannot override it. Metadata is resolved
and Session ownership is checked before raw bytes are read. Unknown and
cross-Session attachments fail with the same not-found boundary, while
`AttachmentStore` blob-missing and integrity failures retain their error
identity.

`/files` creates one completed Turn, zero Executions, zero ModelCalls, and no
financial provider calls. `/attach <path>` remains explicit host-file
ingestion and does not use the capability gateway. `FilesystemSkillProvider`
remains only the package-owned specialist `SKILL.md` loader. S3 remains the
future Document understanding/retrieval milestone.

## Failure and restart semantics

Required workflow failures settle the canonical Execution as `failed`; user
cancellation settles it as `cancelled`. Process loss is represented as
`interrupted` and remains visible for future acquisition. Final artifact
publication is deterministic and idempotent: a completed Judge Execution with
valid final checkpoints can repair missing Bull, Bear, and Verdict artifacts on
startup. Working-context updates occur only after the original Turn settles
completed.

Errors cross the CLI boundary as structured user-facing errors. Internal
conflicts remain diagnosable without persisting secrets or exposing raw
credentials.

## Current roadmap

The current and future milestone order is maintained in
[`docs/ROADMAP.md`](docs/ROADMAP.md). A-P, Q1, Q2, R1, R2A, R2B, R2C1, R2C2,
S1, and S2 are complete on this branch. The current milestone is:

**S3 — Document Understanding / Retrieval**

R2C2 migrated the remaining Judge direct-runtime path and added durable
capability semantic compatibility. PR P continues to restore the same
Execution's validated snapshot, Evidence, and typed debate outputs without
changing its lifecycle or Judge graph. The full future order is maintained in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

### R1 Typed Tool Runtime

`@harness/tool-runtime` executes one explicitly supplied `ToolDefinition` at a
time. It validates typed input and output with Zod, preserves handler/domain
error identity, fences cancellation before and after handler execution, and
emits one terminal lifecycle event through a per-invocation observer. It has no
lookup, registry, policy, retry, workflow scheduling, model-loop, or durable
tool state.

The CLI composes eight explicit financial definitions over the authoritative
`FinancialDataProvider` seam. Judge uses seven ticker operations and Screen
uses the screening operation; both retain their existing business behavior and
public event projections. The generic runtime remains domain-neutral and does
not import CLI event types or financial packages. R2A adds immutable capability
contracts and discovery; R2B adds deterministic policy and gateway
composition. R2C1 registers all eight definitions and migrates Screen through
the gateway. R2C2 migrates Judge through the same gateway and pins capability
semantics in its execution profiles.
