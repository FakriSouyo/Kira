# Kira Progress

Last updated: 2026-09-25

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
- UA10 Host-neutral Attached-Turn Lifecycle Orchestration Extraction is the selected current slice.
- UA11 and later slices remain unselected until a fresh source audit.
- Engine owns fresh-Turn lifecycle orchestration for ordinary command, natural-language, and local-input Turns, plus attached-Turn lifecycle orchestration after the host selects an existing target. Both coordinate through `ResearchSessionStore` and `WorkingContextPublisher`.
- CLI still owns `/new` Session switching, `/resume` and `/continue` argument validation and target selection, ConversationController, journal/transcript and AgentEvent projection, Judge orchestration/checkpointing, provider composition, streaming presentation, and reload/suspend behavior. Judge owns compatibility validation and same-Execution acquisition/resume.
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
