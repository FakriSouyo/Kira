# Full TUI and Agent Engine Design

Historical design artifact from the FinHarness era. The current project is
Kira; this is not the current architecture authority.

**Status:** Approved in conversation on 2026-09-08

**Scope:** Replace the current CLI presentation with the `finharness-mockup-ui` experience and extend the engine so every visible research capability is real.
**Visual source:** `C:\code\finharness-mockup-ui`

## 1. Objective

FinHarness will provide the complete mockup experience from onboarding through the home screen, interactive chat sessions, command palette, background research, live workflow trace, result inspection, and session history. The mockup's simulated state and hard-coded financial output will not enter the product. Every visible workflow step, agent message, evidence count, duration, token count, and result must come from a real engine event or be explicitly shown as unavailable.

This change also turns the current collection of Bull, Bear, Judge, and researcher functions into a package-per-specialist subagent system. Each research command becomes a separate orchestration package that imports only the subagents it uses.

## 2. Constraints Preserved

- Evidence remains the ground-truth layer. A claim can reference only evidence admitted to its run.
- Zod remains the source of structured model-output contracts.
- Subagents remain pure. They receive typed input and return typed output; they never write the database or terminal.
- The orchestration layer owns persistence and event publication.
- `packages/database` remains the only package that imports Drizzle.
- Prompt cache zone 1 remains byte-identical within a run. Agent persona and loaded skills belong to zone 2.
- Score calculation remains deterministic in `@harness/shared`; the Judge cannot invent or override the computed score.
- The locked `/screen` scoring rules remain unchanged.
- The repository remains ESM-only and runs from `src/*.ts`. No `lib/` or `dist/` package output is introduced.
- Every workspace package declares every imported dependency explicitly.
- Public reasoning summaries may be displayed and stored. Private model chain-of-thought is never requested, exposed, or persisted.

## 3. Package Topology

The workspace patterns will include `packages/command/*`, `packages/subagent/*`, `packages/skill/*`, and `packages/session/*` in addition to the existing one-level packages.

### 3.1 Command packages

Each research command is an independently testable orchestrator:

```text
packages/command/
  core/
  judge/
  compare/
  challenge/
  investigate/
  research/
  screen/
  search/
```

Package names use `@harness/command-core`, `@harness/command-judge`, and the corresponding suffixes. Each command package contains:

```text
package.json
README.md
tsconfig.json
src/
  index.ts       public API
  definition.ts  workflow nodes and dependencies
  run.ts         orchestration
  output.ts      command result contract
test/
  <command>.test.ts
```

`@harness/command-core` owns the shared workflow-node vocabulary, dependency-aware runner, cancellation propagation, event types, and usage aggregation. It contains no financial command definitions.

### 3.2 Subagent packages

Each specialist is a separate package:

```text
packages/subagent/
  core/
  researcher/
  fundamentals/
  market/
  valuation/
  risk/
  bull/
  bear/
  comparator/
  investigator/
  screener/
  source-verifier/
  judge/
```

Package names use `@harness/subagent-core`, `@harness/subagent-researcher`, and corresponding suffixes. Each specialist package contains:

```text
package.json
README.md
tsconfig.json
src/
  index.ts       public exports
  agent.ts       pure specialist execution
  manifest.ts    identity, required skills, allowed tools, default tier
  prompt.ts      stable specialist persona
  schemas.ts     typed input and output
skills/
  <skill-name>/SKILL.md
test/
  <specialist>.test.ts
```

`node_modules/` is created by pnpm and is not committed. `lib/` is not created because FinHarness has no package build step.

`@harness/subagent-core` owns the subagent registry, manifest types, typed invocation, lifecycle hooks, mandatory skill resolution, and model-call reporting. It does not contain a research persona or command routing.

### 3.3 Skill packages

```text
packages/skill/
  core/
  filesystem/
```

`@harness/skill-core` defines skill metadata, loaded content, content hash, and catalog/lookup interfaces. `@harness/skill-filesystem` discovers the `skills/*/SKILL.md` files declared by a subagent manifest and loads them from the package source tree.

A skill is executable instruction context, not a UI label. Before invoking a subagent, the runtime:

1. resolves every skill named by the manifest;
2. validates its metadata and readable content;
3. calculates a canonical SHA-256 content hash;
4. injects the content into prompt cache zone 2 after the persona;
5. emits the skill names and hashes in the subagent-start event; and
6. persists those names and hashes on the workflow step.

