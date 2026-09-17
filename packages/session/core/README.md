# @harness/session-core

Pure contracts for the canonical durable `Session -> Turn -> Execution`
lifecycle, workflow traces, and model usage. Every accepted request is a Turn; a
Turn can have zero or multiple Execution attempts. A Turn and an Execution each
settle exactly once. Attempts are ordered per Turn, cannot overlap, and must be
terminal before their parent Turn settles.

The session store is a persistence boundary, not a runtime coordinator. It does
not execute workflows, assemble model context, project the conversation journal,
or own artifacts, cache, or memory.

The live CLI adopts this lifecycle at its request composition boundary. Journal
payloads may carry versioned Turn/Execution correlation, but replay remains a
projection of canonical lifecycle state rather than its owner. Legacy journal
payloads without correlation metadata remain readable. Restart reconciliation
projects an existing canonical terminal state and terminalizes only genuinely
interrupted running Execution/Turn rows.

## SessionWorkingContext (PR D)

`workingContext.ts` defines the versioned materialized view of *what remains
relevant in one session* — structured reference state, never history. The
ConversationJournal owns what happened; this contract owns only what is still
relevant.

- Monotonic per-session `version`, plus `sourceSequence` (the canonical
  `turn.started` sequence for the accepted Turn) and `updatedByTurnId` for
  audit. It is an acceptance-order watermark, never the journal tail observed
  when settlement happens.
- `applyWorkingContextPatch` is pure: it bumps the version and replaces only the
  fields a settled Turn publishes; omitted fields keep their committed value.
- `assertWorkingContextCommit` is the compare-and-set guard. Two independent
  rejections keep stale writers out: an older `expectedVersion`
  (`STALE_CONTEXT_VERSION`) and an older journal prefix
  (`STALE_SOURCE_SEQUENCE`). Last-write-wins is never allowed.
- `deriveWorkingContextPatch` publishes only what durable rows support:
  `activeSubjects` and `currentIntent` for any settled Turn, plus
  `activeVerdictRef` when a judgment actually resolves through
  `JudgmentStore.getByRun`. Thesis/Bull/Bear/Risk references stay unset until PR F
  defines resolvable artifacts — no reference is invented.
- User-state items (`USER_ASSERTION`, `ASSUMPTION`, `OPEN_QUESTION`) keep explicit
  provenance so user claims can never stand in for verified evidence.

Responsibility boundaries this contract deliberately does not cross: provider
freshness/cache decisions belong to PR E, and packet assembly/prompt rendering
belong to the later Context Engine. A working context may reference something; it
never authorizes reusing external data.

`WorkingContextStore` is the persistence boundary (`current`, `at`, `history`,
`commit`); the SQLite implementation lives in `@harness/database`.
