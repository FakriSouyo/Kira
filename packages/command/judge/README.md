# @harness/command-judge

The `/judge` workflow **definition** — the executable truth for scheduling.
`WorkflowRunner` (in `@harness/command-core`) runs these 15 nodes in dependency
order; the CLI composition layer (`apps/cli/src/workflows/judgeNodes.ts`) binds
one adapter per node and owns every persistence side effect.

## Graph (reconciled with production behavior, PR C)

| Node | Owner | Depends on | Notes |
|---|---|---|---|
| `identify-company` | researcher | — | Company Report evidence (required) |
| `fetch-financials` | sectors-api | identify-company | Quarterly Financials evidence (required) |
| `fetch-market-data` | sectors-api | fetch-financials | Daily Transaction + Foreign Flow; `required: false`, skipped when the research profile disables market data |
| `fetch-news` | sectors-api | fetch-market-data | News + Filings + Sentiment; `required: false`, profile-gated |
| `collect-sources` | researcher | identify-company, fetch-financials, fetch-market-data, fetch-news | Persists evidence + researcher observation; absent enrichment stays absent (never a silent zero) |
| `select-supporting-evidence` | bull-input | collect-sources | Builds the shared evidence block (prompt-cache zone [1]) |
| `round-1-bull-thesis` | bull | select-supporting-evidence | Validates and persists claims |
| `round-1-bear-challenge` | bear | round-1-bull-thesis, select-supporting-evidence | Validates counterpoints against Bull claim ids |
| `round-2-bull-rebuttal` | bull | round-1-bear-challenge, select-supporting-evidence | Mandatory rebuttal; claims normalized to `rebuttal_N` |
| `evaluate-arguments` | judge | round-1-bull-thesis, round-1-bear-challenge, round-2-bull-rebuttal, select-supporting-evidence | Round-1 verdict; sets `JudgeRoundDecision.extraRound` when neutral |
| `conditional-bear-rechallenge` | bear | evaluate-arguments, round-1-bull-thesis, round-2-bull-rebuttal, select-supporting-evidence | Gated: Reasoning mode, or `--conditional` + neutral verdict |
| `conditional-bull-rebuttal` | bull | conditional-bear-rechallenge, select-supporting-evidence | Gated with the arbitration round |
| `resolve-conflicts` | judge | round-1-bull-thesis, round-2-bull-rebuttal, conditional-bull-rebuttal, select-supporting-evidence | Conditional verdict; overwrites the round-1 judgment |
| `check-evidence` | claim-validator | select-supporting-evidence + all debate nodes | Release gate: re-derives the scope rule from the claims the run persisted |
| `synthesize-verdict` | deterministic-rubric | evaluate-arguments, resolve-conflicts, check-evidence | Release gate: fails closed when the reported score/stance contradicts the rubric re-derivation |

## Contracts

- `JudgeNodeExecutors` requires an adapter for **every** declared node id, so an
  unbound node cannot silently become metadata.
- `createJudgeCommandContext` is the only channel through which nodes receive
  dependency outputs and expose the arbitration decision; the adapter factory in
  the CLI is exhaustive by type, and `apps/cli/test/judge-workflow-parity.test.ts`
  asserts that adapters read only declared inputs.
- `researcher`-owned nodes are executed by the CLI evidence collector (Sectors API
  + evidence store) — they never invoke an LLM. Only `bull`, `bear`, and `judge`
  call a model.

