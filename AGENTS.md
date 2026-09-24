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

apps/cli remains more than a thin host adapter. It still owns substantial Judge,
Session/repl, conversation/context, WorkingContext, provider, and event
orchestration, and is scheduled for extraction in UA.
packages/engine (@harness/engine) currently owns the extracted financial,
Attachment, and Document tool definitions and capability composition, plus
the host-neutral WorkflowTraceRecorder using a host-supplied trace store. UA is
incomplete; do not assume broader engine APIs exist. Do not put new reusable
application/core behavior in CLI when a host-neutral boundary is clearly
required.

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
