# FinHarness

[![version](https://img.shields.io/badge/version-0.3.1-blue)](./package.json)
[![CI](https://github.com/FakriSouyo/finharness-sector.app/actions/workflows/ci.yml/badge.svg)](https://github.com/FakriSouyo/finharness-sector.app/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22-green)

**A stateful financial research agent harness for evidence-grounded stock analysis.**

> LLMs propose. Data proves. Code verifies. Context persists. FinHarness decides.

FinHarness combines explicit financial workflows, durable session state, structured context, typed research artifacts, deterministic validation, and provider-backed market data.

The current implementation is focused on IDX-oriented research and uses a provider-neutral financial data seam with Sectors as its current provider.

## Core idea

FinHarness is not one giant agent that runs the same chain for every question.

Different inputs use different paths:

```text
User
│
├─ natural-language conversation
│   └─ MainFinHarnessAgent
│       └─ Context Engine
│
├─ /screen
│   └─ screening workflow
│
├─ /search
│   └─ evidence search
│
└─ /judge
    └─ Research → Verify → Accepted Evidence → Finalize Snapshot → Bull → Bear → Rebuttal → Judge → Verdict
```

The Bull/Bear/Judge debate belongs to `/judge` only.

Normal conversation does **not** silently auto-run `/judge`, `/research`, `/compare`, or `/screen`. Slash commands remain explicit workflow boundaries.

## What is implemented

### Stateful harness runtime

The A-L stateful-context roadmap is complete:

```text
Session
└─ Turn
   ├─ zero or more Executions
   └─ ModelCalls

SessionWorkingContext
        ↓
Reference Resolver
        +
bounded Artifact Retrieval
        ↓
Artifact Validity
        ↓
Context Policy
        ↓
Context Assembler
        ↓
Token Budget + Deterministic Compaction
        ↓
ContextSnapshot
        ↓
ModelCall
```

This gives FinHarness:

- canonical `Session → Turn → Execution` lifecycle
- append-only journal linkage
- durable `SessionWorkingContext`
- typed immutable research artifacts
- same-session artifact retrieval
- deterministic context selection
- token budgeting and compaction
- exact `ContextSnapshot → ModelCall` linkage
- restart-safe conversational follow-up
- execution-scoped specialist context for Bull/Bear/Judge

Artifact reuse means **reuse as prior conversational context**, not workflow memoization. A new `/judge BBRI` still executes a new judge workflow.

### Evidence-grounded `/judge`

```text
/judge BBRI
↓
create Turn + Execution
↓
WorkflowRunner
↓
identify company
↓
selectively fetch required financial data
↓
reuse provider cache when still valid
↓
verify accepted observations
↓
materialize accepted Evidence
↓
persist one execution-scoped financial snapshot manifest
↓
select supporting evidence
↓
Bull thesis
↓
Bear challenge
↓
Bull rebuttal
↓
Judge evaluation
↓
optional extra challenge/rebuttal
↓
deterministic evidence check
↓
deterministic verdict synthesis
↓
persist typed artifacts
↓
publish SessionWorkingContext refs
```

The LLM produces structured reasoning, but important integrity rules remain code-enforced:

- claim evidence IDs must exist
- evidence must belong to the allowed execution set
- Bear challenges must target valid claims
- score and stance normalization are deterministic
- specialist context is scoped to the current `/judge` execution
- historical artifacts are never injected as authoritative evidence for a new judge run

Before reasoning begins, `/judge` records the exact accepted financial state in
an immutable `VerifiedFinancialSnapshot`. Required Company Report and Quarterly
Financials must verify; optional Market/News categories are explicitly marked
`NOT_REQUESTED` or `UNAVAILABLE` when absent. The snapshot is an audit input
record, not a provider cache, artifact, context snapshot, or conversational
memory. Provider cache reuse may occur, but every new Execution gets its own
snapshot.

### Selective financial retrieval

FinHarness avoids fetching every provider endpoint for every request.

Current `/judge` data surface includes:

- Company Report
- Quarterly Financials
- Daily Transaction when required
- Foreign Flow when required
- News when required
- Filings when required
- derived sentiment without a separate sentiment API call

Provider cache freshness and artifact reuse are separate concerns.

```text
provider cache
≠ VerifiedFinancialSnapshot
≠ Evidence
≠ Artifact
≠ Context
≠ Memory
```

## Quickstart

### Requirements

- Node.js >= 22
- pnpm 11.7.0

The repository pins pnpm through:

```json
"packageManager": "pnpm@11.7.0"
```

### Offline development

No API keys are required:

```bash
pnpm install
pnpm finharness --mock-sectors --mock-llm
```

Then try:

```text
/judge BBCA
Apakah BBRI layak dibeli?
/screen profitable growing
/history
/session <runId>
/search ROE
/help
```

Mock mode follows the same main contracts as the real runtime and is used by the offline E2E suite.

### Real APIs

Copy the example environment file and configure your keys:

```bash
cp .env.example .env
pnpm finharness
```

You can also run the interactive setup:

```text
/setup
```

or save credentials directly:

```text
/auth-set SECTORS=... LLM.AGENT=... LLM.ROUTER=...
```

Credentials are stored separately in:

```text
~/.finharness/.credentials.json
```

Configuration priority is:

```text
environment
→ .credentials.json
→ config.json legacy fallback
→ defaults
```

## LLM configuration

FinHarness currently exposes agent and router model tiers.

Example `~/.finharness/config.json`:

```json
{
  "llm": {
    "agent": {
      "provider": "openai",
      "model": "gpt-4o",
      "temperature": 0.2,
      "maxTokens": 2000
    },
    "router": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "temperature": 0,
      "maxTokens": 256
    }
  },
  "sectors_api": {
    "key": "SECTORS_API_KEY",
    "base_url": "https://api.sectors.app/v2",
    "cache_ttl_hours": 24
  }
}
```

OpenAI-compatible endpoints can also be used through `base_url` / `api_key` or environment variables.

Example:

```bash
LLM_PROVIDER=openai \
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY=... \
LLM_MODEL=deepseek-chat \
pnpm finharness
```

Local OpenAI-compatible endpoints such as Ollama or LM Studio can be configured the same way.

## Commands

### Available now

| Command | Purpose |
|---|---|
| `/judge TICKER [--conditional]` | Full evidence-backed debate and deterministic verdict |
| `/screen [CRITERIA]` | Screen stocks using supported criteria |
| `/history [--limit N]` | List recent runs |
| `/session <runId>` | Show persisted run artifacts |
| `/resume <runId>` | Display/resume-compatible session view |
| `/search <query>` | Search persisted evidence using keyword + vector prototype |
| `/export <runId> [--format json\|md\|html]` | Export a run and its audit trail |
| `/web [--port N]` | Start the lightweight local web preview |
| `/setup` | Open the interactive setup wizard |
| `/status` | Show provider/config status with masked credentials |
| `/providers` | List configured AI provider options |
| `/auth-set KEY=VALUE` | Write credentials to `.credentials.json` |
| `/new` | Start a new-session interaction path |
| `/version` | Show the current version |
| `/help` | Show CLI help |
| `/exit` | Exit the harness |

### Roadmap stubs

These command names exist but their full workflows are not implemented yet:

- `/research`
- `/compare`
- `/challenge`
- `/investigate`

They are intentionally separate from `/judge`. Future implementations should use only the capabilities and specialists they actually need.

## Conversation behavior

Natural-language input is handled by `MainFinHarnessAgent`.

Example:

```text
/judge BBRI

jadi menurutmu bagaimana?
downside paling bahaya apa?
balik ke thesis BBRI tadi
```

Follow-up turns can reuse structured same-session context without rerunning `/judge`.

Historical artifacts may be recovered as **prior research context** when they are valid and relevant. They are not presented as newly refreshed financial data.

## Architecture

```text
apps/cli
  ├─ REPL
  ├─ explicit commands
  └─ composition/runtime wiring
        │
        ├───────────────┐
        ▼               ▼
packages/orchestrator   packages/command
MainFinHarnessAgent     WorkflowRunner definitions
        │               │
        ▼               ▼
packages/context        packages/subagent
Context Engine          Bull / Bear / Judge / Researcher
        │               │
        └───────┬───────┘
                ▼
      session / execution / evidence
                │
                ▼
          packages/database

External seams:
  packages/llm
  packages/financial-data  FinancialDataProvider contract
  packages/sectors-api
```

### Main packages

```text
packages/
  command/       command/workflow contracts and /judge definition
  context/       ContextPacket, retrieval, validity, policy, budget, snapshot
  conversation/  durable conversation store contracts
  database/      SQLite stores and migrations
  evidence/      EvidenceStore, hashing, provenance
  execution/     execution and validation contracts
  financial-data provider-neutral financial data contracts
  llm/           LLM runtime contracts, clients, mocks
  orchestrator/  MainFinHarnessAgent conversation orchestration
  routing/       routing primitives
  schemas/       shared domain/Zod schemas
  sectors-api/   Sectors adapter, cache, freshness policy
  session/       Session/Turn/Execution and SessionWorkingContext
  shared/        shared utilities
  skill/         skill contracts/providers
  subagent/      specialist manifests and runtime

apps/
  cli/           REPL, workflow adapters, setup, local UI
```

For the detailed architecture and historical design decisions, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Persistence and auditability

FinHarness uses SQLite for durable runtime state.

Important persisted concepts include:

- Sessions
- Turns
- Executions
- Evidence
- agent messages
- claims
- judgments
- typed artifacts
- SessionWorkingContext versions
- ContextSnapshots
- VerifiedFinancialSnapshots
- ModelCall linkage

The journal is an append-only audit/replay source. It is not the owner of session context.

## Cache and freshness

Consumers use `FinancialDataProvider`; the current Sectors adapter uses file-backed
provider caching with operation-specific freshness behavior.

Key rules:

- fetch only what the current task requires
- reuse provider data while policy says it is still valid
- refresh only stale, missing, incompatible, or explicitly refreshed data
- keep `fetchedAt`, `dataAsOf`, and financial period semantics distinct
- do not treat provider cache entries as durable research artifacts

## Development

Run the full verification path:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
```

Or use the repository check command:

```bash
pnpm check
```

Current CI runs on Node 22 and installs the pnpm version declared by `packageManager`.

## Current baseline

The completed stateful harness roadmap is:

```text
A  Canonical Session → Turn → Execution
B  Production lifecycle + journal linkage
C  /judge through WorkflowRunner
D  SessionWorkingContext
E  Selective provider retrieval + freshness
F  Durable typed artifacts
G  Context Resolver + Policy + Assembler
H  ContextSnapshot + ModelCall linkage
I  Production conversation-context integration
J  Token budgeting + deterministic compaction
K  Specialist context for Bull/Bear/Judge
L  Artifact-aware retrieval + validity + prior-context reuse
 M  Financial Data Provider Seam
 N  Verified Financial Snapshot
```

A-L and PR M are complete and merged into `master`; PR N is complete on this
branch pending review and merge.

PR M adds the Financial Data Provider Seam; PR N adds the verified input boundary:

```text
A-L  Stateful lifecycle/context foundation  COMPLETE
 M   Financial Data Provider Seam           COMPLETE
 N   Verified Financial Snapshot             COMPLETE
```

## Next architecture work

The next planned architecture phase starts from the PR N snapshot boundary
rather than replacing the A-L foundation.

Current direction after PR N:

1. model/runtime generalization
2. Capability Registry + typed capability/tool runtime
3. checkpoint/resume
4. Evidence Policy + Claim Graph
5. reusable research subgraphs
6. Risk Committee
7. Research Graph
8. Decision Journal, outcome tracking, and reflection
9. UI integration and final polish

This order may evolve as implementation constraints become clearer, but the A-L lifecycle/context foundation remains the baseline.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — current architecture plus historical deviations
- [CHANGELOG.md](CHANGELOG.md) — release history
- [planning/addendum_v3.0.md](planning/addendum_v3.0.md) — earlier detailed design specification
- [AGENTS.md](AGENTS.md) — repository contribution/agent conventions

## Scope

FinHarness is a research and engineering tool. Its outputs are designed to make evidence, assumptions, provenance, and uncertainty inspectable rather than hide them behind a single model response.