Missing or invalid mandatory skills fail the subagent before an LLM request is made. The first implementation uses deterministic manifest-declared skills; the model does not dynamically select arbitrary skills.

### 3.4 Session package

`@harness/session-core` defines research session, turn, workflow-step, model-call, and filesystem-projection interfaces. Concrete SQLite stores live in `packages/database`. Filesystem projection is owned by the CLI application because it owns `homeDir` and process shutdown.

## 4. Command-to-Subagent Composition

Commands and subagents are separate concepts. The CLI parses a command and calls its command package. The command package invokes only the required subagents.

| Command | Subagents | Deterministic services |
|---|---|---|
| `/judge` | researcher, fundamentals, market, valuation, bull, bear, risk, judge | evidence validation, rubric scoring |
| `/compare` | researcher per ticker, fundamentals per ticker, market per ticker, valuation per ticker, risk per ticker, comparator, judge | period normalization checks |
| `/challenge` | source-verifier, bull, bear, risk, judge | claim/evidence membership |
| `/investigate` | researcher, investigator, source-verifier, risk, judge | event ordering and deduplication |
| `/research` | researcher, fundamentals, market, valuation, risk, source-verifier, judge | evidence validation |
| `/screen` | screener, researcher for shortlist verification | universe loading, exact filters, ranking |
| `/search` | source-verifier | keyword/vector retrieval, deduplication, ranking |

Local UI commands such as `/new`, `/sessions`, `/home`, `/models`, `/reasoning`, `/connect`, `/context`, `/status`, and `/help` remain CLI actions and do not invoke research subagents.

### 4.1 `/judge` workflow

The trace retains the mockup's 20 visible steps, backed by real operations:

1. Identify company — researcher.
2. Fetch market data — Sectors API adapter.
3. Fetch financials — Sectors API adapter.
4. Fetch valuation — Sectors API adapter.
5. Collect sources — researcher.
6. Evaluate profitability — fundamentals.
7. Evaluate growth — fundamentals.
8. Evaluate valuation — valuation.
9. Select supporting evidence — Bull input assembly.
10. Evaluate downside valuation — risk.
11. Test downside assumptions — risk.
12. Select opposing evidence — Bear input assembly.
13. Round 1 Bull thesis — bull.
14. Round 1 Bear challenge — bear.
15. Round 2 Bull rebuttal — bull in Reasoning mode; skipped with an explicit profile-skipped state in Usual mode.
16. Round 2 Bear rebuttal — bear in Reasoning mode; skipped with an explicit profile-skipped state in Usual mode.
17. Evaluate arguments — judge.
18. Check evidence — deterministic ClaimValidator.
19. Resolve conflicts — judge.
20. Synthesize verdict — deterministic score plus judge summary.

Skipped profile-specific nodes remain visible with a `skipped` status and reason. The UI never reports them as completed work.

### 4.2 Other command workflows

- `/challenge`: parse thesis, collect supporting evidence, build strongest case, find contradictions, define failure conditions, deliver challenge verdict.
- `/compare`: resolve targets, fetch comparable metrics, normalize reporting periods, compare quality/growth, compare valuation/risk, synthesize trade-off.
- `/investigate`: scope investigation, trace primary sources, build event timeline, check contradictions, assess material impact, assemble findings.
- `/research`: resolve company, load market data, fetch historical financials, calculate fundamentals, assess valuation, compare peers, review recent developments, build summary.
- `/screen`: parse criteria, load universe, fetch required metrics, apply locked hard filters, rank matches, verify shortlist.
- `/search`: parse query, run keyword retrieval, run vector retrieval, deduplicate evidence, score source quality, rank results.

Each `definition.ts` declares stable node IDs, labels, dependencies, assigned subagent or deterministic service, and whether the node is required or enrichment-only. The UI derives its trace from this definition and emitted state rather than maintaining a duplicate list.

## 5. Analysis Modes

The selected mode is snapshotted onto each turn so a later UI change cannot alter a running or completed turn.

### Usual

- Uses the full set of required evidence and specialist checks.
- Uses the standard evidence window and configured normal output budgets.
- Runs one Bull-to-Bear challenge pass.
- Emits a concise public response while retaining the complete inspectable trace.
- Marks the second rebuttal nodes as skipped by the Usual profile.

### Reasoning

- Uses a wider evidence window when the source adapter offers more data.
- Runs independent specialist nodes concurrently after their evidence dependencies settle.
- Runs two explicit Bull/Bear debate rounds.
- Performs an explicit conflict-resolution step before synthesis.
- Uses the configured reasoning output budget and produces a more detailed public report.

