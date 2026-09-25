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
`WorkingContextPublisher` after settlement only on normal success. Live failure
resolution uses its own child-Execution and abort precedence and does not reuse
restart reconciliation. ConversationController, journal and transcript
projection, AgentEvent presentation, command parsing, response streaming, and
special `/new`, `/resume`, and `/continue` lifecycles remain CLI-owned.

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
`/new`, `/resume` and `/continue` control orchestration, `ConversationController`,
`AgentEvent` presentation, context policy, model runtime authority, or
persistence implementation. The CLI owns fresh-input parsing and presentation,
transcript/journal and event projection, streaming display, cancellation
presentation, provider composition, Judge orchestration/checkpointing, and the
special control lifecycles above. Natural-language conversation remains one
Turn with zero `ResearchExecution`. Restart reconciliation and fresh-Turn
orchestration coordinate existing authorities without moving journal mutation
into engine.
