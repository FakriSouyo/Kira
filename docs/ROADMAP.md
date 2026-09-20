# FinHarness Roadmap

> Canonical future sequence. For mutable implementation status, see [PROGRESS.md](PROGRESS.md). For implemented architecture, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Product direction

FinHarness is a stateful agent harness runtime with a financial-native evidence
and research layer. Its current product direction is IDX-oriented financial
research: explicit workflows acquire and verify data, code enforces integrity,
and durable state makes context, evidence, artifacts, and decisions inspectable.

> LLMs propose. Data proves. Code verifies. Context persists. FinHarness decides.

FinHarness is not a generic autonomous coding or computer-use harness. Natural
language conversation and explicit research commands remain separate product
boundaries.

## Documentation status vocabulary

Every statement in this roadmap is one of:

- **Current fact** — supported by the current source tree on `master`.
- **Future direction** — intended product or architecture direction, not yet implemented.
- **Not yet locked design** — a future decision whose exact types, schemas, APIs, or package layout remain open.

The roadmap locks sequencing and intent. Future implementation details remain
subject to source-driven design review.

## Canonical high-level sequence

```text
COMPLETED FOUNDATION

A-P
Q1
Q2
R1
R2A

CURRENT

R2B

NEXT

R2C

FUTURE KNOWLEDGE INPUT

S1
S2
S3

FUTURE EVIDENCE INTELLIGENCE

T

FUTURE RESEARCH PRODUCT COMPLETION

U1
U2 /research
U3 /compare
U4 /challenge
U5 /investigate
U6 /screen maturation
U7 /search maturation
U8 Conversation 2.0

FUTURE DECISION INTELLIGENCE

V Risk Committee
W Research Graph
X Decision Journal
Y Outcome Tracking + Reflection

FUTURE PRODUCT PLATFORM

Z1
Z2
Z3
Z4
```

The sequence intentionally combines architecture evolution with user-visible
research capability maturation. Discovery and design for later milestones may
begin earlier, but production implementations must not bypass the dependency
boundaries established by earlier milestones.

## Completed foundation — A-P, Q1, Q2, R1, R2A

The following milestones are complete on `master`:

- **A-P — Canonical lifecycle, context, evidence, artifacts, financial snapshots, and resumability:** Session → Turn → Execution, journal linkage, SessionWorkingContext, bounded context assembly, evidence and artifact authority, the provider-neutral financial seam, VerifiedFinancialSnapshot, durable profiles and checkpoints, and same-Execution `/judge` resume.
- **Q1 — Model Runtime + Provider Directory:** provider-neutral model runtime contracts, immutable provider/model directory snapshots, adapter boundaries, safe fingerprints, prepared calls, invocation metadata, and mock parity.
- **Q2 — Durable Model Selection + Production Integration:** append-only Session model intent, immutable runtime-plan composition, plan-aware context budgeting, actual model provenance, and runtime-plan-compatible Judge resume.
- **R1 — Typed Tool Runtime:** explicit typed `ToolDefinition` values, one-shot validation and execution, lifecycle observation, cancellation fencing, and explicit CLI financial adapters.
- **R2A — Capability Contracts + Immutable Registry:** domain-neutral capability descriptors, registration contracts, immutable deterministic discovery, duplicate/identity validation, and trusted lookup of explicit tool bindings.

The current Judge graph remains the source of truth: it has 15 stable nodes,
`JUDGE_WORKFLOW_VERSION` remains `2`, and no obsolete historical Judge graph is
restored by this roadmap.

## R2 — Capability Runtime

R2 is decomposed so that capability identity, authorization, and production
integration do not become one unreviewable boundary.

### R2A — Capability Contracts + Immutable Registry

Status: **complete on `master`**.

R2A answers:

> What executable capabilities are registered and discoverable?

The `@harness/capability` package provides:

- `CapabilityDescriptor` — safe public, data-only metadata with `id`, `displayName`, `description`, `kind: 'tool'`, and `integrationId`;
- `CapabilityRegistration<TTool>` — a descriptor bound internally to an explicit `ToolDefinition`;
- `CapabilityRegistry` — immutable registration and discovery truth;
- `CapabilityRegistryError` — typed `UNKNOWN_CAPABILITY`, `DUPLICATE_CAPABILITY`, and `INVALID_CAPABILITY_REGISTRATION` failures.

The registry supports `list()`, `describe(id)`, and trusted lookup-only
`resolveTool(id)`. Discovery returns detached frozen descriptors ordered by
canonical capability ID. Construction rejects empty required fields, invalid
tool bindings, duplicate IDs, and descriptor/tool ID disagreement.

The authorities remain separate:

