# FinHarness PR O Final Architecture Review

Historical architecture review from the FinHarness era. The current project is
Kira; current architecture authority is ARCHITECTURE.md.

Date: 2026-09-19
Branch: `feat/pr-o-durable-resumability-foundation`
Scope: PR O durable resumability foundation only. PR P was not implemented.

## 1. Decision

**B. FIX REQUIRED**

The reported implementation commit `1f22c87` had two concrete correctness defects in immutable-envelope idempotency. Both were corrected in the separate follow-up commit `dfbb8ebf14f7b99adae5e54d82233bf509ecf5e7`, and the corrected candidate passed the full verification suite.

The corrected candidate is ready for a subsequent approval/merge decision. This review does not approve the original `1f22c87` as-is.

No `/resume` true resume, `/continue`, Judge checkpoint codecs, Judge resume planner, provider generalization, push, or merge was performed.

## 2. Actual Git state

- Branch: `feat/pr-o-durable-resumability-foundation`
- `origin/master`: `37b7517d6f45b1589d1f1c31ad49debc2b6bc9bc`
- Merge-base with `origin/master`: `37b7517d6f45b1589d1f1c31ad49debc2b6bc9bc`
- Corrected implementation HEAD: `dfbb8ebf14f7b99adae5e54d82233bf509ecf5e7`
- Final hardening commit: `test: harden PR O persistence and graph identity`
- Commits after `origin/master`:
  - `1f22c87` — `feat: add durable resumability foundation`
  - `dfbb8eb` — `fix: preserve resumability envelope idempotency`
- `559f61b` — `docs: record PR O final architecture review`
  - final hardening commit — `test: harden PR O persistence and graph identity`
- Implementation diff through `dfbb8eb`: 25 files, 1,152 insertions, 36 deletions.
- Post-correction delta contains only the review report, README roadmap, and focused tests; no runtime source changes.
- The implementation worktree was clean before this report artifact was added.
- No remote state was changed.

The correction commit is separate from the original PR O implementation commit, as required by the review gate.

## 3. Lifecycle state model

`ExecutionStatus` is exactly:

`running | interrupted | completed | failed | cancelled`

`interrupted` is non-terminal. `completed`, `failed`, and `cancelled` are terminal. `ResearchExecution` retains the same ID and attempt row across interruption and reacquisition; `resumeGeneration` fences the new runtime generation.

There is no terminal reopening path.

## 4. Transition matrix

| From | To | Mechanism | Result |
|---|---|---|---|
| `running` | `completed` | `settleExecution` | allowed once |
| `running` | `failed` | `settleExecution` | allowed once |
| `running` | `cancelled` | `settleExecution` | allowed once |
| `running` | `interrupted` | `interruptExecution` | allowed once |
| `interrupted` | `running` | `acquireInterruptedExecution` | allowed once; increments generation |
| terminal | any other state | no API path | rejected |
| `interrupted` | terminal | `settleExecution` | rejected until reacquired |

Application enforcement exists in `transitionExecution`, the dedicated store methods, and the runtime guard that rejects `running`/`interrupted` through generic settlement. Persistence adds the execution status check and non-negative generation check. Terminal rows cannot be reopened.

## 5. Same-execution reacquisition

`acquireInterruptedExecution` updates the existing row in place. It does not call `createExecution`, does not allocate a new ID, does not increment `attempt`, and preserves the session/turn ownership. The database test verifies:

- the ID remains `run-resume`;
- `attempt` remains `1`;
- generation changes from `0` to `1`;
- a second acquire is rejected.

## 6. Atomic acquisition and fencing

Acquisition runs in a SQLite transaction and performs a conditional update with `WHERE id = ? AND status = 'interrupted'`. Exactly one writer can change the row from `interrupted` to `running`; a competing writer cannot also satisfy the predicate.

The current test is sequential acquire-then-reject rather than a true concurrent `Promise.all`/multi-connection race. That is a test-quality limitation, not an identified double-acquisition defect in the conditional-update implementation.

Generation behavior is monotonic:

