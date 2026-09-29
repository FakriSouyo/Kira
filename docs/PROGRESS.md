# Kira Progress

Last updated: 2026-09-30

## Current state

- T5 Judge Integration + Release Integrity is complete on master.
- KA Kira Identity Surface + Documentation Governance is complete on master.
- UA1 Host-neutral Capability Runtime Extraction is complete on master.
- UA2 Host-neutral Workflow Trace Extraction is complete on master.
- UA3 Host-neutral Screen Workflow Extraction is complete on master.
- UA4 Host-neutral Conversation Context Preparation Extraction is complete on master.
- UA5 Host-neutral WorkingContext Publication Extraction is complete on master.
- UA6 Host-neutral Workspace + Document Workflows Extraction is complete on master.
- UA7 Host-neutral Conversation Response Orchestration Extraction is complete on master.
- UA8 Host-neutral Session Restart Lifecycle Reconciliation Extraction is complete on master.
- UA9 Host-neutral Fresh-Turn Lifecycle Orchestration Extraction is complete on master.
- UA10 Host-neutral Attached-Turn Lifecycle Orchestration Extraction is complete on master.
- UA11 Special `/new` Turn Lifecycle Convergence is complete on master.
- UA12 Host-neutral Judge Node Runtime Extraction is complete on master.
- UA13 Host-neutral Judge Checkpoint + Resume Core Extraction is complete on master.
- UA14 Host-neutral Judge Resume Projection Repair Extraction is complete on master.
- UA15 Host-neutral Judge Current Release Core Extraction is complete on master.
- UA16 Host-neutral Judge Release Reconciliation Extraction is complete on master.
- UA17 Judge Workflow Host-Neutralization, including UA17A-D, is complete on master.
- UA17A Host-neutral Judge Runtime Composition Extraction is complete on master.
- UA17B Host-neutral Judge Execution Preparation + Resume Acquisition is complete on master.
- UA17C Host-neutral Judge Completion + Release Orchestration Extraction is complete on master.
- UA17D Host-neutral Judge Execution Lifecycle Orchestration is complete on master, closing the planned UA Kira Engine Extraction phase.
- Engine owns canonical fresh-Turn lifecycle orchestration for ordinary commands, natural-language conversation, local input, and the old-Session `/new` Turn through `runSessionTurn`, plus attached-Turn lifecycle orchestration after the host selects an existing target. The runner uses `ResearchSessionStore`; its normal success path uses `WorkingContextPublisher`, while `/new` explicitly opts out of success publication and its publication-only artifact reload.
- Engine owns the host-neutral Judge node runtime and coordinates supplied CapabilityGateway, specialist, and domain store contracts.
- Engine owns Judge checkpoint encoding/decoding, dependency fingerprints, resume compatibility planning, and restore-frontier derivation through supplied WorkflowNodeOutput, FinancialSnapshot, Evidence, and ContextSnapshot stores.
- Engine owns durable Judge resume projection repair for WorkflowStep, Conversation, Claim, Counterpoint, Judgment, and ModelCall projections through narrow host-supplied stores.
- Engine owns current Judge release preparation and publication through `JudgeReleaseStores`: current checkpoint completeness, durable Claim/Counterpoint parity, Claim Graph parity and artifact projections, current artifact construction, and release receipt construction.
- Engine owns completed Judge release reconciliation and historical artifact reconstruction through `JudgeReleaseReconciliationStores`, reusing the current release core for T5 and the canonical artifact builder for historical executions.
- Engine owns successful lifecycle-backed Judge completion through `completeJudgeExecution`: immutable profile-based current/history selection, current release validation before settlement, current artifact/receipt publication after settlement, and historical artifact reconstruction after settlement. Post-settlement errors identify the completed Execution and preserve the publication cause.
- Engine owns canonical Judge lifecycle resolution through `runJudgeExecutionLifecycle`: it composes preparation, runtime, and completion; settles fresh preparation/runtime/pre-settlement completion failures as failed or cancelled; leaves resume incompatibility before acquisition untouched; and returns post-settlement publication failures without resettling.
- Engine owns Judge workflow runtime composition through one canonical WorkflowRunner, WorkflowTraceRecorder, JudgeCheckpointWriter, post-acquisition projection repair, restore-state composition, and typed runtime results.
- Engine owns host-neutral Judge Execution creation, immutable profile persistence, resume compatibility planning, and same-Execution acquisition through the existing Session, profile, and checkpoint store contracts. The host still selects `/resume` and `/continue` targets.
- CLI still owns `/new` Session creation, configuration/provider/model rebinding, ConversationController switching, journal reconciliation and prepared-context commit, `/resume` and `/continue` argument validation and target selection, host abort classification and friendly error policy, concrete release/reconciliation store adapters, startup invocation timing, journal/transcript and AgentEvent projection, provider composition, streaming presentation, and reload/suspend behavior. Startup reconciliation remains before the Session artifact reload used for WorkingContext publication. The engine preparation operation completes resume planning before acquisition; engine projection repair follows acquisition and precedes WorkflowRunner execution.
- U Research Composition / Product Completion is the current broad phase. The KB blocking gate is closed: KB1 CLI Config Identity Rename and KB2 Main Agent Identity Rename are complete on master. Remaining FinHarness compatibility identities are deferred and unscheduled, and are not a prerequisite to U.
- U1A Research Composition Contract Audit, U1B Research Report Publication Boundary, and U1C Reusable Verified Research Acquisition are complete. The U1 Research Foundation is complete. NEXT is U2 `/research`; `/research` remains unimplemented.

The canonical dependency sequence and future design boundaries live in
[ROADMAP.md](ROADMAP.md). Current architecture facts live in
[ARCHITECTURE.md](../ARCHITECTURE.md). This file is the mutable status view.

## Current product surface

- Natural-language conversation provides bounded financial chat and does not
  silently launch a research workflow.
- /judge is the mature evidence-backed research workflow.
- /screen and /search are implemented and remain open to future maturation.
- Attachment and document commands are implemented for explicit user-selected
  files and deterministic local document search.
- /research, /compare, /challenge, and /investigate are not implemented.

See [README.md](../README.md) for the product entry point and current command
distinctions.

## Maintenance

Update this file when the current slice, next slice, or implemented command
status changes. Keep detailed dependency order in ROADMAP.md and architecture
facts in ARCHITECTURE.md; do not copy their full contents here.