Both modes use the same evidence membership validation, deterministic scoring, error mapping, and audit requirements. Reasoning mode changes research depth and public output detail; it does not expose hidden chain-of-thought.

## 6. Model Selection and Provider Connection

The onboarding and `/connect` screens use the existing real provider connection checks. Official and custom provider flows store credentials through the existing credential writer and store non-secret configuration separately.

The model menu is populated from provider model discovery rather than a hard-coded mockup array. Selecting a model updates the active session setting and affects only future turns. The router model remains independently configured. Each turn records the actual provider, model, API protocol, and mode used by each model call.

## 7. Runtime and Event Flow

One typed event stream drives the terminal projection, database trace, and session archive:

```text
turn.started
workflow.planned
workflow.step.started
subagent.started
tool.started
tool.completed
evidence.found
subagent.message.delta
subagent.message.completed
model.usage
workflow.step.completed | workflow.step.skipped | workflow.step.failed
turn.completed | turn.failed | turn.stopped
```

Events include stable session, turn, run, step, and subagent identifiers as applicable. Timestamps are produced by the runtime clock, not by renderers. Public streaming text is stored only after its owning message commits; partial deltas are transient presentation events.

The workflow runner publishes a step as completed only after its typed result and related persistence succeed. A dependent node cannot start until all required parent nodes complete. Independent nodes may run concurrently. Abort propagates top-down through the command runner, subagents, tools, and LLM calls.

## 8. Sessions and Background Runs

The CLI owns a process-level `RunManager` keyed by run ID. Navigating to another session does not cancel an active run. Multiple sessions may have active runs, but a single session accepts only one active research turn at a time. Event updates are routed to the correct session whether or not it is visible.

On normal CLI exit, the manager aborts active runs, waits for settlement, records affected turns as stopped, flushes filesystem projections, and restores the terminal. On startup, any `running` turn without a live process owner is reconciled to `stopped` before the workspace is shown.

Background execution does not survive process exit. A daemon is outside this scope.

## 9. Durable Data Model

The execution status union becomes `running | completed | failed | stopped`.

New relational records are added through `packages/database`:

- `research_sessions`: ID, title, provider selection, agent model, reasoning mode, timestamps.
- `research_turns`: ID, session ID, execution ID, user input, command, status, timestamps.
- `workflow_steps`: ID, run ID, node ID, parent node IDs, subagent, skill names/hashes, status, duration, safe summary, error.
- `model_calls`: ID, run/step/subagent IDs, provider/model, attempt, input/output/cached/total tokens, latency, finish reason, optional cost and currency, timestamp.

Existing executions, evidence, messages, claims, and judgments remain the canonical research artifacts and gain the relations needed to traverse from session to turn to run.

Model-visible inputs and public outputs must be reconstructable from the stored run. Secrets, raw authorization headers, and private provider response bodies are never stored.

## 10. Human-Readable Session Archive

SQLite is canonical. After a database commit, the CLI atomically rebuilds the affected session projection under:

```text
~/.finharness/sessions/<session-id>/
  session.json
  timeline.jsonl
  turns/<timestamp>-<turn-id>/
    request.md
    discussion.md
    evidence.json
    trace.json
    usage.json
    result.md
```

- `session.json` contains non-secret session settings and timestamps.
- `timeline.jsonl` is an ordered projection of durable lifecycle events.
- `request.md` contains the user input and parsed command.
- `discussion.md` contains public subagent messages in sequence order.
- `evidence.json` contains evidence IDs, sources, hashes, retrieval/valid timestamps, and provenance.
- `trace.json` contains node state, assigned subagent, skill hashes, duration, and public summaries.
- `usage.json` contains provider-reported token usage and cost when known.
- `result.md` contains the final command output.

Projection writes use a temporary sibling followed by rename. The archive can be rebuilt from SQLite, so a failed projection does not mutate canonical research data. Projection failure is surfaced as a recoverable session-archive warning rather than changing a completed analysis to failed.

## 11. Usage, Duration, and Cost

The current LLM interface returns only generated content, so it must be extended to return content plus call metadata for object, text, and streaming operations. Mock clients return deterministic usage fixtures.

Each model call records:

- provider and actual model;
- call attempt and fallback position;
- input, output, cached-input, and total tokens when supplied;
- call latency and finish reason;
- cost and currency when calculable; and
- unavailable fields as `null`, never zero.

