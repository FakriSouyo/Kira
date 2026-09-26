# AGENTS.md

Kira is an evidence-backed financial research engine. This file is the concise
repository constitution; it does not replace the canonical project documents:

- [ARCHITECTURE.md](ARCHITECTURE.md) — current architecture and labelled target direction
- [docs/ROADMAP.md](docs/ROADMAP.md) — canonical future dependency sequence
- [docs/PROGRESS.md](docs/PROGRESS.md) — mutable current project status
- [CHANGELOG.md](CHANGELOG.md) — historical release record

## Source authority

Current source, tests, configuration, and Git state are operational truth.
Documentation is evidence and navigation; when it conflicts with source, verify
and correct the documentation. Do not infer an implemented feature from a
roadmap or historical design document.

## Architecture boundary

apps/cli remains more than a thin host adapter. It owns command dispatch,
Session switching and new-Session creation/configuration for `/new`, plus
`/resume` and `/continue` argument validation and target selection,
control-command input projection, Judge Execution lifecycle and WorkflowRunner
composition, same-Execution acquisition, release planning/publication and
startup repair, trace wiring, provider composition, CLI event projection and streaming presentation, and
ConversationController. It also owns journal
correlation/causation when audit events are appended.
packages/engine (@harness/engine) owns financial, Attachment, and Document
capability composition, WorkflowTraceRecorder, Screen workflow, conversation
context preparation and Conversation Response orchestration, WorkingContext
publication/reconciliation orchestration, and the host-neutral
Workspace/Document application workflows for `/files`, `/doc-index`, and
`/doc-search`, plus host-neutral Session restart and attached-Turn lifecycle
orchestration through `ResearchSessionStore` and `WorkingContextPublisher`.
The Judge node application runtime coordinates the existing CapabilityGateway,
specialist runtimes, and supplied Evidence, FinancialSnapshot, Conversation,
Claim, Counterpoint, and Judgment stores.
`runSessionTurn` owns canonical fresh-Turn lifecycle orchestration for ordinary
commands, natural language, local input, and the old-Session Turn for `/new`.
The conversation workflow prepares context, invokes
MainFinHarnessAgent, and persists successful ModelCall provenance through
supplied contracts. These engine boundaries use host-supplied store contracts
and narrow callbacks; their persistence implementations remain outside engine.
WorkingContextStore owns durable WorkingContext persistence, and CLI's
ConversationController remains the production journal correlation path. CLI
still owns fresh-input parsing and presentation, `/new` Session creation,
configuration/provider/model rebinding and switching, `/resume` and `/continue`
argument validation and target selection,
control-command input projection, transcript/journal projection, Judge
Execution lifecycle and WorkflowRunner composition, same-Execution acquisition,
release planning/publication and startup repair, trace composition, provider
composition, CLI event projection, streaming presentation, and local-path
Attachment import. The engine owns host-neutral Judge checkpoint
encoding/decoding, resume compatibility planning, restore-frontier derivation,
and durable Judge resume projection repair through supplied narrow store
contracts. The CLI validates the resume target and acquires the same interrupted
Execution only after engine planning succeeds.
Engine coordinates the host-neutral attached-Turn lifecycle after CLI selects
the existing Session, Turn, and Execution. Engine does not own
ConversationController, AgentEvent presentation, host filesystem access, or
persistence implementation. UA is incomplete; do not assume broader engine
APIs exist. Do not put new reusable application/core behavior in CLI when a
host-neutral boundary is clearly required.

For attached-Turn lifecycle behavior, preserve the source distinction: normal
return maps a still-running target Execution to a failed Turn, while an action
failure with a running target releases the attachment and leaves the Turn
running. Interrupted or missing targets release in either path. If normal
success has already settled the canonical Turn and a later reload, publication,
or host projection fails, release the host attachment once before propagating.
Pre-settlement failures retain the legacy outer-catch reconciliation behavior.

The future engine coordinates existing authorities. It must not replace
Evidence, Claims, capability authorization, ToolRuntime, database, providers,
or graph ownership. See ARCHITECTURE.md for current facts and target direction.
Internal @harness names, .finharness storage/configuration, FINHARNESS_* settings,
and legacy TypeScript symbols are deferred to KB; keep them source-accurate
until that migration is explicitly selected.

## Repository rules

- Do not introduce abstractions, configuration layers, or fallback paths
  without a concrete current consumer and reviewed architectural need.
- Keep the pnpm workspace strict: declare every imported workspace dependency
  in the owning package manifest. The project is ESM-only and runs TypeScript
  source directly.
- packages/database owns SQLite schema/migration implementation. Keep database
  column naming and TypeScript mapping explicit there; do not create parallel
  persistence authorities.
- Keep deterministic policy and domain behavior in code; LLMs do not own
  evidence acceptance, claim policy, authorization, persistence, or verdict
  integrity.
- Preserve byte-identical prompt-cache zones and MockLLM prompt markers. Update
  the mock contract and focused tests when a prompt marker changes.
- Map failures to structured user-facing errors before they reach the
  terminal. Preserve the current Judge graph, version, release, and capability
  contracts unless the reviewed slice explicitly changes them.
- Preserve current Session → Turn → Execution, Judge, capability, ToolRuntime,
  checkpoint/resume, context, persistence, and provider contracts. Read the
  architecture map before changing these boundaries.
- Keep tests offline with mocks. Do not add dependencies or tooling without a
  reviewed architectural need. CLI E2E tests spawn the real source entry point
  in mock mode.
- Run pnpm check and pnpm lint for code changes. pnpm check runs typecheck and
  the test suite.
- On Windows, close a database before deleting its temporary directory; E2E
  subprocesses use Node with the local tsx entry point.

## Source review

Review the actual source diff before committing. This repository's pre-commit
source-review gate is mandatory; a plan, report, or generated summary does not
replace review of the complete changed source. Do not commit, push, or create a
PR before the source-review gate is approved.