- new executions start at generation `0`;
- successful acquisition increments by exactly one;
- failed acquisition does not increment;
- no decrement path exists;
- node-output writes require the current execution generation.

PR O does not introduce a heartbeat, lease, worker registry, remote coordinator, or Temporal-like scheduler. Startup reconciliation is intentionally local-CLI process-loss handling, not a multi-process liveness protocol.

## 7. Turn semantics and startup reconciliation

An interrupted execution does not settle its parent turn. The canonical state remains:

`Turn = running; Execution = interrupted`

`ConversationController.restore()` changes abandoned canonical `running` executions to `interrupted`, leaves the parent turn running when that is the only attempt, and leaves the journal run block visibly running. It does not:

- acquire or execute a workflow;
- create a new execution;
- settle the turn;
- publish `SessionWorkingContext`;
- publish final artifacts.

If a completed or failed attempt already exists, canonical terminal state wins during reconciliation. The local CLI assumes the previous runtime is gone when it starts; there is no claim that a second live process can be safely detected without a lease/heartbeat.

## 8. ExecutionProfile

### Ownership and dependency direction

The generic envelope and constructors live in `packages/session/core/src/resumability.ts`. The SQLite store lives in `packages/database`. The Judge-specific payload and factory live in `packages/command/judge/src/profile.ts`.

The generic packages do not import Judge, Sectors API, CLI, or Bull/Bear/Judge packages. The dependency direction is generic runtime/session primitives first, Judge specialization above them.

### Persisted fields

The `execution_profiles` table persists:

- `execution_id`
- `schema_version`
- `workflow_id`
- `workflow_version`
- `graph_fingerprint`
- `command`
- `ticker`
- `payload_json`
- `fingerprint`
- `created_at`

The Judge payload truthfully contains `reasoningMode`, `conditional`, `researchers.market`, `researchers.news`, `provider`, and `model`. These values come from the active execution configuration: flags passed to `judgeWorkflow`, `ctx.researchers`, and `ctx.config.llm.agent`, before provider/model work begins.

### Creation timing

The lifecycle-backed Judge path creates the canonical execution, saves the profile, and only then creates the workflow adapters and invokes the runner. The profile-capture test asserts the save occurs before the first company-report provider call. A profile-storage failure causes the execution to fail before any provider call; that path is directly tested.

### Fingerprint and immutability

The profile semantic fingerprint is SHA-256 over canonical JSON containing:

`executionId`, `workflowId`, `workflowVersion`, `graphFingerprint`, `command`, `ticker`, and `payload`.

Canonical serialization provides deterministic key ordering. `createdAt`, schema metadata, function source, paths, wall-clock values, and environment paths are excluded. Execution ID is intentionally included because the profile identifies one canonical execution.

Same semantic profile for one execution is idempotent. A different semantic profile conflicts and does not overwrite the stored row.

### Findings fixed in `dfbb8eb`

1. The original profile store compared `createdAt` in addition to the semantic fingerprint. A retry with the same semantic profile but a different operational timestamp incorrectly conflicted. The store now compares the semantic fingerprint only and retains the original stored timestamp. Regression coverage is in `packages/database/test/resumability.test.ts:67-69`.

2. The original node-output store treated `completionGeneration` as semantic identity even though the output fingerprint intentionally excludes it. A later valid generation therefore conflicted with an identical immutable output. The store now fences stale generations before comparing semantic output and excludes generation from semantic equality. Regression coverage is in `packages/database/test/resumability.test.ts:94-99`.

## 9. Workflow identity, version, and graph fingerprint

Judge has explicit `JUDGE_WORKFLOW_VERSION = 1`; it is not derived from the package version, date, commit hash, or documentation changes. A future incompatible graph/profile contract can advance this version deliberately.

The generic graph fingerprint hashes canonical data containing workflow ID, workflow version, node IDs, dependency arrays, required/optional semantics, executor identity, and the presence of an enabled/conditional predicate. It excludes JavaScript function bodies, closures, absolute paths, timestamps, and machine metadata.

