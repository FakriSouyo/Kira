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
control-command input projection, Judge host cancellation classification and
error policy, completed-release reconciliation invocation and database-to-store
adapters, startup invocation timing, provider composition,
CLI event projection and streaming presentation, and ConversationController.
It also owns journal
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
MainKiraAgent, and persists successful ModelCall provenance through
supplied contracts. These engine boundaries use host-supplied store contracts
and narrow callbacks; their persistence implementations remain outside engine.
WorkingContextStore owns durable WorkingContext persistence, and CLI's
ConversationController remains the production journal correlation path. CLI
still owns fresh-input parsing and presentation, `/new` Session creation,
configuration/provider/model rebinding and switching, `/resume` and `/continue`
argument validation and target selection,
control-command input projection, transcript/journal projection, Judge
abort classification and host error policy, Judge
release/reconciliation store adaptation, startup invocation timing,
provider composition, CLI event
projection, streaming presentation, and local-path Attachment import. The
engine owns Judge execution preparation and resume planning/acquisition of the
same interrupted Execution through supplied lifecycle, profile, and checkpoint
store contracts. It also owns Judge workflow runtime composition through the canonical
WorkflowRunner, trace/checkpoint wiring, post-acquisition projection repair,
restore-state composition, and typed runtime results. It also owns host-neutral
Judge checkpoint encoding/decoding, resume compatibility planning,
restore-frontier derivation, durable Judge resume projection repair, the current
Judge release core, completed Judge release reconciliation, and historical
artifact reconstruction through supplied narrow store contracts. Engine also
owns canonical lifecycle resolution through `runJudgeExecutionLifecycle`, which
composes Judge preparation, runtime, and completion. `completeJudgeExecution`
uses the immutable profile to select current release
validation before settlement and current publication afterward, or historical
artifact reconstruction after settlement. The lifecycle coordinator also owns
failure/cancellation settlement and the no-resettlement boundary after
completion. A typed post-settlement error carries the completed Execution and
publication cause so the CLI can project completion without settling it again.
The host selects the resume target; the engine validates and plans it before
calling the existing atomic same-Execution acquisition authority. CLI supplies
the host abort classifier, maps engine errors to host-facing errors, and projects
AgentEvents. UA17A, UA17B, UA17C, and UA17D are complete on master. This closes
the planned UA Kira Engine Extraction phase; KB Internal Kira Identity Migration
is the current broad phase. KB1 renamed the CLI runtime config type from
FinharnessConfig to CliConfig. KB2 renamed the main conversational agent class and prompt constant to their
Kira identities. Other internal
source symbols, package names, storage paths, and environment variable names
remain unchanged and require separate source review before migration. Future engine or product
development remains subject to its own source review.
Engine coordinates the host-neutral attached-Turn lifecycle after CLI selects
the existing Session, Turn, and Execution. Engine does not own
ConversationController, AgentEvent presentation, host filesystem access, or
persistence implementation. Do not assume unplanned engine APIs exist. Do not
put new reusable application/core behavior in CLI when a host-neutral boundary
is clearly required.

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
Internal @harness names, .finharness storage/configuration, and FINHARNESS_*
settings remain unchanged. The main conversational agent class and prompt constant were renamed by KB2;
keep other legacy TypeScript symbols source-accurate unless a
later slice is separately selected after source review.

## Repository rules

`KIRA_TRANSACTION_AUTHORITY = HUMAN_ONLY`: the human owns every transaction
decision. Kira does not own transaction authority. Do not add BUY/SELL/HOLD
mappings, autonomous transaction recommendations, position-sizing advice, or
broker/order execution authority.

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
