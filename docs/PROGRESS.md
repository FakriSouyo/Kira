# FinHarness Progress

Last updated: 2026-09-20

## Current state

The stateful architecture milestones **A–P** are complete on master.

The current milestone is **Q2 — Durable Model Selection + Production Integration**.

PR O is the durable resumability foundation. PR P connects it to the production
Judge graph for true same-Execution `/judge` resume. Q1 established the
provider-neutral model runtime seam; Q2 connects it to durable Session
selection, production context budgeting, actual ModelCall provenance, and
runtime-plan-aware Judge profiles without changing PR P lifecycle semantics.

## Recently completed

### PR O — Durable Resumability Foundation

Key result:

```text
interrupted lifecycle
        +
immutable ExecutionProfile
        +
workflow version / graph fingerprint
        +
immutable WorkflowNodeOutput
        +
WorkflowRunner restore seeds
        +
startup reconciliation
```

PR P adds typed Judge checkpoints, a pre-acquisition compatibility gate,
same-Turn control-command handling, DAG-safe restore, projection repair,
idempotent final publication, `/resume <executionId>`, and `/continue`.

### PR N — Verified Financial Snapshot

Key result:

```text
FinancialDataProvider
        ↓
deterministic verification
        ↓
Evidence
        ↓
VerifiedFinancialSnapshot
        ↓
Bull / Bear / Judge
```

The snapshot is immutable, execution-scoped, and finalized before reasoning.

### PR M — Financial Data Provider Seam

Financial workflows use a provider-neutral contract, with Sectors remaining the
current provider implementation. Retrieval policy and provider metadata remain
separate from evidence and snapshots.

## Current milestone

### Q1 — Model Runtime + Provider Directory

Status: **complete on master**

Q1 evolved `@harness/llm` into the canonical provider-neutral runtime seam.
It provides immutable provider/model directory snapshots, explicit logical
provider routes, adapter/protocol separation, safe runtime descriptors and
fingerprints, one-shot prepared calls, actual invocation metadata, and mock
parity.

### Q2 — Durable Model Selection + Production Integration

Status: **implemented on this branch**

Q2 adds append-only, restart-persistent `SessionModelSelection` rows and keeps
default configuration, Session intent, execution runtime plans, and actual
ModelCall provenance distinct. Session-local model setters no longer write
`config.json`. The selected logical provider is composed into a pure runtime
plan with ordered fallbacks and effective capabilities; real Context budgeting
uses that plan.

MainFinHarnessAgent and SubagentRuntime use result-bearing runtime calls, and
durable ModelCalls persist actual provider/model, adapter, protocol, and
secret-free runtime fingerprints. New Judge profiles pin the semantic runtime
plan while old PR P profiles remain readable. Resume continues to mean the
same Execution and same Turn; Q2 does not redesign checkpoints or add another
`/resume` implementation.

### PR P — `/judge` Same-Execution Checkpoint / Resume

Status: **complete on master**

Target behavior:

```text
Execution #52

Financial Snapshot     restored
Evidence               restored
Bull                   restored
Bear                   restored
Rebuttal               restored
Judge                  interrupted

        ↓ /resume #52

Execution #52

Judge                  execute
evidence check         execute
verdict synthesis      execute
final publication      repaired / completed
```

The invariant is the same Execution. No Execution #53 is created by resume.

## Current command status

Implemented commands include `/judge`, `/screen`, `/search`, `/history`,
`/session`, `/resume <executionId>`, `/continue`, `/web`, `/export`, `/version`,
`/auth-set`, `/setup`, `/status`, `/providers`, `/new`, `/help`, and `/exit`.

The command surface also contains planned stubs for `/challenge`, `/compare`,
`/investigate`, and `/research`.

## Maintenance policy

Update this file when:

- a major architecture PR merges;
- the current milestone changes;
- the next milestone changes materially.

Do not create a new progress folder or per-PR status file. This document is the
single mutable current-status view; Git history records previous versions.