```text
CapabilityDescriptor
    = safe public discovery data

CapabilityRegistration
    = descriptor + explicit ToolDefinition binding

CapabilityRegistry
    = immutable registration/discovery truth

resolveTool()
    = trusted lookup-only binding access

ToolRuntime
    = execution authority
```

R2A is not authorization, execution, policy, workflow scheduling, provider
routing, persistence, MCP integration, or durable capability-plan semantics.
Financial tools have not been moved into the registry, and Judge/Screen
production paths have not been migrated.

### R2B — Deterministic Policy + Capability Gateway

Status: **current next milestone**.

R2B answers:

> Who may use which registered capability?

The conceptual direction is:

```text
Caller
  |
  v
explicit caller identity
  |
  v
Capability Gateway
  |          |
  |          +--> Capability Registry
  |
  +-------------> Capability Policy
  |
  v
explicit ToolDefinition
  |
  v
ToolRuntime
```

This is future direction only. The exact `CapabilityPrincipal` shape,
`CapabilityGrant` schema, policy representation, package layout, error names,
and gateway method signatures are **not yet locked**. R2B must not treat
`resolveTool()` as an authorization boundary or allow production execution to
bypass the future gateway.

### R2C — Production Capability Integration + Resume Semantics

Status: **future**.

R2C is the production integration phase. The intended path is:

```text
Workflow / Command
        |
        v
explicit caller identity
        |
        v
Capability Gateway
        |
        v
explicit ToolDefinition
        |
        v
ToolRuntime
        |
        v
domain integration
        |
        v
FinancialDataProvider
        |
        v
provider implementation
```

Existing financial tools should eventually travel through this boundary without
bypassing `FinancialDataProvider`.

R2C must also address capability-related execution semantic compatibility for
durable resumability. If an Execution starts under capability semantics A and a
later process attempts to resume it under materially different policy or
integration semantics, FinHarness must not silently resume under the changed
execution authority.

A deterministic secret-free representation or fingerprint may be needed, but a
finalized `CapabilityPlan` type and its compatibility rules are **not yet
locked**.

## Authorization boundaries

These distinctions are architectural invariants:

```text
WorkflowNode.executor != authorization
Subagent skill != executable permission
Skill content != capability grant
CapabilityRegistry != policy
CapabilityGateway != ToolRuntime
ToolRuntime != workflow scheduler
```

`WorkflowNode.executor` remains audit ownership metadata only. A subagent does
not receive executable capabilities merely because of `manifest.skills`,
`executor.id`, persona, agent name, or workflow ownership.

## Why the milestone ordering exists

The dependency order is intentional:

```text
R
controlled executable capabilities

S
durable external/user-provided knowledge inputs

T
stronger evidence and claim semantics

U
user-visible research products composed from those foundations

V-Y
higher-order decision and longitudinal research intelligence

Z
product surfaces over the mature shared core
```

Capability authority must be explicit before file, document, or external
knowledge inputs become reusable capabilities. Durable attachments and document
understanding should precede stronger evidence and claim relationships. Those
foundations then support complete research products, decision intelligence, and
finally cross-surface product delivery.

## S — Files & Documents

S is future knowledge-input work. It is deliberately distinct from Evidence,
Artifacts, Context, and Memory.

### S1 — Durable File / Attachment Layer

Future direction:

```text
user file
   |
   v
durable attachment identity
   |
   +--> content hash
   +--> metadata
   +--> Session/Turn association
```

Possible inputs include annual reports, filings, CSV files, financial
spreadsheets, text documents, PDFs, and research notes.

```text
Attachment != Document != Evidence != Artifact != Context
```

### S2 — Workspace + File Capability

Future direction: controlled file/workspace capabilities built on the R2
capability system. Possible examples include `workspace.list`,
`workspace.read`, `workspace.search`, `file.describe`, and `file.read`.
These are examples only; exact IDs are not locked. FinHarness must not gain
arbitrary shell access or become an unrestricted machine-operation harness.

### S3 — Document Understanding / Retrieval

Future direction:

```text
Attachment
   |
   v
Document
   |
   v
structured pages/sections/chunks
   |
   v
retrieval
   |
   v
citation/provenance
   |
   v
Evidence candidate
```

Potential provenance includes file identity, document identity, page, section,
chunk, content hash, and extraction metadata. Exact schemas are not locked.

## T — Evidence Policy + Claim Graph

Status: **future**.

T strengthens explicit relationships among Evidence, Claims, Theses,
Counterclaims, and Artifacts:

```text
Evidence A --supports--> Claim 1
Evidence B --contradicts--> Claim 1
Claim 1 --supports--> Thesis A
Claim 2 --challenges--> Thesis A
```

