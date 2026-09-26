# `@harness/engine`

This package owns Kira's current host-neutral tool bindings and application
registrations, grants, and capability composition for financial, Attachment,
and Document tools. `createEngineCapabilityRuntime` receives the existing
financial provider and Session-scoped stores, then returns the capability
Gateway and Judge plan used by the current CLI host.

It also owns the host-neutral `WorkflowTraceRecorder`, which translates
`WorkflowEvent` and subagent results into durable trace writes through a
trace store supplied by the host. `WorkflowRunner` owns workflow execution and
event semantics; the recorder is not a database/store authority, and CLI event
projection remains in the CLI.

The engine also owns the host-neutral Screen application workflow. The CLI
retains `/screen` argument parsing and rendering.
`screenWorkflow` invokes `CapabilityGateway`; the gateway delegates execution
to `ToolRuntime`, which invokes the `FinancialDataProvider`.

Authority stays explicit: `@harness/capability` owns capability contracts,
`CapabilityRegistry`, `CapabilityPolicy`, `CapabilityGateway`, and the
authorization mechanism. `@harness/engine` owns application tool bindings,
registrations, and grants. `@harness/tool-runtime` remains execution authority.
Domain packages retain store, provider, and domain truth.

The conversation context coordinator is an engine-owned application boundary
that receives host-supplied WorkingContextStore, ArtifactStore, and
ContextSnapshotStore. Context policy remains in @harness/context; focus/prompt
rendering semantics remain in @harness/orchestrator, and concrete persistence
remains in persistence packages.

The engine also owns WorkingContext publication and journal-reconciliation
orchestration through `createWorkingContextPublisher`. It receives the existing
WorkingContextStore, ArtifactStore, and JudgmentStore contracts, a journal read
callback, and a host audit append callback. The fresh-Turn runner supplies the
completed `ResearchSessionArtifacts`; the publisher does not own Session/Turn
lifecycle or retrieve them itself. WorkingContextStore owns durable
WorkingContext persistence. In production, ConversationController remains the
audit append path so journal correlation and causation stay canonical.

The engine owns host-neutral Workspace and Document application workflows for
`/files`, `/doc-index`, and `/doc-search`. The CLI retains argument parsing,
active lifecycle validation, and rendering. `/files` calls
`CapabilityGateway` as `command.files` for `workspace.list-attachments` and
preserves the returned order. `/doc-index` reads attachment bytes through
`CapabilityGateway` as `command.doc-index` for `attachment.read`, builds the
bundle with `@harness/document`, and saves it through the supplied
`DocumentStore`. `/doc-search` calls `CapabilityGateway` as `command.doc-search`
for `document.search`; Session scoping, ranking, and limits remain in the
existing capability tool and document domain. The workflows preserve
cancellation signals and propagate failures.

The engine also coordinates canonical Session lifecycle reconciliation after a
process restart. It loads Session artifacts through the supplied
`ResearchSessionStore`, interrupts abandoned running Executions, and settles
eligible running Turns using the existing lifecycle outcome precedence. The
store contract remains the lifecycle persistence authority and its database
implementation stays outside engine. ConversationController continues to own
journal correlation and transcript/run/message projection repair.

The engine coordinates the canonical lifecycle around fresh command,
natural-language, and local-input Turns through `runSessionTurn`. It creates and
settles the Turn through the supplied `ResearchSessionStore`, runs host-provided
action work between narrow lifecycle callbacks, and invokes the existing
`WorkingContextPublisher` after settlement only on normal success by default.
Callers may explicitly opt out of both the success-path Session artifact reload
and WorkingContext publication; the failure resolver still reads artifacts
when needed. `/new` uses this opt-out for its old-Session Turn, then CLI creates
and switches to the new Session after canonical completion. Live failure
resolution uses its own child-Execution and abort precedence and does not reuse
restart reconciliation. ConversationController, journal and transcript
projection, AgentEvent presentation, command parsing, response streaming, and
`/new` Session creation/switching remain CLI-owned. CLI retains `/resume` and
`/continue` parsing and target selection.

The engine also coordinates lifecycle around an already-selected and attached
Turn and Execution through `runAttachedSessionTurn`. It reloads the exact
Execution from supplied Session artifacts after the host action. On normal
return, `completed`, `cancelled`, `failed`, and `running` map to parent Turn
statuses `completed`, `stopped`, `failed`, and `failed`; interrupted or missing
targets release the host attachment and leave the Turn running. Normal-success
settlement publishes WorkingContext before host settled projection. A failure
after canonical settlement releases the host attachment once before propagating.
If the action throws, only terminal Execution outcomes settle the Turn, with no
normal-success publication; a running, interrupted, or missing target is
released and remains unsettled. Pre-settlement failures retain the legacy outer
catch reload/reconciliation behavior. It does not create or acquire lifecycle
rows.
CLI retains `/resume` and `/continue` argument validation, target selection,
command input projection, and `ConversationController`; the checkpoint/resume
core validates compatibility before CLI acquisition of the same interrupted
Execution. Action failures
settle a terminal parent Turn without normal-success publication and are
rethrown.

`CapabilityPolicy` and `CapabilityGateway` remain authorization authority,
`ToolRuntime` remains execution authority, `@harness/document` owns extraction,
identity, chunking, and retrieval semantics, and `DocumentStore` remains
persistence authority. `/attach` stays in CLI because local path resolution,
file access, and raw Attachment import are host-specific; engine does not access
the host filesystem or implement persistence.

