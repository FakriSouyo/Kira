# Kira CLI host

This workspace package is still named @harness/cli internally; that package
namespace is scheduled for KB. Kira's canonical CLI command is pnpm kira.
pnpm finharness remains as a compatibility script alias.

## Current responsibility

The CLI is Kira's first host. Today apps/cli owns substantially more than
terminal presentation: it composes configuration, database stores, model and
financial providers, capabilities, command workflows, Session lifecycle,
conversation context, and the REPL. UA Kira Engine Extraction is the next
architecture slice after KA.

Do not add new reusable application/core behavior to this host when a
host-neutral boundary is clearly required. UA design remains source-audited
slice by slice; no engine package or API exists yet.

## Source map

| Area | Current responsibility |
|---|---|
| src/index.ts | CLI arguments, setup decision, initial database/context/session startup |
| src/context.ts | Application composition for database, providers, tools, capabilities, commands, and conversational agent |
| src/repl/ | Command parsing, Session lifecycle orchestration, conversation handling, terminal rendering, and local web preview |
| src/commands/ | Explicit product commands, including Judge, Screen, Search, attachment/document, and session controls |
| src/workflows/ | Current command workflow definitions and Judge checkpoint/resume coordination |
| src/runtime/ and src/ui/ | Conversation context preparation and interactive application state |
| src/setup/ | Provider setup and terminal setup flow |

For the full current architecture and target host boundary, see
[ARCHITECTURE.md](../../ARCHITECTURE.md). The current dependency sequence is in
[docs/ROADMAP.md](../../docs/ROADMAP.md), and mutable slice status is in
[docs/PROGRESS.md](../../docs/PROGRESS.md).

## Current legacy internal identities

The code still exposes the exact internal symbols FinharnessConfig,
FinharnessDatabase, and MainFinHarnessAgent, and imports packages through the
@harness/* namespace. Those source/package identities are deferred to KB.
Storage and configuration still use ~/.finharness, including
~/.finharness/.credentials.json and FINHARNESS_* environment variables. These
are current compatibility paths; Kira does not yet support ~/.kira.

The current behavior and ownership for command workflows, Session → Turn →
Execution, Context, Evidence, capabilities, ToolRuntime, and persistence are
defined by source and summarized in ARCHITECTURE.md.
