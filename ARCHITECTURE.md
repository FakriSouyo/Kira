# Kira Architecture

This document describes the current runtime architecture and its invariants.
It is not a chronological implementation diary. The canonical roadmap is
[`docs/ROADMAP.md`](docs/ROADMAP.md), and current project status is
[`docs/PROGRESS.md`](docs/PROGRESS.md).

## Current architecture facts

apps/cli still owns significant application/runtime composition. It owns the CLI
host, command dispatch and parsing, Session/repl lifecycle, `/new` Session
creation, configuration/runtime rebinding and switching, `/resume` and
`/continue` argument validation and target selection, local-path Attachment
import, rendering, Judge Execution lifecycle, WorkflowRunner composition,
same-Execution acquisition, release planning/publication and startup repair,
trace wiring, provider composition, CLI event
projection, streaming
presentation, and ConversationController. The CLI consumes the
conversation response stream and presents its chunks; host-neutral response
orchestration is in the engine. Fresh canonical Turn lifecycle orchestration
for ordinary commands, natural-language input, local input, and the old-Session
Turn for `/new` is in the engine through `runSessionTurn`. The engine also
coordinates attached-Turn lifecycle after CLI selects an existing Session,
Turn, and Execution. The CLI remains more than a thin host
adapter, and ConversationController remains the production journal
correlation/causation path for audit appends and host projection. Restart
settlement of canonical Turns belongs to the host-neutral engine reconciliation
operation; journal/transcript repair remains in CLI.