Directional relationship examples include `supports`, `contradicts`,
`qualifies`, `depends_on`, `derived_from`, and `supersedes`. Evidence Policy
may eventually reason about source eligibility, freshness, primary versus
secondary sources, subject compatibility, financial periods, execution scope,
claim requirements, and provenance. No finalized Claim Graph schema exists
today.

## U — Research Composition + Product Completion

U is a milestone family, not one implementation PR:

```text
U1 - Reusable Research Subgraph Foundation
U2 - /research
U3 - /compare
U4 - /challenge
U5 - /investigate
U6 - /screen maturation
U7 - /search maturation
U8 - Conversation 2.0
```

Each U2-U8 capability should be implemented and reviewed as an independent
vertical slice, with smaller architecture PRs where necessary. Workflow graphs,
node counts, package topology, specialist assignments, artifact schemas, and
public APIs are not finalized by this roadmap.

### `/judge` current role

Current fact: `/judge` is the mature research vertical used to establish and
validate FinHarness lifecycle, evidence, specialist-context, artifact,
workflow, model-runtime, and resumability architecture. It is not intended to
be FinHarness's only research product. The current 15-node Judge graph remains
source truth.

### U1 — Reusable Research Subgraph Foundation

Future goal: avoid building every research command as an independent monolithic
workflow. Directional reusable operations may include company resolution,
financial/market/news/filing retrieval, verified snapshot construction,
evidence selection, fundamental/growth/valuation/risk analysis, source
verification, period normalization, and contradiction resolution. Fixed APIs,
node graphs, and package locations are not locked.

### U2 — `/research`

Current status: **stub**.

Future `/research` is a non-debate, evidence-backed company research product;
`/research` is not `/judge`. Directional output may cover company overview,
financial health, growth, profitability, valuation, market position, recent
developments, risks, open questions, evidence coverage, data freshness, and
confidence.

Directional flow:

```text
resolve company
     |
select required data/capabilities
     |
verified financial input
     |
evidence collection
     |
fundamentals / market / valuation / risk / developments
     |
claim verification
     |
research product
```

Exact output schemas are not locked.

### U3 — `/compare`

Current status: **stub**.

Future `/compare` should normalize comparable companies before comparison; it
should not produce unrelated reports and ask an LLM to compare them.

```text
Company A
Company B
Company C
    |
    v
comparable normalization
    |
    +--> periods
    +--> units
    +--> metrics
    +--> freshness
    |
    v
comparative research
```

Possible output includes comparable metrics, quality/growth/valuation
differences, risk trade-offs, strengths, weaknesses, normalization warnings,
and evidence coverage. Exact metrics and workflow graph are not locked.

### U4 — `/challenge`

Current status: **stub**.

Future `/challenge` stress-tests an explicit thesis or research claim; it is
not simply “run Bear”.

```text
parse thesis
   |
extract claims
   |
retrieve supporting and contradicting evidence
   |
verify sources
   |
identify unsupported assumptions and failure conditions
   |
produce challenge result
```

Possible outputs include the strongest supporting case, strongest counter-case,
unsupported assumptions, contradictions, failure conditions, and evidence that
would change the thesis. Artifact shape is not locked.

### U5 — `/investigate`

Current status: **stub**.

Future `/investigate` is a scoped investigation workflow:

```text
scope question
   |
retrieve filings/news/financial observations
   |
build timeline
   |
rank primary evidence
   |
detect contradictions
   |
assess materiality
   |
findings and unresolved questions
```

Possible outputs include a timeline, primary sources, claims, contradictions,
material impact, confidence, and unresolved issues. Exact nodes are not locked.

### U6 — `/screen` maturation

Current status: **implemented**.

Future maturation may add criteria parsing, universe selection, deterministic
hard filters, deterministic ranking, selective verification, and a richer
screen research product. Hard filters, ranking rules, and numeric calculations
remain deterministic; the LLM must not freely invent screening scores.

### U7 — `/search` maturation

Current status: **implemented**.

Future maturation may retrieve across Evidence, Documents, and Artifacts or
research products using keyword retrieval, semantic retrieval, deduplication,
source quality, freshness/validity, and ranking. `/search` is not unrestricted
arbitrary internet browsing; any external web access must remain an explicit
capability.

### U8 — Conversation 2.0: Retained Conversational Continuity and Composition

Current fact: conversation infrastructure already exists. It includes
`ConversationJournal`, `ConversationController`, `SessionWorkingContext`,
artifact-aware context retrieval, `ContextPacket`, `ContextSnapshot`, token
budgeting, same-session research-context follow-up, streaming output, and
restart-safe durable research context.

Current limitation: production conversation preparation explicitly passes
`conversationHistory: ''`. FinHarness therefore does not yet provide full
general retained multi-turn transcript injection to the model.

