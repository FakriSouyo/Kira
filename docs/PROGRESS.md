# Kira Progress

Last updated: 2026-09-26

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
- UA16 Host-neutral Judge Release Reconciliation Extraction is implemented in the current isolated source-review worktree; it has not yet passed source review or merged.
- Later UA slices remain unselected until a fresh source audit.
- Engine owns canonical fresh-Turn lifecycle orchestration for ordinary commands, natural-language conversation, local input, and the old-Session `/new` Turn through `runSessionTurn`, plus attached-Turn lifecycle orchestration after the host selects an existing target. The runner uses `ResearchSessionStore`; its normal success path uses `WorkingContextPublisher`, while `/new` explicitly opts out of success publication and its publication-only artifact reload.
- Engine owns the host-neutral Judge node runtime and coordinates supplied CapabilityGateway, specialist, and domain store contracts.
- Engine owns Judge checkpoint encoding/decoding, dependency fingerprints, resume compatibility planning, and restore-frontier derivation through supplied WorkflowNodeOutput, FinancialSnapshot, Evidence, and ContextSnapshot stores.
- Engine owns durable Judge resume projection repair for WorkflowStep, Conversation, Claim, Counterpoint, Judgment, and ModelCall projections through narrow host-supplied stores.
- Engine owns current Judge release preparation and publication through `JudgeReleaseStores`: current checkpoint completeness, durable Claim/Counterpoint parity, Claim Graph parity and artifact projections, current artifact construction, and release receipt construction.
- Engine owns completed Judge release reconciliation and historical artifact reconstruction through `JudgeReleaseReconciliationStores`, reusing the current release core for T5 and the canonical artifact builder for historical executions.
- CLI still owns `/new` Session creation, configuration/provider/model rebinding, ConversationController switching, journal reconciliation and prepared-context commit, `/resume` and `/continue` argument validation and target selection, Judge Execution lifecycle, same-Execution acquisition, WorkflowRunner and trace composition, concrete release/reconciliation store adapters, startup invocation timing, journal/transcript and AgentEvent projection, provider composition, streaming presentation, and reload/suspend behavior. Current release ordering remains prepare, settle Execution, publish. Startup reconciliation remains before the Session artifact reload used for WorkingContext publication. Resume planning completes before acquisition; projection repair follows same-Execution acquisition and precedes WorkflowRunner.
- KB Internal Kira Identity Migration follows UA, then U Research Composition.

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