Conditional predicates are not serialized. The immutable profile payload captures the runtime configuration (`reasoningMode`, `conditional`, and researcher flags), while the graph fingerprint captures the stable topology and conditional-node shape. This is sufficient for PR P to distinguish profile configuration from graph compatibility without hashing executable code.

The Judge definition remains exactly 15 nodes with the existing IDs and topology. The topology and conditional gating tests remain green. The hardening pass adds focused deterministic tests for identical graphs, dependency changes, node addition/removal, required-vs-optional changes, and non-semantic labels/function source.

## 10. WorkflowNodeOutput

### Canonical schema and ownership

The canonical data-only envelope is `WorkflowNodeOutput` in `packages/session/core/src/resumability.ts`. Fields are:

- `outputId`
- `schemaVersion`
- `executionId`
- `workflowId`
- `workflowVersion`
- `nodeId`
- `status` (`completed` or `skipped`)
- `outputKind`
- `dependencyFingerprint`
- `outputFingerprint`
- nullable JSON `payload`
- `completionGeneration`
- `createdAt`

The store requires a real canonical lifecycle execution, a linked session/turn/attempt, an existing execution profile, matching workflow ID/version, and the current resume generation. It rejects missing execution/profile, workflow mismatch, invalid envelope identity, and stale generation. Node-ID validation against an actual graph is intentionally left to the future Judge planner because this generic store has no graph domain knowledge.

### Data-only serialization

`assertJsonValue` rejects functions, class instances, streams, handles, abort controllers, clients, non-finite numbers, and other non-plain values. SQLite also enforces JSON validity for payloads. The generic contract permits typed data or references; it does not itself dump provider clients or HTTP envelopes. Future codecs must keep payloads minimal and secret-free.

### Fingerprint and immutability

The output semantic fingerprint is SHA-256 over canonical JSON containing execution ID, workflow ID/version, node ID, status, output kind, dependency fingerprint, and payload. `outputId`, `completionGeneration`, and `createdAt` are excluded so retries and valid reacquisition do not change semantic identity.

Same execution + node + semantic output is idempotent. A different semantic value conflicts. There is no mutable latest-output update path.

The store checks existing node identity and output-ID identity, and the database has `UNIQUE(execution_id, node_id)`. The correction commit ensures generation fences stale writers without making identical later-generation output conflict.

### Dependency fingerprint boundary

PR O stores a caller-supplied deterministic dependency fingerprint as an opaque 64-character value. The generic layer cannot derive domain dependency state. PR P codecs/planner must generate it from the exact validated data consumed by each node, excluding time, renderer state, and provider freshness policy.

## 11. Database migration and constraints

Migration `0013_durable_resumability.sql` is appended after unchanged PR N migration `0012_financial_snapshots.sql`.

It rebuilds `executions` to add:

- the `interrupted` status check;
- `resume_generation INTEGER NOT NULL DEFAULT 0 CHECK(resume_generation >= 0)`;
- preserved lifecycle foreign keys, indexes, and `(turn_id, attempt)` uniqueness.

It creates:

- `execution_profiles`, keyed by execution ID and cascading with the execution;
- `workflow_node_outputs`, with JSON checks, schema/status checks, execution foreign key, `UNIQUE(execution_id, node_id)`, and an execution/time index.

Migration execution temporarily disables foreign keys only for the table rebuild, runs `foreign_key_check`, and restores enforcement. Existing migrations are not edited. There is no generic checkpoint blob table and no PR P-specific schema leakage.

## 12. WorkflowRunner restore API

The generic API is:

```ts
type WorkflowRestoreSeed =
  | { nodeId: string; status: 'completed'; value: unknown }
  | { nodeId: string; status: 'skipped' };

runner.run(definition, context, { signal, restored });
```

`WorkflowRunner` imports only generic command/runtime and shared canonical JSON utilities. It does not import FinancialSnapshot, Evidence, Bull, Bear, Judge, Sectors, or a database store.

The restore path validates unknown IDs, duplicate IDs, status values, skipped-value shape, enabled-state consistency, unknown dependencies, and restored dependency closure. Restored completed values are passed into downstream node inputs exactly; restored skipped nodes satisfy dependencies with `undefined`; restored nodes do not call `node.run`.

