# Full TUI and Agent Engine Implementation Plan

**Design:** `docs/superpowers/specs/2026-09-08-full-tui-agent-engine-design.md`

**Method:** Vertical slices with strict red-green-refactor. Existing uncommitted terminal work is preserved as the baseline until the replacement TUI slice makes it obsolete.

## Phase 1 — Workspace and Foundation Contracts

### Task 1.1: Add grouped workspace packages

- Update `pnpm-workspace.yaml` with `packages/command/*`, `packages/subagent/*`, `packages/skill/*`, and `packages/session/*`.
- Create source-run package scaffolds only; do not add `lib/`, `dist/`, or package-local `node_modules/`.
- Verify workspace resolution with `pnpm install --lockfile-only` and `pnpm typecheck`.

### Task 1.2: Skill contracts and filesystem loader

- RED: add behavior tests for loading a manifest-declared `SKILL.md`, stable SHA-256 hashing, missing-skill failure, and path traversal rejection.
- GREEN: implement `@harness/skill-core` and `@harness/skill-filesystem`.
- REFACTOR: keep filesystem access behind the provider interface.

### Task 1.3: Subagent core

- RED: test manifest validation, mandatory skill injection after persona, unchanged prompt-cache zone 1, typed result propagation, cancellation, and lifecycle/usage hooks.
- GREEN: implement `@harness/subagent-core`.
- REFACTOR: separate manifest resolution from invocation.

### Task 1.4: Command core

- RED: test dependency ordering, independent-node concurrency, required failure, optional enrichment failure, skipped profile nodes, cancellation, event order, and usage aggregation.
- GREEN: implement `@harness/command-core`.
- REFACTOR: keep the runner financial-domain agnostic.

### Task 1.5: Session contracts

- RED: test valid session/turn/step/model-call state transitions and null usage semantics.
- GREEN: implement `@harness/session-core`.

## Phase 2 — Usage-Aware LLM Contract

### Task 2.1: Result and usage types

- RED: update LLM tests to require generated value plus provider/model/usage/finish metadata for object, text, and stream completion.
- GREEN: extend `packages/llm/src/types.ts`, `client.ts`, and `mock.ts` using AI SDK response metadata.
- Preserve simple public helpers only where existing consumers require them; migrate all consumers together.

### Task 2.2: Pricing and aggregation

- RED: test provider-billed cost, registry-calculated cost, cached-token treatment, unknown model, and missing usage.
- GREEN: add an explicit dated pricing registry and pure cost calculator.
- Null means unavailable; zero means a reported zero.

## Phase 3 — Durable Sessions and Trace

### Task 3.1: Database schema and migration

- RED: add database tests for `research_sessions`, `research_turns`, `workflow_steps`, and `model_calls`, including foreign keys, ordering, and stopped reconciliation.
- GREEN: add schema mappings, migration, and concrete stores only in `packages/database`.

### Task 3.2: Session archive projection

- RED: test the exact session directory projection, timestamped turn folders, evidence/discussion/trace/usage/result content, atomic replacement, and rebuild from SQLite.
- GREEN: implement the projector in the CLI application layer.
- Projection failure must not corrupt or downgrade canonical database state.

### Task 3.3: Background RunManager

- RED: test switching sessions without cancellation, one active turn per session, completion routed to a hidden session, explicit cancellation, orderly shutdown, and orphan reconciliation.
- GREEN: implement the process-level manager in `apps/cli`.

## Phase 4 — Package-per-Specialist Subagents

For each specialist below, start with a failing contract test, add its manifest/prompt/schema/skills, migrate or implement the pure agent, then run its focused tests.

1. `researcher`: source research and source-quality skills.
2. `fundamentals`: financial-statement-analysis skill.
3. `market`: market-context and momentum-analysis skills.
4. `valuation`: relative-valuation and margin-of-safety skills.
5. `risk`: downside-scenario and failure-condition skills.
6. `bull`: evidence-backed-thesis skill; migrate existing Bull behavior.
7. `bear`: adversarial-challenge skill; migrate existing Bear behavior.
8. `comparator`: period-normalization and comparable-analysis skills.
9. `investigator`: event-timeline and material-impact skills.
10. `screener`: criteria-normalization skill; deterministic ranking stays outside the LLM.
11. `source-verifier`: provenance and source-reliability skills.
12. `judge`: evidence-weighing skill; migrate existing Judge while retaining deterministic scoring.

After all consumers move, remove the superseded `@harness/agent` package and update documentation.

