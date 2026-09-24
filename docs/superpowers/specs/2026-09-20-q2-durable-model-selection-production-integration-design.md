# Q2 Durable Model Selection + Production Integration

Historical design artifact from the FinHarness era. The current project is
Kira; this is not the current architecture authority.

Status: approved implementation design

This is a supporting design artifact for Q2. `README.md`, `ARCHITECTURE.md`,
`docs/ROADMAP.md`, `docs/PROGRESS.md`, and `CHANGELOG` remain the canonical
project documentation surfaces. This document does not introduce a new
planning or architecture hierarchy.

## Scope and invariants

Q2 makes model selection durable per research Session and makes the Q1 model
runtime the production authority for conversational and Judge model calls.
It preserves Q1 `PreparedModelCall` atomicity and PR P same-Execution resume
semantics.

The following authorities stay distinct:

1. default/configuration state describes the application’s initial runtime;
2. `SessionModelSelection` records durable user intent for one Session;
3. an `ExecutionRuntimePlan` describes the resolved primary and fallback routes
   for one workflow execution;
4. a `ModelCall` records the actual successful route used by one invocation.

A selection is not a fallback result. Fallback orchestration remains above one
Q1 prepared call per attempt. A prepared call retains its resolved directory
generation, descriptor, adapter, protocol, endpoint identity, capabilities,
and generation controls for its complete lifetime.

Non-goals: R1 capability/tool runtime, durable model selection for routers,
durable selection in the execution schema, model switching events, a new
`ModelCall` authority, checkpoint lifecycle redesign, graph/version changes,
files/documents, web/desktop work, PTC, JSONL, or real `/resume` changes beyond
Q2 runtime-plan validation.

## Provider composition and configuration

`LLMModelConfig.providerId` is the logical provider identity. The existing
`provider` field remains the transport/provider-family discriminator used by
the SDK (`openai` or `anthropic`). OpenRouter therefore resolves as
`providerId: openrouter`, `adapterId: openai-compatible`, and its selected
protocol/endpoint; it is not relabeled as logical provider `openai`.

`ProviderDirectory` remains an immutable detached snapshot. Replacement is
atomic at the directory/runtime boundary. A prepared call stores detached
resolved values and never observes later directory replacement. The runtime
plan descriptor is pure: describing a plan performs validation and canonical
fingerprinting only, without SDK construction, network calls, credential
reads, or mutable request state.

The CLI composition root resolves a selected logical route into endpoint,
protocol, adapter, credentials, capabilities, and generation controls. Missing
selected routes fail explicitly; they do not silently fall back to defaults.
Credentials and private request/session affinity are excluded from semantic
runtime descriptors and fingerprints. API-key rotation therefore remains
resume-compatible.

## Durable SessionModelSelection

The session core contract is append-only and versioned:

```ts
type SessionModelSelection = {
  sessionId: string;
  version: number;
  providerId: string;
  modelId: string;
  source: 'initial' | 'user' | 'legacy';
  selectedAt: string;
};
```

The store exposes current/history reads and an atomic append operation. Versions
are monotonic per Session. `research_sessions.provider/model` remain readable
legacy fields and are not deleted or repurposed. Migration `0014` adds
`session_model_selections`, backfills one version-1 `legacy` selection from
each existing Session, and adds nullable actual-runtime identity columns to
`model_calls`. Existing ModelCall rows remain truthfully `NULL` for fields
that were not available historically.

Session-local setters append a selection and rebuild only in-memory future-call
composition. They do not write `config.json`. Opening a Session loads its
latest selection; creating a new Session records its initial selection. Session
selection is isolated by `sessionId` and survives database recreation.

## ExecutionRuntimePlan and context

The runtime exposes a serializable plan descriptor with the selected primary
route, ordered fallback routes, effective capabilities, generation controls,
and a semantic runtime fingerprint. The plan is captured for a lifecycle Judge
Execution before provider acquisition and embedded in the new Q2 execution
profile payload. Older PR P profiles remain readable through the legacy
provider/model compatibility path.

Context budgeting receives capabilities from the exact plan used by the
execution. It uses the configured capability first and conservative fallback
windows only when the descriptor does not provide a usable value. Raw global
configuration is not treated as authoritative after a Session selection has
resolved a plan.

## Result-bearing production integration

`MainFinHarnessAgent` consumes result-bearing runtime APIs and passes actual
metadata to its callback only after success. Streaming retains final metadata
and never transparently restarts after externally visible output.

`SubagentRuntime` requires result-bearing metadata on the production path; it
does not fabricate provider/model identity from a compatibility option. Mock
runtime results obey the same contract and remain deterministic/offline.

Workflow trace persistence records actual successful metadata:

- logical `providerId`;
- `modelId`;
- `adapterId`;
- `protocol`;
- secret-free `runtimeFingerprint`;
- legacy provider/model compatibility fields;
- usage, finish reason, latency, and context snapshot linkage.

Fallback attempts generate distinct prepared calls. A successful result records
the route that actually succeeded, not the selected primary route.

## Judge and resume compatibility

Judge remains exactly 15 nodes and workflow version 2. New lifecycle profiles
pin the Q2 runtime plan in addition to the existing semantic payload. Resume
validation happens before model/provider acquisition and rejects semantic plan
drift in endpoint/model/protocol/adapter/capabilities/generation/fallback
identity. Credential rotation and other excluded private transport identity do
not reject resume. The existing same-Execution checkpoint and node-output
lifecycle remain unchanged.

The router is a separate runtime selection domain from the Session research
model. Q2 does not add durable router selection.

## TDD and verification sequence

Implementation proceeds in small test-first phases:

1. session-selection contracts, migration/backfill, restart persistence, and
   no-`config.json` setter writes;
2. logical provider composition and pure execution-plan description;
3. context-budget plan capabilities and Q1 result-bearing production paths;
4. actual ModelCall provenance and Judge profile/resume validation;
5. compatibility, mock, and documentation regression tests.

Focused tests must cover cross-session isolation, restart persistence, missing
route errors, plan purity, fallback identity, metadata truth, API-key rotation,
and legacy profile/row readability. Verification ends with frozen install,
typecheck, complete tests, lint, and `git diff --check`.

## Commit shape

The supporting design artifact is committed separately from implementation so
the review can distinguish approved intent from code. Production changes are
kept in focused implementation/hardening commits and are not pushed or
merged by this task.