Future Conversation 2.0 may add bounded recent turns, summaries, reference
resolution, relevance-aware retrieval, research artifact and document context,
token-budgeted composition, and auditable ContextSnapshots. It must remain
bounded, relevance-aware, token-budgeted, and auditable rather than blindly
injecting the raw transcript.

Conversation-derived claims remain conversational/user context unless verified
through an explicit evidence-producing research workflow.

## V — Risk Committee

Future direction: structured multi-dimensional risk assessment, not merely the
Bear agent. Possible dimensions include financial, valuation, market, business,
evidence, and freshness risk. Possible outputs include risk factors, severity,
supporting evidence, contradictions, failure scenarios, and monitoring
triggers. Specialist composition and schema are not locked.

## W — Research Graph

Future direction: durable long-term research state linking subjects, claims,
evidence, artifacts, investigations, and research products.

```text
BBRI
 |
 +-- Claim A
 |    +-- Evidence
 |    +-- superseded by Claim B
 |
 +-- Research report
 +-- Investigation
 +-- Risk assessment
```

The Research Graph is not the Context Engine. Context consumes selected
projections from durable research state:

```text
ResearchGraph != ContextPacket
ResearchGraph != SessionWorkingContext
```

The database model is not locked.

## X — Decision Journal

Future direction: explicit durable decisions and their reasoning context.
Conceptual fields may include decision, date, research references, claim
references, assumptions, conditions, and confidence.

```text
Decision:
Watch BBRI

Rationale:
valuation attractive but margin risk remains

Conditions:
reconsider if condition X changes
```

```text
DecisionJournal != conversation history
```

The schema is not locked.

## Y — Outcome Tracking + Reflection

Future direction:

```text
research / decision
       |
       v
observed later outcome
       |
       v
comparison with original assumptions
       |
       v
explicit reflection
```

Reflection may ask which assumptions were correct, which evidence was missing,
which signals mattered, and what changed after the decision. This is explicit
durable research output/state, not self-training model weights, autonomous model
modification, or uncontrolled long-term learning.

## Z — Product Platform

The product-platform family is:

- **Z1 — Application Host / API Boundary:** Future direction: shared runtime/business logic behind a service boundary rather than duplicated per surface. Exact transport is not locked.
- **Z2 — Web Surface:** Future direction: a web product surface over the same canonical runtime and durable state; it does not own independent research logic.
- **Z3 — Desktop Host + Desktop Shell:** a future host/shell around shared FinHarness application logic, without duplicating lifecycle, context, or research implementations.
- **Z4 — Cross-Surface Integration / Final Polish:** final cross-surface integration for this roadmap generation, not a declaration that FinHarness can never receive another feature.

The desired consistency is:

```text
CLI
Web
Desktop
   |
   v
same Sessions
same Turns
same Executions
same Artifacts
same capabilities
same research products
same durable state
```

## Invariant ledger

These distinctions should remain visible in the appropriate canonical
documents:

```text
context != storage
context != full history
working context != ContextPacket
cache != memory
workflow != intelligence
agent != data source
LLM != calculator

provider response != provider cache
provider cache != normalized observation
normalized observation != VerifiedFinancialSnapshot
VerifiedFinancialSnapshot != Evidence
Evidence != Artifact
Artifact != Context
Context != Memory

Artifact != WorkflowNodeOutput
Artifact != ContextSnapshot
checkpoint/resume != provider cache reuse
checkpoint/resume != artifact reuse
checkpoint/resume != context replay
checkpoint/resume != journal replay

ConversationJournal != ConversationSummary
ConversationSummary != SessionWorkingContext
ConversationSummary != Evidence
SessionWorkingContext != ContextPacket
ContextPacket != Evidence
Evidence != Artifact
Artifact != ResearchGraph
ResearchGraph != DecisionJournal

skill != capability
executor metadata != authorization
registry != policy
gateway != ToolRuntime
```

## What this roadmap does not lock

The following remain future design work:

- exact R2B class names, policy schema, principal representation, and gateway signatures;
- exact R2C capability-semantic fingerprint type and resume compatibility model;
- exact U workflow node counts, package topology, specialist mapping, future artifact schemas, and public APIs;
- exact conversation-summary schema, Research Graph database model, and Decision Journal schema;
- exact desktop framework, web framework, and API transport;
- any future MCP adapter/client or autonomous tool loop.

This documentation PR creates no placeholder interfaces, packages, migrations,
runtime classes, or TODO implementation surfaces.

## Historical guardrails

Current source wins over historical design documents. The retired Phase 0-9
roadmap structures, obsolete specialist lists, obsolete persistence assumptions,
old UI assumptions, and obsolete 20-node Judge workflow are not canonical. The
current Judge definition has 15 nodes and remains authoritative.
