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

## Core boundaries and invariants

- `Session → Turn → Execution` is the canonical lifecycle. A conversational
  Turn may have zero ResearchExecutions.
- `/judge` is an explicit workflow boundary. It owns the Researcher → Bull →
  Bear → rebuttal → Judge → deterministic evidence check → Verdict path.
- Bull, Bear, and Judge are workflow-scoped specialists. Other commands do not
  implicitly invoke the debate pipeline.
- Natural-language input is handled by `MainFinHarnessAgent`; it does not
  silently execute `/judge`, `/research`, `/compare`, or `/screen`.
- Provider cache/freshness, Evidence, artifacts, context, and workflow
  execution are separate storage and authority boundaries.
- `SessionWorkingContext` is durable relevance state, `ContextPacket` is a
  model-invocation projection, and `ContextSnapshot` records the exact final
  packet used by a ModelCall.
- Historical artifacts can be reused as bounded same-session context, but they
  do not memoize a new `/judge` or become authoritative current-run evidence.
- Persistence is owned by workflow/composition boundaries, not by model output.

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
`/history`, `/session`, `/resume`, `/web`, `/export`, `/version`, setup/status
commands, and local session controls. `/challenge`, `/compare`,
`/investigate`, and `/research` remain planned stubs.

`/resume` currently displays session state. It is not true same-Execution
Judge resume. `resumeJudgeRun` remains an explicit full re-run helper and is not
connected to the durable restore contracts. `/continue` is not implemented.

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

## Durable resumability foundation — PR O

PR O is complete and merged. It provides generic primitives; it does not
implement the user-facing PR P resume flow.

```text
ResearchExecution
  ├─ lifecycle status
  ├─ resume generation
  ├─ immutable ExecutionProfile
  ├─ WorkflowStep diagnostic trace
  └─ immutable WorkflowNodeOutput
            ↓
future PR P Resume Planner
            ↓
validated restored values
            ↓
generic WorkflowRunner
```

### Restart reconciliation

On local CLI startup, abandoned `running` canonical Executions are reconciled
to `interrupted`. The parent Turn remains `running` while it has only an
interrupted attempt. Reconciliation does not acquire, rerun, create a new
Execution, publish working context, or publish final artifacts. It repairs the
durable lifecycle/projection boundary only.

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

The diagnostic `workflow_steps` trace is not automatically a checkpoint. A
future planner must require a valid immutable node output before reusing a
completed step.

## Storage authority matrix

| Store | Authority |
|---|---|
| ConversationJournal | append-only conversation audit and projection input |
| SessionWorkingContext | versioned durable relevance state |
| Evidence | accepted source observations and provenance |
| FinancialSnapshot | verified execution-scoped financial input manifest |
| ContextSnapshot | exact model invocation context |
| ArtifactStore | semantic Bull/Bear/Verdict research products |
| WorkflowStep | diagnostic execution trace |
| WorkflowNodeOutput | immutable future continuation data |
| ExecutionProfile | immutable run configuration |

These stores are intentionally not interchangeable. Checkpoint/resume is not
provider-cache reuse, artifact reuse, context replay, or journal replay.

## Failure and restart semantics

Required workflow failures settle the canonical Execution as `failed`; user
cancellation settles it as `cancelled`. Process loss is represented as
`interrupted` and remains visible for future acquisition. Final artifact
publication and working-context updates occur only after the surrounding Turn
and Execution semantics permit them. The remaining completion/publication crash
window is a future hardening concern, not an implicit resume guarantee.

Errors cross the CLI boundary as structured user-facing errors. Internal
conflicts remain diagnosable without persisting secrets or exposing raw
credentials.

## Current roadmap

The current and future milestone order is maintained in
[`docs/ROADMAP.md`](docs/ROADMAP.md). The next milestone is:

**PR P — `/judge` Same-Execution Checkpoint / Resume**

PR P must restore the same Execution's validated snapshot, Evidence, and typed
debate outputs, compute a safe DAG frontier, continue the interrupted work, and
repair final publication. It must not be described as a generic workflow rerun
or artifact reuse.
