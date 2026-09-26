# Kira

[![version](https://img.shields.io/badge/version-0.3.1-blue)](./package.json)
[![CI](https://github.com/FakriSouyo/Kira/actions/workflows/ci.yml/badge.svg)](https://github.com/FakriSouyo/Kira/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22-green)

**An evidence-backed financial research engine.**

> LLMs propose. Data proves. Code verifies. Context persists. Kira decides.

Kira combines explicit financial workflows, durable Session state, structured
context, typed research artifacts, deterministic validation, and provider-backed
market data. Its current research focus is IDX-listed companies, using a
provider-neutral financial-data boundary and Sectors as the current provider.

## Product boundary

Kira is a reusable financial research engine. The CLI is its first host adapter,
not the engine boundary. `@harness/engine` already owns substantial
host-neutral application orchestration, including the current Judge release
core, completed-release reconciliation, and historical artifact reconstruction
through supplied stores. UA extraction is still incomplete, and the CLI retains
important host/runtime composition, Execution lifecycle, startup invocation
timing, and the concrete database-to-store adapter. Future Desktop and Web
hosts are intended to consume the same engine rather than reimplement Judge, Session, Context,
Evidence, capability, or lifecycle behavior. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the clearly labelled current facts and
target direction.

Natural-language conversation, explicit commands, and future research products
are distinct surfaces. Conversation does not silently start /judge, /screen,
/search, or a future workflow. Fresh research remains behind an explicit
command.

## Current product surface

| Surface | Current behavior |
|---|---|
| Natural-language conversation | Bounded financial discussion and same-Session prior research context. It does not silently run a fresh research workflow. |
| /judge TICKER | Mature evidence-backed workflow with deterministic claim and counterpoint checks, a 15-node graph, workflow version 2, and T5 release integrity complete on master. |
| /screen CRITERIA | Implemented financial screening workflow using supported criteria. Future maturation is tracked separately. |
| /search QUERY | Searches persisted Evidence. Ranking uses keyword overlap with a small mock-embedding tie-break; this remains a prototype, not production vector search. |
| /attach PATH and /files | Explicitly imports a user-selected file and lists raw Attachment metadata for the current Session. Attachment bytes do not become Evidence or model context. |
| /doc-index ID and /doc-search QUERY | Extracts supported local documents and searches deterministic chunks with citations. Supported inputs include PDF, UTF-8 text, Markdown, JSON, CSV, and TSV. |

The broader CLI also includes setup, provider selection, status, version,
history, session inspection, export, resume, and a local web preview.

These command names are future stubs and are not implemented research products:

- /research
- /compare
- /challenge
- /investigate

They remain separate from /judge. Do not infer their implementation from
natural-language conversation or this roadmap.

## Authority boundaries

Kira keeps these responsibilities distinct:

- Providers return data; code verifies and records accepted financial
  observations and their provenance.
- Evidence, Claims, Counterpoints, Artifacts, and Context have separate
  contracts and ownership.
- Capabilities describe and authorize access; ToolRuntime remains the tool
  execution authority.
- Domain packages own their truth; SQLite persists it.
- Session → Turn → Execution is the current lifecycle. Conversation context is
  not Evidence, and prior research context is not freshly retrieved data.

LLMs propose structured reasoning. Code owns evidence acceptance, claim policy,
authorization, lifecycle integrity, durable state, and deterministic verdict
checks.

## Quickstart

Requirements: Node.js 22 or later and pnpm 11.7.0.

Run offline with deterministic mocks:

```sh
pnpm install --frozen-lockfile
pnpm kira --mock-sectors --mock-llm
```

Try:

```text
/judge BBCA
/screen profitable growing
/search ROE
/attach <path>
/files
/doc-index <attachmentId>
/doc-search revenue
/help
```

For real providers, configure credentials and start Kira:

```sh
pnpm kira
```

The old pnpm finharness script remains as a compatibility alias. The canonical
invocation is pnpm kira.

## Configuration and legacy paths

The current implementation loads configuration in this order:

1. Environment variables
2. ~/.finharness/.credentials.json
3. config.json as a legacy fallback
4. Defaults

The current storage and credential directory remains ~/.finharness, and
environment variables retain their FINHARNESS_* names. These identities are
scheduled for KB Internal Kira Identity Migration. Kira does not currently
support ~/.kira.

The CLI supports separate agent and router model tiers, OpenAI-compatible
providers, and the current Sectors financial-data provider. Use /setup,
/providers, /status, or /auth-set from the CLI to inspect or configure them.

## Current documentation

| Role | Canonical document |
|---|---|
| Product entry point | README.md |
| Contributor and agent constitution | AGENTS.md |
| Current architecture and target direction | ARCHITECTURE.md |
| Canonical future dependency sequence | docs/ROADMAP.md |
| Mutable current status | docs/PROGRESS.md |
| Historical release record | CHANGELOG.md |
| Historical, non-authoritative material | docs/archive/ |

Current internal source identifiers such as MainFinHarnessAgent,
FinharnessConfig, HarnessContext, the @harness/* package namespace, and
FINHARNESS_* settings remain unchanged in KA and are scheduled for KB. Exact
source symbols remain written as implemented until code changes them.

## Scope

Kira is a research and engineering tool. Its outputs are designed to make
evidence, assumptions, provenance, and uncertainty inspectable rather than hide
them behind a single model response.
