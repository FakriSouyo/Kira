# Design — Phase 8 (Release & Distribution)

Tracking; source `planning/phase-8.md`.

## Tujuan

Hardening rilis: CI, CHANGELOG, README distribusi, bump 0.3.0.

## Keputusan

| Aspek | Keputusan | Lokasi |
|---|---|---|
| CI | pnpm check Node22 | `.github/workflows/ci.yml` |
| CHANGELOG | Phase 0→8 ringkas | `CHANGELOG.md` |
| README | Badge + commands + Phase7 vector | `README.md` |
| Version | 0.3.0 | `package.json` |

## Delta

- **Task 1–3 (done, 211/211):** `ci.yml` + `CHANGELOG.md` + `README.md` polish (badge/status/commands) + bump `0.3.0`; `ARCHITECTURE.md` #29. `pnpm check` tetap 211/211.