## Conversation Response Workflow

`conversationRespondWorkflow` and `conversationStreamWorkflow` prepare
conversational context with the supplied `ConversationContextCoordinator`,
invoke the supplied `MainFinHarnessAgent`, and persist successful external
model-call metadata through `ResearchSessionStore.recordModelCall`. The
streaming workflow yields chunks in order and leaves presentation to its host.
Both workflows accept the current dependencies per call so provider, model,
and Session rebinding remains owned by the CLI composition.

The engine does not create providers or databases, or own Session switching,
`/new` Session creation/configuration/switching, `/resume` and `/continue`
parsing/target selection, ConversationController, `AgentEvent` presentation,
context policy, model runtime authority, or persistence implementation. The CLI
owns fresh-input parsing and presentation, `/new` Session creation, runtime
rebinding and switching, transcript/journal and event projection, streaming
display, cancellation presentation, provider composition, Judge Execution
lifecycle and WorkflowRunner composition, same-Execution acquisition,
release planning/publication and startup repair, trace
composition, and control-command input projection. The engine plans and
validates the restore frontier; CLI acquires the same interrupted Execution
only after that plan succeeds.
Natural-language conversation remains one Turn
with zero `ResearchExecution`. Restart reconciliation, fresh-Turn orchestration,
and attached-Turn orchestration coordinate existing authorities without
moving journal mutation into engine.

## Judge Node Runtime

`createJudgeNodeExecutors` owns the host-neutral Judge node application logic:
financial capability invocation and verification, Evidence acceptance,
FinancialSnapshot materialization, Evidence selection, Bull/Bear/Judge calls,
Claim and Counterpoint grounding, conversation persistence, and deterministic
evidence and verdict gates. It receives the existing specialist and
CapabilityGateway contracts plus supplied Evidence, FinancialSnapshot,
Conversation, Claim, Counterpoint, and Judgment stores. Those contracts remain
the authorities; the engine does not open or wrap a database.

The runtime emits a narrow `JudgeNodeEvent`, keeps `JudgeProgress` as a supplied
callback, forwards raw ToolRuntime events through `onToolEvent`, and receives
checkpoint and trace callbacks from its host. The CLI adapts ToolRuntime events
to its existing `tool.start` / `tool.complete` events and retains Judge
Execution lifecycle, `WorkflowRunner` composition, release planning/publication,
trace recorder composition, and workflow/session/verdict `AgentEvent`
projection. The 15-node graph, workflow version, capability plan, checkpoint
format, resume rules, and release contract remain unchanged.

## Judge Checkpoint + Resume Core

`JudgeCheckpointWriter`, `workflowDependencyFingerprint`, `planJudgeResume`,
`decodeJudgeCheckpoint`, and the shared `planJudgeCheckpoint` primitive live in
`src/judge/checkpointResume.ts`. The module owns payload encoding and decoding,
WorkflowNodeOutput coordination, compatibility checks, and sequential
graph-order restore-frontier derivation. Release planning in the CLI reuses the
same engine planning and decoding implementation rather than keeping a second
checkpoint validator.

The engine receives only `save` and `listNodeOutputsForExecution` for
WorkflowNodeOutput; `getById` for FinancialSnapshot and ContextSnapshot; and
`getManyByIdsForRun` for Evidence. It re-verifies financial observations,
validates snapshot ownership and fingerprints, restores Evidence within the
Execution and ticker scope, and checks ContextSnapshot Session/Turn ownership.
It does not import `FinharnessDatabase`, `@harness/database`, or CLI modules.

The CLI still owns Execution lifecycle and same-Execution acquisition, resume
target selection, WorkflowRunner and trace composition, release publication
and startup release repair, and AgentEvent projection. Resume compatibility
planning completes before acquisition. The same Execution is resumed, and
`resumeGeneration` remains owned by the existing execution store/acquisition
flow.

## Judge Resume Projection Repair

`repairJudgeProjections` and its `JudgeProjectionRepairStores` contract live in
`src/judge/projectionRepair.ts`. The engine replays validated checkpoint outputs
into existing WorkflowStep, Conversation, Claim, Counterpoint, Judgment, and
ModelCall authorities. It receives only step get/save and ModelCall list/record
operations, Conversation `addMessage`, Claim `save` and legacy checkpoint
repair, Counterpoint `save`, and Judgment `save`. The projection-specific
`listModelCallsForStep` operation is supplied through the narrow trace contract;
the canonical `ResearchSessionStore` interface is unchanged.

The repair path reuses `auditFromPayload` and `parseCheckpointCounterpoints`
from the checkpoint/resume core. It preserves current and historical Claim/Bear
behavior, message identities/order, deterministic step and ModelCall IDs,
attempt one, null replay cost/currency, and idempotency. It replays durable
checkpoint state and has no model, provider, tool-runtime, CLI, or concrete
database dependency. CLI wraps its stores into the narrow contract and retains
resume-target validation, same-Execution acquisition, `WorkflowRunner` and trace
composition, release planning/publication, startup release repair, and
`AgentEvent` projection. Resume remains ordered: plan, acquire, repair, then
`WorkflowRunner`.
