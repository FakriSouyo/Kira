# R1 Typed Tool Runtime Design

Status: approved design; implemented on `feat/r1-typed-tool-runtime`

Base: `07581734cf6e4a2a3056743ade2b120bdb734f05` (`origin/master`)

R1 introduces the smallest generic runtime for executing one explicitly supplied
typed tool. It does not introduce discovery, permissions, integrations, model
tool calling, or any durable tool authority. R2 remains responsible for the
Capability Registry, Policy, and Integrations layer above this runtime.

## Runtime boundaries

FinHarness will keep three independent execution concerns:

```text
WorkflowRunner
  schedules dependency-aware Judge nodes

ToolRuntime
  validates and executes one explicitly supplied ToolDefinition

ModelRuntime
  prepares and dispatches one model invocation
```

`WorkflowRunner != ToolRuntime != ModelRuntime`.

`WorkflowNode.executor` remains auditable owner metadata. It does not grant
capabilities and it does not become a tool registry. The older
`apps/cli/src/workflows/workflow.ts` abstraction is out of scope.

## Package and dependency direction

Create the domain-neutral package `@harness/tool-runtime` at
`packages/tool-runtime`.

```text
@harness/tool-runtime
  └── zod

apps/cli
  ├── @harness/tool-runtime
  └── @harness/financial-data
```

The generic package must not depend on CLI, command, database, context,
session, LLM, financial-data, sectors-api, or specialist packages. Financial
tool definitions are composed at the CLI boundary and close over the existing
`FinancialDataProvider`; the provider-neutral financial seam remains the
authority for provider abstraction, cache/freshness, result shape, and errors.

## Core contracts

The public contract is intentionally explicit and registry-free:

```ts
export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
}

export interface ToolDefinition<TId extends string, TInput, TOutput> {
  readonly id: TId;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export function defineTool<const TId extends string, TInput, TOutput>(
  definition: ToolDefinition<TId, TInput, TOutput>,
): ToolDefinition<TId, TInput, TOutput>;

export interface ToolInvocationMetadata {
  readonly toolId: string;
  readonly durationMs: number;
}

export interface ToolInvocationResult<TOutput> {
  readonly value: TOutput;
  readonly metadata: ToolInvocationMetadata;
}
```

`defineTool` preserves a literal, stable ID and keeps the input/output types
inferred from the definition. It does not write global state, generate IDs, or
register the tool anywhere.

`ToolRuntime.invoke(tool, input, options)` receives the definition directly.
There is no `invoke(id)` overload and no lookup map in R1.

## Invocation algorithm

Each `invoke` call has one execution attempt and one handler call at most:

1. Validate the tool definition and parse input with `inputSchema`.
2. Start the lifecycle clock and emit `tool.started` with the canonical ID.
3. If the signal is already aborted, do not call the handler; emit
   `tool.cancelled` and throw `ToolRuntimeError` with code `TOOL_ABORTED`.
4. Call `tool.execute(parsedInput, { signal })` exactly once.
5. If the signal is aborted after the handler resolves, reject publication,
   emit `tool.cancelled`, and throw `TOOL_ABORTED`.
6. Parse the handler value with `outputSchema`.
7. Return the parsed value and `{ toolId, durationMs }`, emitting
   `tool.completed`.

The runtime has no retry, fallback, cache, freshness, workflow scheduling,
permission, model-loop, or provider behavior. `now(): number` is injectable so
duration tests are deterministic; duration is the non-negative difference
between the end and start readings.

Input and output validation errors are runtime-owned. Input validation happens
before handler execution and output validation happens after the one handler
execution. A handler error is rethrown unchanged, including a
`FinancialDataError`, `UserFriendlyError`, or provider error; it is observed as
`tool.failed` but is not replaced by a generic execution error.

## Runtime errors and observation

`ToolRuntimeError` is limited to runtime-owned failures:

- `INVALID_TOOL_DEFINITION`
- `TOOL_INPUT_INVALID`
- `TOOL_OUTPUT_INVALID`
- `TOOL_ABORTED`

Validation details remain available as a non-secret cause/details field for
developers. Raw input, credentials, and stack traces are not projected into
CLI events.

The observer is supplied per invocation or configured on the runtime and is
domain-neutral:

```ts
type ToolRuntimeEvent =
  | { type: 'tool.started'; toolId: string }
  | { type: 'tool.completed'; toolId: string; durationMs: number }
  | { type: 'tool.failed'; toolId: string; durationMs: number; error?: unknown }
  | { type: 'tool.cancelled'; toolId: string; durationMs: number };
```

The observer receives the canonical runtime ID. Event delivery does not become
a second success/failure authority; invocation result/error semantics remain
the authority. Observer failures are not allowed to turn a completed handler
into a second execution attempt.

## Financial tool definitions

Compose the eight known definitions in a CLI-owned module such as
`apps/cli/src/tools/financialTools.ts`. The module depends on
`@harness/tool-runtime` and `@harness/financial-data`, but the generic runtime
does not depend on either.

