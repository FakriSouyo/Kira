# Q1 — Model Runtime + Provider Directory Design

## Scope and non-goals

Q1 evolves `@harness/llm` into the canonical FinHarness model-runtime seam.
It adds provider-neutral route, capability, descriptor, directory, adapter, and
prepared-call contracts while preserving the existing `LLMClientLike` facade
and provider behavior.

Q1 does not add durable model selection, Session model-switch events, database
migrations, ModelCall or ExecutionProfile schema changes, Tool Runtime,
Capability Registry, files, documents, Web/Desktop surfaces, JSONL storage, or
changes to `/judge`, PR P resume semantics, or the 15-node Judge graph.

## Design invariants

- A logical `providerId`, `adapterId`, wire `protocol`, and `modelId` are
  distinct values. Provider IDs are validated non-empty strings, not a finite
  union.
- A `ProviderDirectory` is an immutable snapshot. Its records are detached and
  frozen at composition time. Replacing the directory creates a new generation;
  it cannot mutate records used by an existing request.
- `ModelRuntime.prepareCall()` resolves exactly one route, model, adapter,
  protocol, endpoint identity, capability set, generation-control set, and
  runtime descriptor. A `PreparedModelCall` never switches route or adapter.
- Compatibility fallback is orchestration above the boundary: each fallback
  attempt prepares a separate call. Metadata describes the call that actually
  succeeded.
- Safe descriptors and fingerprints are JSON-safe and secret-free. API keys,
  session affinity IDs, request IDs, timestamps, functions, paths, mutable
  clients, and abort controllers are private runtime state only.
- Effective capabilities describe what FinHarness can provide to consumers;
  native-provider capability facts may remain separate where structured JSON
  fallback makes the effective runtime more capable than the provider wire API.
- Existing retry, fallback order, backoff, Responses/opencode compatibility,
  custom OpenAI-compatible endpoints, structured JSON fallback, prompt zones,
  cancellation, and deterministic mock output remain behaviorally compatible.

## Dependency direction

```text
CLI / workflows / specialists
          │
          ▼
  LLMClientLike compatibility facade
          │
          ▼
  ModelRuntime ── ProviderDirectory snapshot
          │       AdapterRegistry snapshot
          ▼
  PreparedModelCall ── one ModelAdapter
          │
          ▼
  Vercel AI SDK/provider implementation
```

`@harness/llm` may depend on shared canonical utilities, Zod, and provider
SDKs. It does not depend on CLI, Context, WorkflowRunner, financial data,
database, SessionWorkingContext, or UI. Context continues to consume only
safe capability values; Q2 may connect production budgeting to the resolved
runtime descriptor.

## Core contracts

The implementation will add focused modules under `packages/llm/src`:

- `model-runtime.ts`: `ModelRuntime`, `PreparedModelCall`, and invocation
  operation contracts;
- `provider-directory.ts`: immutable directory snapshots and deterministic
  provider/model lookup;
- `adapter.ts`: provider-neutral adapter and registry contracts;
- `descriptor.ts`: safe descriptors, canonical semantic projection, and
  SHA-256 runtime fingerprints;
- `errors.ts`: typed runtime errors for unknown route/model/adapter,
  unsupported operations, invalid configuration, abort, and prepared-call
  reuse;
- `adapters/*`: Vercel AI SDK-backed OpenAI-compatible, Anthropic, and mock
  implementations.

The public runtime operations are result-bearing object and text generation,
metadata-capable text streaming, and structured streaming with compatible
partial callbacks. Compatibility value-only methods delegate to those result
paths.

## Directory generations and prepared calls

`ProviderDirectory` accepts a complete provider/model composition and exposes
deterministically sorted providers and models. Registration rejects duplicate
provider IDs and duplicate model IDs within one provider. `snapshot()` returns
detached immutable descriptors with a generation token. Runtime composition
holds the current directory and adapter registry as replaceable snapshots;
replacement is atomic at the JavaScript call boundary.

`prepareCall(route, controls)` resolves the current directory and adapter
registration once, constructs a secret-free `ModelRuntimeDescriptor`, and
captures private connection settings in the prepared call closure. The public
descriptor is detached/frozen. Dispatch checks the caller signal before any
adapter call, marks the call one-shot, and invokes only the captured adapter
with only the captured route/configuration. A second dispatch raises
`PREPARED_CALL_ALREADY_USED`. Replacing the directory or adapter registry
after preparation affects only later calls.

The compatibility client creates a prepared call for the primary route and,
after retry policy exhausts that call, creates a new prepared call for each
fallback route. A prepared call itself never owns a fallback list.

## Runtime identity and metadata

The semantic descriptor includes schema version, route, model, adapter,
protocol, normalized endpoint fingerprint, effective capabilities, and
generation controls. Its fingerprint is SHA-256 over repository-standard
canonical JSON. API-key changes, random session IDs, timestamps, JS identity,
function source, and machine paths are excluded. Changes to route, model,
adapter, protocol, endpoint identity, temperature, max output, or context
capability change the fingerprint.

Every successful result contains actual provider/model/adapter identity,
runtime fingerprint, usage fields with `null` for unknown values, finish
reason, and latency. A fallback result reports the fallback descriptor.
Failed or cancelled calls do not return success metadata.

## Adapter behavior

The OpenAI-compatible adapter serves native OpenAI, OpenRouter, custom
OpenAI-compatible endpoints, and future local/gateway routes through explicit
provider registrations. The Anthropic adapter remains separate. Protocol is
selected during provider registration/normalization, with legacy `baseURL`
heuristics retained only at the compatibility normalization boundary for
opencode Zen. The core runtime never switches on logical provider names.

The real adapters reuse existing Vercel AI SDK request behavior. Native
structured generation is attempted where supported; custom Responses JSON
fallback remains text-plus-local-Zod validation. Streaming never retries after
an externally visible chunk and exposes final metadata only when the stream
completes successfully.

The mock adapter uses an explicit stable identity (`mock`, `mock`, and the
existing deterministic mock model convention), returns null usage, obeys the
same result-bearing and one-shot contracts, and leaves domain output logic
unchanged.

## Implementation and verification plan

Implementation proceeds test-first in these slices:

1. Add route, capability, descriptor, error, and directory tests; implement
   the pure contracts and deterministic fingerprint.
2. Add fake-adapter tests for registry composition and exact prepared-call
   snapshot behavior, including directory generation A → B replacement.
3. Add one-shot and abort tests; implement `ModelRuntime.prepareCall()`.
4. Put the existing real client behavior behind the adapter/runtime boundary,
   preserving retry/fallback and custom endpoint paths.
5. Add result-bearing object/text/stream and structured-stream tests, including
   actual fallback metadata and no retry after the first emitted chunk.
6. Give the mock the same runtime contract and update only the compatibility
   plumbing required for parity.
7. Run focused LLM, SubagentRuntime, Context, Bull/Bear/Judge, and PR P suites,
   then the complete repository verification.
8. Update `docs/ROADMAP.md`, `docs/PROGRESS.md`, and `ARCHITECTURE.md` only;
   README and CHANGELOG change only if the existing policy requires it.

The implementation must stop and report if it requires a database migration,
durable selection state, lifecycle/Judge/schema changes, Context redesign,
command semantics, or any later milestone.