packages/engine (package name @harness/engine) owns the extracted host-neutral
financial, Attachment, and Document tool definitions and capability composition,
WorkflowTraceRecorder, Screen application workflow, conversation context
preparation and host-neutral Conversation Response orchestration, WorkingContext
publication/reconciliation orchestration, host-neutral Workspace/Document
workflows for `/files`, `/doc-index`, and `/doc-search`, Session restart
lifecycle reconciliation, the host-neutral Judge node application runtime,
Judge checkpoint/resume core, and durable Judge resume projection repair through
narrow host-supplied store contracts,
and fresh-Turn lifecycle orchestration through the
existing `ResearchSessionStore` and `WorkingContextPublisher` contracts, plus
attached-Turn lifecycle orchestration around an existing Turn and Execution.
Conversation Response
orchestration coordinates `ConversationContextCoordinator` ->
`MainFinHarnessAgent` -> `ResearchSessionStore.recordModelCall` through supplied
current contracts. The context coordinator receives supplied WorkingContextStore,
ArtifactStore, and ContextSnapshotStore contracts; the WorkingContext publisher
receives supplied WorkingContextStore, ArtifactStore, and JudgmentStore
contracts, a journal read callback, and a host audit append callback. Workspace
and Document workflows use the supplied CapabilityGateway and DocumentStore.
Persistence implementations and host filesystem access remain outside engine.
Engine does not own `/new` Session creation, configuration/runtime rebinding
and switching, `/resume` or `/continue` parsing and target selection,
ConversationController, AgentEvent presentation, provider composition, Judge
Execution lifecycle, WorkflowRunner composition, same-Execution acquisition,
release planning/publication, startup release repair, or trace composition.
Engine owns host-neutral Judge checkpoint encoding and decoding, resume
compatibility planning, restore-frontier derivation, and durable resume
projection repair through supplied stores. The CLI acquires the same
interrupted Execution only after engine planning succeeds.
The publisher coordinates publication; WorkingContextStore owns durable
WorkingContext persistence. The context coordinator coordinates existing
@harness/context policies and @harness/orchestrator focus/prompt semantics. The
capability factory receives the existing FinancialDataProvider, AttachmentStore,
DocumentStore, and trusted Session ID, then returns the capability Gateway and
Judge plan.

    apps/cli
      CLI host + lifecycle, model/provider composition, and presentation
           | consumes
           v
    packages/engine (@harness/engine)
      host-neutral tools, capability composition, trace recorder,
      Screen workflow, conversation context preparation and Conversation
      Response orchestration, WorkingContext publication/reconciliation,
      Workspace/Document workflows, Session restart reconciliation,
      Judge checkpoint/resume core and resume projection repair,
      fresh-Turn and attached-Turn lifecycle
      orchestration
           | coordinates
           v
    packages/*
      existing command, capability, context, session, execution,
      evidence, conversation, document, LLM, provider, and persistence authorities

External seams remain explicit: packages/llm owns model clients,
packages/financial-data owns the provider-neutral financial contract, and
packages/sectors-api is the current financial provider implementation. The
current source symbol for the conversational host is MainFinHarnessAgent; it is
a legacy internal name scheduled for KB. The current @harness/* package
namespace and FinharnessConfig/HarnessContext identifiers are also deferred
to KB; no internal identity migration occurs in KA or UA.

## Target direction — complete Kira engine

The current packages/engine remains a partial host-neutral application
boundary, not the complete target engine. Kira is a reusable financial
research engine. The CLI is its first host adapter. Future Desktop and Web
surfaces should consume the same host-neutral engine rather than reimplement
Judge, Session, Context, Evidence, capability, or lifecycle behavior.

                 Kira Engine

    CLI --------+
    Desktop ----+----> host-neutral engine
    Web --------+              |
                               v
                      existing domain/runtime packages

The eventual conceptual dependency direction is:

    host adapters
        ↓
    Kira engine/application boundary
        ↓
    command / capability / context
    session / execution / evidence
    conversation / document / llm
    subagents / financial-data
        ↓
    persistence/providers

Apps present. Engine coordinates. Commands define workflows. Capabilities
authorize. Tools execute. Domain packages own truth. Database persists.

The future engine coordinates these existing authorities; it does not become
another Evidence authority, Claim authority, capability authorization
authority, ToolRuntime, database authority, provider authority, or graph
authority. UA15 and later boundaries remain unselected and
must be selected after a fresh source audit before each slice.

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

R2A and R2B add the domain-neutral @harness/capability package. R2C1 and R2C2
first consumed it in CLI composition. UA1 moves the existing financial,
Attachment, and Document tool/capability composition to @harness/engine without
changing its authorities or behavior. The package dependency direction remains
deliberately small:

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

The @harness/engine application boundary registers the eight existing
financial tools under
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
CLI command / argument normalization
  ↓
@harness/engine screenWorkflow
  ↓
command.screen principal
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
The engine's `screenWorkflow` is application orchestration, not authorization
or execution authority; authorization remains with CapabilityPolicy and
CapabilityRegistry through the Gateway, and ToolRuntime remains execution
authority.

R2C1 established the first production transition. R2C2 completes the Judge
migration:

```text
Screen workflow = command.screen → CapabilityGateway → ToolRuntime
Judge           = explicit workflow.judge.* principal → CapabilityGateway → ToolRuntime
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

## UA1 — Host-neutral Capability Runtime Extraction

UA1 moves the existing financial, Attachment, and Document tool definitions and
application capability composition from CLI-owned modules into packages/engine
(@harness/engine). createEngineCapabilityRuntime composes one ToolRuntime, the
existing tools, capability Gateway, and Judge CapabilityPlan per application
context. It accepts existing provider/store interfaces and a trusted Session
ID. The CLI continues to create concrete providers and stores, and consumes
the returned Gateway and plan from its HarnessContext.

apps/cli/src/tools/financialToolEvents.ts remains a CLI adapter because it maps
ToolRuntimeEvent to CLI AgentEvent. Judge workflow/nodes/checkpointing,
Session/repl orchestration, conversation/context, and WorkingContext
publication also remain in CLI. UA1 does not complete the engine extraction.

## UA2 — Host-neutral Workflow Trace Extraction

UA2 moves the existing `WorkflowTraceRecorder` from the CLI runtime into
`packages/engine`. It receives `WorkflowEvent` and `SubagentResult` values and
an externally supplied Session trace store, then coordinates existing
`WorkflowStep` and `ModelCall` writes. It is not the `WorkflowRunner`, which
owns workflow execution and event semantics, or a persistence authority.

`projectWorkflowStep` remains in CLI and projects the same `WorkflowEvent`
stream into presentation-facing `AgentEvent` values. Judge orchestration,
workflow nodes, checkpointing, Session/repl, conversation/context,
WorkingContext publication, and provider composition remain in CLI. The
recorder and CLI projection are separate subscribers to workflow runtime truth;
UA2 does not complete engine extraction.

## UA3 — Host-neutral Screen Workflow Extraction

UA3 moves the existing Screen application workflow into `packages/engine`.
It depends only on the existing `CapabilityGateway`, invokes the explicit
Screen principal and `financial.screen`, filters non-positive matches, and
preserves provider order and the existing ten-row limit. The CLI retains
`/screen` argument normalization, error presentation, and rendering. The
workflow is neither a capability authorization authority nor a provider or
ToolRuntime boundary. Judge workflow/nodes/checkpointing, Session/repl,
conversation/context, WorkingContext publication, provider composition, and
CLI event adaptation remain outside engine. UA3 does not complete engine
extraction; boundaries beyond UA3 remain provisional and require fresh source
audit before selection.

## UA4 — Host-neutral Conversation Context Preparation Extraction

UA4 moves the existing conversation context preparation coordinator from CLI
into packages/engine. It coordinates focus-aware retrieval, selection,
assembly, budgeting, and post-budget snapshot persistence through supplied
WorkingContextStore, ArtifactStore, and ContextSnapshotStore interfaces.
Context policy remains in @harness/context, and focus/prompt rendering
semantics remain in @harness/orchestrator; concrete persistence stays in
persistence packages. Session/Turn lifecycle, model invocation and streaming,
ModelCall persistence, provider composition, and CLI event adaptation remain in
CLI. UA4 did not extract WorkingContext publication or persistence.

## UA5 - Host-neutral WorkingContext Publication Extraction

UA5 moves WorkingContext publication and journal-reconciliation orchestration
from `apps/cli` into `packages/engine`. The publisher receives the existing
`WorkingContextStore`, `ArtifactStore`, and `JudgmentStore` contracts, a
host-supplied journal read callback, and a host audit append callback. It keeps
completed-Turn eligibility, completed-Execution filtering, typed Artifact
resolution and legacy Judgment fallback, no-op suppression, canonical
`turn.started` acceptance ordering, compare-and-set publication, and missing
audit-event reconciliation together at the application boundary.

The publisher coordinates publication; `WorkingContextStore` owns durable
WorkingContext persistence. The publisher does not own Session/Turn lifecycle
or load `ResearchSessionArtifacts`: CLI Session orchestration supplies those
completed artifacts. `ConversationController` remains the production journal
correlation/causation path for audit appends. Judge orchestration, model
invocation/streaming, provider composition, and CLI event presentation remain
in CLI.

## UA6 - Host-neutral Workspace + Document Workflows Extraction

UA6 moves the existing `/files`, `/doc-index`, and `/doc-search` application
orchestration from CLI into `packages/engine`, without moving their argument
parsing, active lifecycle checks, or rendering.

```text
/files
  -> filesWorkflow
  -> CapabilityGateway -> workspace.list-attachments

/doc-index <attachmentId>
  -> active Turn ID supplied by CLI
  -> documentIndexWorkflow
  -> CapabilityGateway -> attachment.read
  -> @harness/document buildDocumentBundle
  -> supplied DocumentStore.save

/doc-search <query> [options]
  -> CLI parses query/options
  -> documentSearchWorkflow
  -> CapabilityGateway -> document.search
```

CapabilityGateway and CapabilityPolicy retain authorization authority,
ToolRuntime retains tool execution authority, `@harness/document` retains
Document extraction, identity, chunking, and retrieval semantics, and the
supplied DocumentStore remains persistence authority. Engine workflows do not
load Turns, access the host filesystem, render CLI output, or duplicate
Document/domain behavior. `/attach` remains CLI-local path/file-system
ingestion. UA15 and later boundaries remain unselected and require a fresh
source audit before selection.

## UA7 - Host-neutral Conversation Response Orchestration Extraction

UA7 moves only host-neutral conversational response orchestration from CLI to
`packages/engine`. The CLI still creates and settles the conversation Turn;
the engine coordinates the current context coordinator, MainFinHarnessAgent,
and successful ModelCall provenance persistence through the supplied
ResearchSessionStore contract.

```text
CLI creates conversation Turn
        ↓
@harness/engine conversation response workflow
        ↓
ConversationContextCoordinator
        ↓
MainFinHarnessAgent
        ↓
ResearchSessionStore.recordModelCall
        ↓
CLI transcript/event projection + Turn settlement
```

Natural-language conversation still creates no `ResearchExecution`. The
workflow is distinct from Turn lifecycle, `ConversationController`, UI event
presentation, context policy, and model runtime authority. Engine does not own
`ConversationController` or `AgentEvent` presentation. At the end of UA7, CLI
still owned Turn creation/settlement and the WorkingContext publication trigger;
UA9 subsequently extracts the fresh-Turn orchestration around its current
command, conversation, and local-input callbacks. Context selection, budgeting,
snapshot creation, MainFinHarnessAgent behavior, runtime routing, and model
provenance fields keep their existing authorities and semantics.

## UA8 - Host-neutral Session Restart Lifecycle Reconciliation Extraction

UA8 extracts only the canonical Session/Turn/Execution reconciliation that ran
inside `ConversationController.restore()`. The engine loads `ResearchSession`
artifacts through the supplied `ResearchSessionStore`, interrupts abandoned
running Executions, and settles eligible running Turns using the existing
completed > failed > interrupted-keeps-running > otherwise-stopped precedence.
The store contract remains the lifecycle persistence authority, and database
implementation remains outside engine.

```text
ConversationController.restore()
  ├─ reads journal and rebuilds conversation projection
  ├─ @harness/engine reconciles canonical Session lifecycle through ResearchSessionStore
  └─ repairs journal/run/message/turn projection through ConversationController
```

At the end of UA8, CLI still owned fresh-Turn execution and publication
orchestration. ConversationController retains journal correlation/causation,
evidence label
restoration, origin and last-by-Turn lookups, run/message/turn journal events,
state publication, and `open()` rollback. An abandoned running Execution
becomes interrupted while its parent Turn stays running when no completed or
failed attempt exists, leaving the same Turn and Execution available for
explicit `/resume` or `/continue`. UA8 does not complete engine extraction.

## UA9 - Host-neutral Fresh-Turn Lifecycle Orchestration Extraction

UA9 extracts the reusable lifecycle around one newly accepted Turn from
`apps/cli/src/repl/session.ts` into `packages/engine`. The engine creates the
Turn through `ResearchSessionStore`, invokes host start/action callbacks,
settles the canonical Turn, and on normal success loads current Session
artifacts and calls `WorkingContextPublisher` before host terminal projection.
Live failure resolution remains distinct from restart reconciliation:
completed child Execution wins, then cancelled, then failed, then abort
signal/host error classification, then failed. A completed Turn settled through
the failure path does not trigger normal-success publication.

```text
CLI fresh-input parsing and presentation
        ↓ host-neutral callbacks
@harness/engine runSessionTurn
  ├─ ResearchSessionStore: create and settle Turn
  ├─ host action: command / conversation / local presentation work
  └─ WorkingContextPublisher: normal-success publication
        ↓ host terminal projection
CLI ConversationController and AgentEvent projection
```

The extraction covers ordinary command Turns, natural-language conversation
Turns, and `recordLocalInput` Turns. Natural-language and local-input Turns
continue to create zero ResearchExecutions. The CLI retains command parsing,
provider composition, ConversationController/journal/transcript projection,
AgentEvent projection, response streaming/rendering, reload and suspend
handling, Judge execution/checkpointing, `/new` Session switching, and
`/resume`/`/continue` target selection and input projection. ResearchSessionStore
remains lifecycle persistence authority, WorkingContextPublisher remains publication
policy authority, and no database migration is required. UA9 did not complete
engine extraction; UA10, UA11, UA12, and UA13 are complete on master. UA14 is
the selected/current implementation state pending source review; UA15+ remain
unselected until another fresh source audit.

## UA10 - Host-neutral Attached-Turn Lifecycle Orchestration Extraction

UA10 extracts the reusable lifecycle around an already-selected existing Turn
and Execution from `apps/cli/src/repl/session.ts` into `packages/engine` through
`runAttachedSessionTurn`. The CLI retains `/resume` and `/continue` argument
validation, candidate/target selection, control-command input projection,
ConversationController, and command presentation. At the UA10 boundary, the
Judge resume workflow retained compatibility validation and acquisition of the
same interrupted Execution. UA13 later moved compatibility planning to engine;
the CLI still acquires the interrupted Execution only after planning succeeds.

The engine receives canonical Session, Turn, and Execution IDs with narrow
`ResearchSessionStore` and `WorkingContextPublisher` contracts. After the
supplied host action, it reloads Session artifacts and classifies only the exact
target Execution. A normal return maps `completed`, `cancelled`, `failed`, and
`running` to parent Turn statuses `completed`, `stopped`, `failed`, and `failed`.
An `interrupted` or missing target releases the host attachment and leaves the
Turn running. For a normal-success settlement, it reloads the settled artifacts,
invokes `WorkingContextPublisher`, and calls the host settled projection. If any
of those post-settlement operations fail, it releases the host attachment once
before propagating the error. If the action throws, terminal state settles the
parent Turn and invokes host settlement without publication; running,
interrupted, or missing state releases the host attachment. That path rethrows
the action error after its callbacks complete. Before settlement, failures use
the legacy outer-catch reload and reconciliation path.

```text
CLI selects and attaches existing target
        ↓ host action + callbacks
@harness/engine runAttachedSessionTurn
  ├─ ResearchSessionStore: reload exact Execution, settle existing Turn
  ├─ WorkingContextPublisher: normal-success terminal publication
  └─ host callback: release attachment or project settled Turn
         ↓
engine plans checkpoint compatibility → CLI acquires the same Execution
```

The runner does not create or acquire lifecycle rows, mutate `resumeGeneration`,
or select the target. UA10 left the `/new` Turn lifecycle outside its scope;
UA11 converges that Turn through `runSessionTurn`. UA9 lifecycle orchestration,
UA8 restart reconciliation, Judge workflow/checkpointing, and journal mutation
retain their separate responsibilities. No schema migration is required. UA15+
remain unselected pending a fresh source audit.

## UA11 - Special `/new` Turn Lifecycle Convergence

UA11 moves only the old-Session Turn lifecycle for `/new` onto the existing
`runSessionTurn` engine primitive. The CLI creates the new Session only after
the old Turn has canonically settled and its ConversationController projection
has completed. The engine caller explicitly disables success publication for
this Turn, so success does not reload Session artifacts for publication or call
`WorkingContextPublisher`. The runner's default success behavior remains
unchanged for ordinary commands, natural-language conversation, and local
input.

The CLI retains new Session creation, configuration/provider/model rebinding,
ConversationController switching, journal reconciliation, and prepared-context
commit. The new Session continues to use the configured/default model selection
rather than copying the prior Session's user selection. Failures during
Session creation or switching occur after the old Turn is terminal and do not
reclassify or settle it again. Judge workflow/checkpointing, provider
composition, persistence, and journal authority are unchanged. No schema
migration is required.

## UA12 - Host-neutral Judge Node Runtime Extraction

UA12 moves the substantive Judge node application runtime from
`apps/cli/src/workflows/judgeNodes.ts` into `packages/engine` as
`createJudgeNodeExecutors`. The engine coordinates the existing
CapabilityGateway, financial verification and Evidence Policy, Evidence and
FinancialSnapshot stores, Bull/Bear/Judge specialists, Claim and Counterpoint
Policies and stores, conversation and judgment stores, and deterministic
evidence and verdict gates. It receives narrow host-supplied contracts and
does not depend on `HarnessContext`, `FinharnessDatabase`, or CLI modules.

The runtime emits a narrow `JudgeNodeEvent`, forwards raw ToolRuntime events
through a supplied callback, and retains supplied progress, checkpoint, trace,
and optional lifecycle metadata boundaries. The CLI adapts ToolRuntime events
to its existing `tool.start` / `tool.complete` presentation events. The CLI
retains Judge Execution creation/settlement, direct legacy-run support,
ExecutionProfile creation, same-Execution acquisition after resume planning,
WorkflowRunner and trace-recorder composition, release planning/publication,
workflow/session/verdict AgentEvent projection, and artifact assembly. UA13
later moved checkpoint persistence and resume planning into engine. The graph,
workflow version, capability plan,
checkpoint format, resume compatibility, release contract, artifact kinds,
provider order, and database schema remain unchanged. UA12 completed on master.

## UA13 - Host-neutral Judge Checkpoint + Resume Core Extraction

UA13 moves checkpoint payload encoding, dependency fingerprints, persistence
coordination, checkpoint decoding, resume compatibility validation, and
graph-order restore-frontier derivation from
`apps/cli/src/workflows/judgeCheckpoint.ts` into
`packages/engine/src/judge/checkpointResume.ts`. The core receives narrow
WorkflowNodeOutput, FinancialSnapshot, Evidence, and ContextSnapshot store
operations. It preserves financial observation re-verification,
execution-scoped Evidence restoration, snapshot identity checks,
capability/model/runtime compatibility, and historical/current Bear decoding.

The CLI retains Execution lifecycle, resume target selection and
same-Execution acquisition, WorkflowRunner and trace composition, projection
repair, release planning/publication, startup release repair, and AgentEvent
projection. Engine planning completes before CLI acquisition. UA13 does not
move the Judge workflow shell, change checkpoint payloads, graph/version,
capability plan, release contract, artifact kinds, persistence schema, or
resumeGeneration ownership. UA12 and UA13 are complete on master. UA14 is the
selected/current implementation state pending source review, and UA15+ remain
unselected pending a fresh source audit.

## UA14 - Host-neutral Judge Resume Projection Repair Extraction

UA14 moves `checkpointMessage` and `repairJudgeProjections` from
`apps/cli/src/workflows/judgeCheckpoint.ts` into
`packages/engine/src/judge/projectionRepair.ts`. Engine replays already-validated
Judge checkpoint outputs into the existing WorkflowStep, Conversation, Claim,
Counterpoint, Judgment, and ModelCall authorities. Its narrow host-supplied
contract contains only step get/save, ModelCall list/record, Conversation
`addMessage`, Claim `save` and legacy checkpoint repair, Counterpoint `save`, and
Judgment `save`. ModelCall lookup remains a projection-specific trace operation;
the canonical `ResearchSessionStore` interface is unchanged.

Projection repair reuses `auditFromPayload` and
`parseCheckpointCounterpoints` from the checkpoint/resume core. It preserves
current and historical Claim/Bear behavior, deterministic step and ModelCall
identities, message IDs and sequence values, and replay cost/currency as null.
The CLI wraps concrete stores into the narrow contract. Resume remains ordered:
engine planning, CLI acquisition of the same interrupted Execution, engine
projection repair, then CLI `WorkflowRunner`. Execution lifecycle, workflow and
trace composition, release planning/publication, startup release repair, and
AgentEvent projection remain CLI-owned. No checkpoint, graph, release,
persistence, or provider behavior changes. UA12 and UA13 are complete on master;
UA14 is the selected/current implementation state in this source-review
worktree, pending approval. UA15+ remain unselected pending a fresh source audit.

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

### Evidence acceptance and provenance — T1

The Evidence domain distinguishes retrieval candidates from accepted Evidence.
`evidence-policy-v1` has a deterministic fingerprint. Financial candidates
come from `PresentFinancialObservation` and are checked by the authoritative
financial verifier before persistence. The acceptance receipt preserves source
origin, complete financial metadata, verification result, retrieval time, and
acceptance time. `dataAsOf` remains provenance and does not populate `validAt`.

The immutable content row remains deduplicated by content hash, ticker, and
source. `run_evidence` is the execution membership authority and stores
acceptance metadata per Execution. Scoped reads report the accepting Execution
in `Evidence.runId`; pre-T1 rows are returned as explicit `legacy-v0`
provenance. Document search hits and citations have a typed candidate adapter,
but `/doc-search` still returns candidates without persisting Evidence or
creating an Execution. T1 is complete on master.

### Claim grounding and canonical durability — T2

Current Bull model output uses `ClaimProposalSchema`: each Claim has explicit
`supports`, `contradicts`, or `qualifies` Evidence links with producer rationale.
The model cannot provide `singleMetric` or Claim Policy identity. The
backward-readable `ClaimSchema` remains the format for historical artifacts and
Judge checkpoints. An explicit Evidence link records the producer's assertion;
it is not a code verdict about semantic truth or a Claim Graph edge.

`claim-policy-v1` has a deterministic fingerprint. It checks exact Claim
evidence ID/link parity, response Evidence coverage, allowed and model-seen
scope, and T1 execution membership through `getManyByIdsForRun`. It checks
each CitedFigure against its linked Evidence path and value. Literal numeric
assertions in a statement are grounded when written as a number followed by
`%`, `x`, or `bps`; the policy matches their values to CitedFigures within the
existing 0.5 tolerance. Period labels such as `Q2 2026` and `H1 2025` are not
metric assertions. Currency, magnitude conversion, and arbitrary prose
entailment are outside this deterministic contract. `singleMetric` is derived
by code from the cited and visible execution-scoped Evidence.

Migration `0018_claim_grounding.sql` adds nullable `cited_figures`,
`single_metric`, `evidence_links`, `policy_id`, and `policy_fingerprint` columns
to canonical `claims`. Current writes require policy identity, complete links,
and Execution membership. ClaimStore and ExecutionStore use one fail-closed row
projection. Historical rows remain readable without fabricated T2 metadata;
only historical Judge checkpoint repair can write a policy-less projection.
Current checkpoints restore full canonical grounding without repeating model
work. The Judge graph remains 15 nodes at workflow version 2.

### T3 Counterpoint Policy + Durable Projection

Current Bear proposals require per-Counterpoint Evidence IDs and explicit
Evidence links, with optional CitedFigures. Model output cannot provide a
Counterpoint ID or Policy identity. `counterpoint-policy-v1` checks target
Claims, allowed/seen/response Evidence scope, Execution membership, Evidence
link parity, CitedFigure paths and values, and literal numeric assertions. Code
assigns source-node-scoped Counterpoint IDs and deterministic Policy
fingerprints.

Migration `0019_counterpoint_grounding.sql` adds canonical execution-scoped
Counterpoint rows. `CounterpointStoreSqlite` and ExecutionStore share the same
fail-closed projection. Checkpoints store model proposals separately from the
grounded canonical records; repair restores missing rows idempotently without
calling providers. Historical Bear checkpoints and the existing `BEAR_CASE`
kind remain readable without invented T3 grounding. The artifact projects the
round-one Bear challenge; conditional re-challenge points remain in the
Execution store and are included in downstream Bull and Judge typed contexts.
T3 leaves the 15-node graph, workflow version, capability plan, verdict
scoring, and artifact kinds unchanged. T4 supplies the deterministic Claim
Graph projection; release integration remains T5 work.

### T4 Execution-local Claim Graph Core

`@harness/execution` defines a typed Claim Graph projection over the canonical
`ClaimStore` and current `CounterpointStore` rows. `ClaimGraphReaderSqlite`
rebuilds that projection for one Execution, and `ExecutionArtifacts` exposes
the same graph through the shared pure builder. Nodes remain owned by their
existing stores; the graph has no independent persistence or repair path.

`Counterpoint.targetClaimId` remains the only durable Claim/Counterpoint
relationship authority. T4 projects it as
`Counterpoint --targets--> Claim`. Reads are deterministic and fail closed on
duplicate identities, cross-Execution rows, missing targets, or corrupt
canonical rows. Historical Claims remain graph nodes without fabricated T2
grounding; historical pre-T3 Bear Counterpoints are not fabricated. Claim
proposals still do not declare a particular Counterpoint rebuttal target, so
explicit Claim-to-Counterpoint rebuttal relationships do not yet exist.

T4 does not change Judge artifacts, publication, release semantics, the
15-node Judge graph, or workflow version 2. Graph release integrity is the
separate T5 release boundary described below.

### T5 Judge Integration + Release Integrity

New lifecycle Judge profiles pin a deterministic `judge-release-v1` contract
covering the exact Claim and Counterpoint policy fingerprints, the versioned
Claim Graph contract, and the existing three artifact kinds at schema version
1. After the 15-node workflow and its durable callbacks finish, but before
settling the Execution as completed, the release planner reuses the checkpoint
planner and requires exact checkpoint-to-store Claim and Counterpoint parity,
current policy metadata, and a complete graph reconstructed from canonical
stores. It does not infer semantic or rebuttal relationships.

The Execution is completed only after that gate passes. The existing
`BULL_CASE`, `BEAR_CASE`, and `VERDICT` v1 artifacts are still published after
completion. A separate immutable execution-scoped receipt records the validated
Claim Graph fingerprint and the graph subset represented by each artifact.
Startup reconstructs the plan and repairs missing artifacts or receipts before
WorkingContext publication, without model/provider calls. Historical pre-T5
profiles retain legacy checkpoint/artifact behavior and never receive a
fabricated T5 receipt. Judge topology, workflow version 2, artifact kinds, and
artifact payload schemas remain unchanged.

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
Evidence policy, model calls, and persistence are coordinated by the engine
Judge node runtime through supplied contracts; the CLI supplies those contracts
and composes the node runtime with `WorkflowRunner`.

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
Execution. Completed compatible historical pre-T5 Judge v2 executions may
have missing `BULL_CASE`, `BEAR_CASE`, or `VERDICT` artifacts repaired from
validated checkpoints; they do not receive a fabricated T5 release receipt.
For a current T5 Judge execution, startup reconstructs and validates the release
plan from durable checkpoints and canonical Claim/Counterpoint stores, then
ensures `BULL_CASE`, `BEAR_CASE`, `VERDICT`, and `ClaimGraphReleaseReceipt` are
complete and consistent. Three existing artifacts without a receipt are still
incomplete publication. This validation and repair happens before WorkingContext
publication and performs no provider/model calls. Interrupted executions remain
available only for explicit `/resume` or `/continue`.

The local CLI assumes the previous runtime is gone when it starts. There is no
heartbeat, distributed lease, worker registry, or multi-process liveness claim.

### ExecutionProfile

`ExecutionProfile` is the immutable semantic configuration for one canonical
Execution. The generic envelope contains execution identity, workflow ID and
version, deterministic graph fingerprint, command, ticker, typed JSON payload,
semantic fingerprint, and creation metadata. The Judge payload records the
actual reasoning mode, conditional flag, researcher flags, provider, and model
captured before provider/model work. A current T5 Judge profile also pins its
release contract and fingerprint.

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
| ClaimGraphReleaseReceipt | immutable execution-scoped provenance binding the validated Claim Graph fingerprint and per-artifact graph projections to one completed current T5 Judge release |

Canonical graph truth remains `ClaimStore` + `CounterpointStore` → Claim Graph.
`ClaimGraphReleaseReceipt` is derived release provenance, not Claim Graph
authority, `ArtifactStore`, or `ExecutionProfile`, and does not store
authoritative graph edges. These stores are intentionally not interchangeable.
Checkpoint/resume is not provider-cache reuse, artifact reuse, context replay,
or journal replay.

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
  = deterministic extracted text/pages/chunks derived from one Attachment

Context
  = selected model input
```

The explicit `/attach <path>` command creates one canonical Turn and no
Execution. It snapshots exact raw bytes into Kira-owned content-addressed
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
capabilities without changing `/attach`. S3 adds explicit document indexing and
retrieval without changing Attachment semantics.

```text
Attachment != Document != Evidence != Artifact != Context
```

## Session-scoped raw file capabilities — S2

S2 adds controlled access to existing Kira-owned Attachments. It does not
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

`attachment.describe` remains a registered controlled raw-file capability, while
`attachment.read` is granted only to the indexing principal. The attachment
tool adapter captures the trusted active `sessionId` from application
composition; tool input cannot override it. Metadata is resolved and Session
ownership is checked before raw bytes are read. Unknown and cross-Session
attachments fail with the same not-found boundary, while `AttachmentStore`
blob-missing and integrity failures retain their error identity.

`/files` creates one completed Turn, zero Executions, zero ModelCalls, and no
financial provider calls. `/attach <path>` remains explicit host-file
ingestion and does not use the capability gateway. `FilesystemSkillProvider`
remains only the package-owned specialist `SKILL.md` loader.

## Deterministic Documents and retrieval — S3

S3 derives a durable `Document` and ordered `DocumentChunk` rows only through
the explicit `/doc-index <attachmentId>` command. The document package is
domain-only: it detects PDF, UTF-8 text, Markdown, JSON, CSV, and TSV; rejects
unsupported/binary content; extracts PDF pages locally; normalizes text; and
chunks deterministically with bounded size and page/line/section provenance.
No OCR, remote fetch, HTML, Office parsing, embeddings, vector store, or model
call is involved.

```text
/doc-index <attachmentId>
  -> command.doc-index
  -> CapabilityGateway -> attachment.read
  -> @harness/document extraction/chunking
  -> DocumentStore

/doc-search <query>
  -> command.doc-search
  -> CapabilityGateway -> document.search
  -> session-scoped DocumentStore -> lexical chunks -> citations
```

Document identity is a deterministic hash of schema version, source
Attachment, source content hash, and the exact parser plus current document pipeline
version. The same Attachment can retain distinct Document derivations across
pipeline versions. Re-indexing under one version is idempotent; conflicting
semantics under that version fail closed. PDF magic in verified bytes takes
precedence over advisory media type and filename. Bundled PDF.js standard fonts
are resolved locally. `textHash` records the normalized extracted text before
chunking; the exact extraction stream is not stored, so read-time validation
does not recompute `textHash`. It does validate Document and chunk identities,
chunk text hashes, ordinals, and counts. Search
is case-insensitive exact-phrase/token coverage with stable ties and a maximum
of twenty results. `Document` and `DocumentChunk` are not Evidence, Artifact,
Context, or model input. Retrieval returns candidates with citations; it does
not persist Evidence or invoke Judge.

## Failure and restart semantics

Required workflow failures settle the canonical Execution as `failed`; user
cancellation settles it as `cancelled`. Process loss is represented as
`interrupted`, and interrupted runs remain available for explicit
`/resume` or `/continue`. Final Judge publication is deterministic and
idempotent. Compatible historical pre-T5 completed executions can repair
missing Bull, Bear, and Verdict artifacts from validated checkpoints without
creating a T5 receipt. Current T5 completed executions reconstruct and validate
their release plan from durable checkpoints and canonical Claim/Counterpoint
stores, then repair or validate the Bull, Bear, and Verdict artifacts plus the
ClaimGraphReleaseReceipt before WorkingContext publication. This reconciliation
performs no provider or model calls. WorkingContext publication occurs only
after the original Turn settles as `completed`.

Errors cross the CLI boundary as structured user-facing errors. Internal
conflicts remain diagnosable without persisting secrets or exposing raw
credentials.

## Roadmap and status

The canonical future dependency sequence is maintained in
[`docs/ROADMAP.md`](docs/ROADMAP.md). Mutable current slice status is
maintained in [`docs/PROGRESS.md`](docs/PROGRESS.md).

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
