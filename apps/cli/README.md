# Kira CLI host

This workspace package is still named @harness/cli internally. KB1 and KB2 do
not rename package namespaces; any later identity change requires separate
source review and selection. Kira's canonical CLI command is pnpm kira.
pnpm finharness remains as a compatibility script alias.

## Current responsibility

The CLI is Kira's first host. Today apps/cli owns substantially more than
terminal presentation: it composes configuration, database stores, model and
financial providers, capabilities, command workflows, Session lifecycle,
conversation context, and the REPL. The planned UA Kira Engine Extraction
phase is complete. U Research Composition / Product Completion is the active
broad phase; the KB blocking gate is closed and remaining compatibility
identity work is deferred.

Do not add new reusable application/core behavior to this host when a
host-neutral boundary is clearly required. The planned UA extraction is
complete; @harness/engine provides the documented host-neutral responsibilities
while the CLI retains host-specific composition and presentation.

## Source map

| Area | Current responsibility |
|---|---|
| src/index.ts | CLI arguments, setup decision, initial database/context/session startup |
| src/context.ts | Application composition for database, providers, tools, capabilities, commands, and conversational agent |
| src/repl/ | Command parsing, Session lifecycle orchestration, conversation handling, terminal rendering, and local web preview |
| src/commands/ | Explicit product commands, including Judge, Research, Screen, Search, attachment/document, and session controls |
| src/workflows/ | Host adapters for command workflows and Judge checkpoint/resume coordination |
| src/runtime/ and src/ui/ | Conversation context preparation and interactive application state |
| src/setup/ | Provider setup and terminal setup flow |

For the full current architecture and target host boundary, see
[ARCHITECTURE.md](../../ARCHITECTURE.md). The current dependency sequence is in
[docs/ROADMAP.md](../../docs/ROADMAP.md), and mutable slice status is in
[docs/PROGRESS.md](../../docs/PROGRESS.md).

## Current internal identities

The CLI runtime config type is CliConfig. The conversational host and prompt
constant are MainKiraAgent and MAIN_KIRA_PROMPT. KB2 renamed those identifiers
without changing behavior or prompt bytes. FinharnessDatabase and workspace
imports under the @harness/* namespace remain unchanged; KB2 did not alter
persistence or package identity.
Storage and configuration still use ~/.finharness, including
~/.finharness/.credentials.json and FINHARNESS_* environment variables. These
are current compatibility paths; Kira does not yet support ~/.kira.

`/research TICKER <QUESTION>` composes the Engine Research lifecycle and runtime
with CLI-owned stores, event projection, and deterministic terminal rendering.
The command does not run the Bull/Bear/Judge debate.

`/compare` remains a CLI stub. The U3A Engine foundation normalizes only
execution-scoped accepted quarterly growth Evidence; later U3 slices own the
durable report, lifecycle, and command adapter.

`/challenge` also remains a CLI stub. U4A adds its strict report contract,
dedicated analyst subagent, and Engine grounding over Execution-scoped
accepted financial Evidence; publication and CLI integration remain planned.

The current behavior and ownership for command workflows, Session → Turn →
Execution, Context, Evidence, capabilities, ToolRuntime, and persistence are
defined by source and summarized in ARCHITECTURE.md.