Pending nodes are derived from dependency completion, not a linear index. The mixed restored/pending test restores research and a conditionally skipped debate, then runs only the pending summary node with restored values.

## 13. DAG/frontier semantics and trace events

The runner computes each frontier as nodes whose dependencies are in `finished`, executes independent ready nodes concurrently, waits for settlement events, and then derives the next frontier. It rejects dependency cycles when an unsatisfied frontier is encountered.

Restore emits `workflow.step.restored` with `completed` or `skipped`. It does not emit synthetic `started` or `completed` events for restored nodes. `WorkflowTraceRecorder` ignores the restore event, preventing restored data from fabricating fresh timing in the historical workflow-step trace. The UI mapping understands the new event.

`workflow_steps` remains a diagnostic execution trace. `WorkflowNodeOutput` remains a separate immutable reuse candidate. PR O does not treat a completed trace row as a reusable checkpoint and does not implement a node-output commit boundary. A future planner must require a valid durable output and handle the crash window where a step trace and node output do not agree.

## 14. Fresh `/judge` parity and PR N regression audit

The production lifecycle-backed `/judge` still uses the same `WorkflowRunner`, same 15-node graph, same adapters, same Evidence flow, same verified financial snapshot boundary, same typed artifacts, and same working-context publication path after the parent turn settles.

The PR N regression suite remains green, including:

- one immutable `FinancialSnapshot` per execution;
- truthful provider metadata and cache-preserved `fetchedAt`;
- Evidence linkage;
- snapshot finalization before Bull;
- optional enrichment degradation;
- specialist/context blindness boundaries;
- derived sentiment without a paid sentiment call;
- no extra provider calls;
- artifact and working-context behavior.

PR O does not add financial calls or alter provider policy. The parity matrix remains:

| Operation | PR N | PR O |
|---|---:|---:|
| Company Report | unchanged | unchanged |
| Quarterly Financials | unchanged | unchanged |
| Daily Transaction | unchanged | unchanged |
| Foreign Flow | unchanged | unchanged |
| News | unchanged | unchanged |
| Filings | unchanged | unchanged |
| Paid sentiment | unchanged | unchanged |

The fresh `/judge` parity tests cover provider-call counts, evidence and conversation artifacts, node trace projection, specialist calls, artifacts, and canonical lifecycle settlement. No live provider/model calls were used for verification.

## 15. Artifact, context, snapshot, and journal separation

`ExecutionProfile` is run configuration. `WorkflowNodeOutput` is future continuation data. `ArtifactStore`, `FinancialSnapshot`, `ContextSnapshot`, `SessionWorkingContext`, and `ConversationJournal` remain separate stores with separate authority.

PR O does not store node outputs as artifacts, does not place checkpoints in context snapshots, does not add generation/checkpoint fields to the PR N financial snapshot, and does not reconstruct node state from journal replay. Startup reconciliation uses canonical lifecycle rows and only repairs the visible projection.

The pre-existing completion/publication crash window remains: lifecycle execution is settled `completed` before final typed artifacts are saved. PR O did not introduce this ordering and does not claim to repair it; it remains deferred to future resume/publication work.

## 16. Legacy direct Judge path and current `/resume`

The non-lifecycle direct `judgeWorkflow` path still uses the legacy execution store and intentionally receives no PR O profile or node-output guarantees. It remains compatible but is not falsely marked resumable.

`/resume <runId>` remains a display/session-view command. `resumeJudgeRun` remains an explicit full re-run helper and is not wired into the canonical lifecycle or restore runner. There is no `/continue` implementation.

## 17. PR P leakage and model-runtime audit

Changed-code search found no Judge resume planner, checkpoint codecs, snapshot rehydration into restored runner values, conditional-decision restore path, working `/resume`, `/continue`, model registry, provider-neutral model router, or capability runtime.

The only allowed provider/model additions are the truthful identity fields in the execution profile. PR O remains a generic storage/runtime foundation, not a completed resume feature and not model-runtime generalization.

## 18. Test quality matrix