| Runtime ID | Input | Handler | Output |
| --- | --- | --- | --- |
| `financial.company-report` | `{ ticker: string }` | `provider.getCompanyReport(ticker)` | `FinancialDataResult<CompanyReport>` |
| `financial.quarterly-financials` | `{ ticker: string }` | `provider.getQuarterlyFinancials(ticker)` | `FinancialDataResult<QuarterlyFinancials>` |
| `financial.screen` | `{ criteria: string[] }` | `provider.screen(criteria)` | `ScreenerResult[]` |
| `financial.daily-transaction` | `{ ticker: string }` | `provider.getDailyTransaction(ticker)` | `FinancialDataResult<DailyTransaction>` |
| `financial.foreign-flow` | `{ ticker: string }` | `provider.getForeignFlow(ticker)` | `FinancialDataResult<ForeignFlow>` |
| `financial.news` | `{ ticker: string }` | `provider.getNews(ticker)` | `FinancialDataResult<NewsArticle[]>` |
| `financial.filings` | `{ ticker: string }` | `provider.getFilings(ticker)` | `FinancialDataResult<Filing[]>` |
| `financial.sentiment` | `{ ticker: string }` | `provider.getSentiment(ticker)` | `FinancialDataResult<Sentiment>` |

Ticker and criteria schemas validate structure without moving command-specific
business policy into the generic runtime. Output schemas validate the existing
provider-neutral result shapes; they do not redesign `FinancialDataProvider`.

The definitions are explicit values returned by a composition helper, not a
registry. The mock provider uses the same definitions and the same runtime.
No Sectors client is imported by `@harness/tool-runtime` or by the generic
contracts.

## CLI composition and event projection

`HarnessContext` will own one `ToolRuntime` and the explicit bound financial
tool handles. The runtime is constructed beside the existing
`FinancialDataProvider` in CLI composition:

```text
HarnessContext
  ├── ToolRuntime
  ├── financialTools.companyReport
  ├── financialTools.quarterlyFinancials
  ├── ...
  └── financialData (existing provider seam)
```

Judge and Screen receive the handles explicitly. They do not discover tools by
ID. A small CLI projection helper maps generic lifecycle events to the existing
public event names:

```text
financial.company-report       -> company_report
financial.quarterly-financials -> quarterly_financials
financial.daily-transaction   -> daily_transaction
financial.foreign-flow         -> foreign_flow
financial.news                 -> news
financial.filings              -> filings
financial.sentiment            -> sentiment
```

`tool.started` projects to the existing `tool.start`. `tool.completed` and
`tool.failed` project to the existing `tool.complete` with duration and the
existing safe error text behavior. Cancellation projects compatibly as a
completed tool event carrying the existing abort error representation; no
public `AgentToolName` rename is introduced. The generic package never imports
`AgentEvent` or `AgentToolName`.

The old Judge-local helper is reduced to this projection/invocation composition
boundary. It must not retain separate timing, abort, or execution behavior.

## Workflow integration

`screenWorkflow` invokes `financial.screen` through `ToolRuntime`, then keeps
the existing `matchScore > 0` filter and `MAX_ROWS = 10` projection.

The Judge acquisition adapters invoke the seven ticker tools through the same
explicit handles. Required company report and quarterly financial failures
continue to fail the workflow. Market and news/filings/sentiment failures
continue to degrade the existing categories, preserving the original domain
error code for composition policy. Evidence persistence, observation
materialization, snapshots, and subagent inputs remain in the existing CLI
composition layer.

The Judge definition remains 15 nodes, `JUDGE_WORKFLOW_VERSION` remains 2,
node IDs/dependencies/required flags/executor metadata remain unchanged, and
there is no checkpoint or graph-fingerprint change. A restored node is supplied
to `WorkflowRunner` as a restore seed and therefore does not invoke a fresh
ToolRuntime call.

## Persistence and out-of-scope decisions

R1 adds no migration, `ToolCall` table, durable invocation store, session/turn
fields, capability grants, or new durable authority. Invocation metadata is
in-process only and is composed into existing workflow behavior where needed.

R1 does not add:

- Capability Registry, Tool Registry, or dynamic lookup;
- capability discovery, policy, grants, scopes, or approval gates;
- integrations, plugins, MCP, or external connector registration;
- LLM tool-calling, `tools:`, `toolChoice`, or an autonomous model loop;
- shell, browser, filesystem, files, documents, or arbitrary HTTP tools;
- WorkflowRunner cleanup or a second workflow scheduler.

## TDD and audit plan

Before implementation, tests will be written for:

- valid typed invocation, parsed input/output, metadata, one handler call, and
  deterministic duration;
- invalid input with zero handler calls;
- invalid output with one handler call and no successful result;
- unchanged identity of domain/provider errors;
- pre-abort and post-resolution abort fencing;
- lifecycle ordering for success, failure, and cancellation;
- all eight financial definitions, canonical IDs, delegation, malformed output,
  and unchanged provider errors;
- Judge required/optional parity, existing AgentEvent projection, evidence and
  snapshot parity, and no direct provider call in workflow adapters;
- Screen output parity and `financial.screen` invocation;
- restored Judge nodes performing no fresh tool invocation.

Source audits will confirm:

- no `ctx.financialData.*` calls remain in Judge or Screen workflow paths;
- `@harness/tool-runtime` has no CLI/domain/model/workflow/database dependency;
- no Registry, Policy, MCP, or model-tool-calling implementation was added;
- no database migration or Judge version/graph change exists.

## Approval gate

This artifact is the design proposal only. No R1 production implementation,
canonical roadmap advancement, or push/merge is authorized until the proposed
contracts, dependency direction, financial adapter location, event projection,
error propagation, cancellation semantics, and no-migration/no-registry
boundaries are approved.
