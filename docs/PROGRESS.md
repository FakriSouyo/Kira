# Kira Progress

Last updated: 2026-09-24

## Current state

- T5 Judge Integration + Release Integrity is complete on master.
- KA Kira Identity Surface + Documentation Governance is the current slice.
- UA Kira Engine Extraction is next after KA.
- KB Internal Kira Identity Migration follows UA; U Research Composition follows KB.

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