| Claim | Coverage | Assessment |
|---|---|---|
| interrupted lifecycle | direct database test | covered |
| same-ID reacquire | direct database test | covered |
| atomic double-acquire | sequential second-acquire rejection | implementation covered; concurrent race test absent |
| generation increment | direct database test | covered |
| parent Turn remains running | direct store rejection plus restart test | covered |
| startup reconciliation | new controller instance over persisted rows | covered; direct close/reopen is not used in this CLI test |
| immutable profile | direct database test | covered |
| profile restart | close/reopen database and read by Execution ID | covered |
| profile drift conflict | payload drift direct test | covered; model/researcher drift variants indirect |
| graph fingerprint | focused deterministic identity/drift test | covered |
| immutable node output | direct database test | covered |
| output restart | close/reopen database and read by Execution ID/node ID | covered |
| output conflict | payload conflict direct test | covered |
| generation/output interaction | reacquired-generation retry plus stale writer | covered after `dfbb8eb` |
| restored completed node | runner test | covered |
| restored skipped node | runner test | covered |
| mixed restored/pending frontier | runner test | covered |
| invalid restore seed | runner test | covered for unknown and invalid status; duplicate/disabled cases are implementation-validated but not each separately asserted |
| restored event semantics | runner test plus trace-recorder behavior | covered |
| fresh `/judge` parity | 21-test parity file and full suite | covered |
| provider-call parity | parity and financial snapshot tests | covered |
| PR N regression | snapshot/artifact/context suites | covered |

The requested restart and graph-identity acceptance gaps are now directly covered. The store tests close the first SQLite connection and reopen the same database directory through a new `openDb` instance; they do not rely on an already-open in-memory store.

## 19. Full verification

The corrected candidate passed:

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `git diff --check origin/master...HEAD`

The pre-hardening baseline after `dfbb8eb` was 76 test files and 510 tests. Final hardening result: **77 test files, 516 tests passed**, including the two restart tests and four graph-fingerprint tests. No live provider or model call was made.

## 20. Documentation truthfulness

README and ARCHITECTURE describe PR O as a durable foundation, state that `/resume` remains display-only, identify `resumeJudgeRun` as a full re-run, and reserve `/judge` checkpoint codecs/planner for PR P. They do not claim that FinHarness can already resume interrupted Judge runs.

The implementation roadmap retains A-L, M, N, and O completion and now lists the intended order: PR P same-Execution checkpoint/resume, Model Runtime Generalization, Capability Registry + Typed Tool Runtime, Document & File Workspace, Evidence Policy + Claim Graph, Reusable Research Subgraphs, Risk Committee, Research Graph, Decision Journal, Outcome Tracking + Reflection, and UI integration/polish. PR O remains explicitly foundation-only and `/resume` remains display-only.

The public generic contracts are documented in `ARCHITECTURE.md`, the root README, and package-level source comments. No package README churn is required for correctness, though the restore API could receive a short package README example in future documentation cleanup.

## 21. Remaining non-blocking observations

- Add a deterministic two-caller acquisition test using separate SQLite connections if a non-flaky harness is available.
- Consider validating the complete graph for cycles even when every node is supplied as a restore seed; the current cycle guard is exercised when a pending frontier is scheduled, while a fully restored malformed graph has no remaining frontier.
- Keep the narrow crash window between canonical execution creation and profile insertion visible to PR P; a process dying in that interval can leave an interrupted execution without a profile, which must be treated as non-resumable rather than guessed.
- Keep generic payload guidance explicit: future codecs should persist minimal typed results or references, never raw provider responses or secrets.

None of these observations establishes a current PR O release blocker after `dfbb8eb`.

## 22. Direct answer

**Yes, with the correction commit applied:** PR O now provides a durable and generic foundation from which PR P can safely implement true same-Execution `/judge` resume. It preserves the canonical lifecycle, immutable configuration profile, graph identity, fenced immutable node outputs, generic restored-value runner contract, and fresh `/judge`/PR N behavior without pretending that user-facing resume already exists.

The original reported candidate was not approvable as-is because of the two corrected idempotency defects. The corrected candidate is the one that should proceed to the next approval gate.
