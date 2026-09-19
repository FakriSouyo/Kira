# FinHarness Progress

Last updated: 2026-09-19

## Current state

The stateful architecture milestones **A–L**, **M**, **N**, and **O** are
complete on master. PR P is complete on the current feature branch and pending
review/merge.

PR O is the durable resumability foundation. PR P connects it to the production
Judge graph for true same-Execution `/judge` resume.

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

## Next milestone

### PR P — `/judge` Same-Execution Checkpoint / Resume

Status: **implemented on feature branch; pending review/merge**

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