## Phase 5 — Command Packages

Each command is delivered as a complete tested slice: definition, orchestration, result type, mock fixtures, persistence, and event trace.

### Task 5.1: `/judge`

- RED: verify all 20 stable nodes, exact dependencies, subagent subset, Usual skipped nodes, Reasoning two-round debate, evidence gate, deterministic score, usage, cancellation, and failure.
- GREEN: implement `@harness/command-judge` and migrate the existing judge workflow.

### Task 5.2: `/screen`

- RED: verify the six visible nodes, locked profitable/growing rules, shortlist verification, and no unrelated subagents.
- GREEN: implement `@harness/command-screen` and migrate the existing screen workflow.

### Task 5.3: `/search`

- RED: verify keyword/vector retrieval, deduplication, source scoring, ranking, run filter, limit, and source inspection data.
- GREEN: implement `@harness/command-search` and migrate existing search behavior.

### Task 5.4: `/challenge`

- RED: verify thesis parsing, supporting evidence, strongest case, contradictions, failure conditions, verdict, and evidence membership.
- GREEN: implement `@harness/command-challenge`.

### Task 5.5: `/compare`

- RED: verify multiple targets, per-target parallel research, period normalization, quality/growth/valuation/risk comparison, trade-off synthesis, and unsupported target errors.
- GREEN: implement `@harness/command-compare`.

### Task 5.6: `/investigate`

- RED: verify scope, primary sources, ordered timeline, contradiction handling, material impact, and final findings.
- GREEN: implement `@harness/command-investigate`.

### Task 5.7: `/research`

- RED: verify profile, market, historical financials, fundamentals, valuation, peers, recent developments, and research summary.
- GREEN: implement `@harness/command-research`.

### Task 5.8: Natural-language routing

- RED: verify natural language routes into all seven real command packages and clarification remains non-destructive.
- GREEN: extend intent schemas/router and command registry.

## Phase 6 — Full Mockup TUI Port

### Task 6.1: Rendering foundation

- RED: port snapshot/property expectations for exact width/height, true-color cells, Unicode width, differential rendering, alternate-buffer cleanup, resize, mouse packet rejection, and bracketed paste.
- GREEN: port the mockup Canvas, input decoder, palette, wordmark, and renderer into `apps/cli/src/terminal`.

### Task 6.2: Onboarding and provider flow

- RED: cover intro, welcome, how-it-works, official/custom provider, credentials, real connection check, research team, evidence explanation, ready, back/skip/retry, and secret masking.
- GREEN: wire the mockup presentation to current setup services.

### Task 6.3: Home and command palette

- RED: cover home, prompt suggestions, Ctrl+P, slash search, model discovery/selection, mode selection, provider connection, context toggle, status, help, and local session commands.
- GREEN: implement pure rendering and controller actions.

### Task 6.4: Chat sessions and live trace

- RED: cover multi-turn sessions, background indicators, hidden-session updates, command-specific trace trees, streaming public messages, expandable debate, scroll, cancel, stopped/failed states, and pinned input.
- GREEN: connect `WorkspaceController` to `RunManager` events and session stores.

### Task 6.5: Command result views and metrics

- RED: snapshot all seven result layouts using real output fixtures and verify duration/token/evidence/cost null semantics.
- GREEN: replace every mockup sample result and metric with projections of committed command results/model calls.

### Task 6.6: Non-TTY behavior

- RED: verify all commands remain usable without ANSI or a TTY.
- GREEN: retain a plain renderer backed by the same command results.

## Phase 7 — Integration, Cleanup, and Documentation

### Task 7.1: Offline E2E matrix

- Run onboarding and all seven commands through the real CLI with mock Sectors and mock LLM providers.
- Assert database sessions/turns/steps/model calls and human-readable session archives.
- Assert failures, cancellation, restart reconciliation, and compact terminal output.

### Task 7.2: Remove superseded UI and stubs

- Remove old terminal presentation paths only after the full mockup TUI tests pass.
- Remove stub command handlers and duplicate workflow lists.
- Preserve unrelated user changes.

### Task 7.3: Documentation ledger

- Add `docs/engine-expansion.md`.
- Update root README, CLI README, all new package READMEs/JSDoc, `ARCHITECTURE.md`, and progress documentation.
- Record every core addition and deviation described by the design.

### Task 7.4: Final verification

- Run focused tests after every slice.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm check` at the final gate.
- Inspect `git diff --check` and ensure no mockup simulation or fabricated output entered production.
