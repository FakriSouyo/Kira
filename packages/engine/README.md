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

The engine does not create providers or databases, or own Judge workflows,
Session lifecycle, CLI events, or persistence authority.