The TUI aggregates session and turn totals from committed `model_calls`. Duration uses monotonic runtime measurement for live display and persisted elapsed milliseconds for completed work.

Cost is taken from provider-returned billing metadata when available. Otherwise a dated, explicit model-pricing registry may calculate cost. An unknown model or missing usage displays `unavailable`; FinHarness does not invent an estimate.

## 12. TUI Integration

The native CLI implementation in `C:\code\finharness-mockup-ui\src\cli` is the visual reference. The port includes:

- orange true-color theme and shared wordmark;
- alternate-screen differential rendering;
- complete onboarding and provider setup;
- returning-user home screen;
- prompt suggestions;
- new session and session history navigation;
- chat-style multi-turn transcript;
- slash and Ctrl+P command palette;
- real model, mode, provider, context, status, and help menus;
- pinned input and terminal-size fallbacks;
- live command-specific workflow trace;
- expandable subagent/debate inspection;
- command-specific result layouts;
- background-run indicators; and
- live duration, token, evidence, and cost indicators.

The mockup `Workspace.simulate()`, `judgeStreamOutputs`, fixed metrics, fixed results, demo provider labels, and hard-coded model choices are not ported. A `WorkspaceController` translates real application events into immutable UI state. Renderers are pure projections of that state.

Non-TTY operation continues to produce plain, non-ANSI output and remains suitable for E2E tests and piping.

## 13. Errors and Recovery

- All failures are mapped to `UserFriendlyError` before reaching the terminal.
- Provider response bodies and credentials do not enter user-facing errors or archives.
- Required-step failure fails the turn and records the execution as failed.
- An enrichment-only step may become unavailable only when its command definition explicitly permits it; the final result must disclose the missing dimension.
- Evidence membership failure rejects the affected claim before synthesis.
- Retry and provider fallback attempts each create a model-call record.
- Cancellation creates stopped states rather than failed states.
- Database commit failure prevents a completion event.
- Archive projection failure preserves the completed canonical result and produces a visible warning with a rebuild action.

## 14. Testing Strategy

Implementation follows test-driven development.

- Unit tests cover each subagent, skill loader, manifest validation, command definition, workflow dependency ordering, usage aggregation, pricing math, projection, and UI reducer.
- Contract tests cover structured outputs, evidence membership, prompt-cache zone stability, event ordering, cancellation, and null usage semantics.
- Integration tests run every command package with real in-process subagents and mock external providers through the stores.
- CLI E2E tests run all seven research commands offline using mock Sectors and mock LLM clients, then verify database artifacts and session files.
- Snapshot tests cover onboarding, home, chat sessions, command palette, menus, running/completed/failed/stopped traces, results, and compact terminals.
- Property tests preserve Unicode input, cursor correctness, terminal bounds, reducer determinism, and non-TTY ANSI safety.
- `pnpm check` is the completion gate.

## 15. Documentation and Change Ledger

The implementation updates affected package READMEs, JSDoc, root README, CLI README, and `ARCHITECTURE.md`. A dedicated core-expansion ledger records:

- every new package and its responsibility;
- every schema/migration change;
- every new subagent and skill;
- command-to-subagent composition;
- changes to the LLM result contract;
- the Usual and Reasoning profiles;
- session archive behavior;
- remaining source-data limitations; and
- deliberate deviations from the earlier addendum.

The ledger will live at `docs/engine-expansion.md`. `ARCHITECTURE.md` remains the authoritative table of architectural deviations.

## 16. Delivery Order

The change is implemented in vertical slices so the repository stays verifiable:

1. Foundation contracts: skill, subagent core, command core, session core, events, and usage.
2. Database migrations and stores for sessions, turns, workflow steps, and model calls.
3. Package-per-specialist extraction of existing agents, followed by new specialists and skills.
4. `/judge` command package with both analysis modes and the full trace.
5. Remaining command packages, one tested vertical slice at a time.
6. Session archive and background `RunManager`.
7. Full mockup TUI port wired to real events.
8. E2E hardening, documentation, removal of superseded CLI UI code, and final `pnpm check`.

## 17. Non-Goals

- Runs continuing after the CLI process exits.
- A web UI or web-hosted session service.
- Dynamic arbitrary model-selected skill installation.
- Display or persistence of private chain-of-thought.
- Fabricated usage, cost, evidence, or financial values.
- Compatibility shims for the superseded terminal UI; all internal references will be updated together.
