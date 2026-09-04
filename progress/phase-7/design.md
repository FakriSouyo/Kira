# Design — Phase 7 (Future Prototype)

Tracking; source `planning/phase-7.md`.

## Tujuan

Prototipe Future vector search (in-memory mock) + CLI `/search` + vision normalized tables (docs only), tanpa migrasi DB.

## Keputusan

| Aspek | Keputusan | Lokasi |
|---|---|---|
| Vector | `cosineSimilarity` + `mockEmbedding` FNV 8-dim | `packages/shared/src/vector.ts` |
| Search | `searchEvidence(runId?, query, limit?)` keywordOverlap + cosine tie-break | `packages/database/src/search.ts` |
| CLI | `/search <query> [--run <id>] [--limit N]` | `apps/cli/src/commands/search.ts` |
| Renderer | `renderSearchResult` | `apps/cli/src/repl/renderer.ts` |
| Normalized vision | DDL vision `financials_normalized`, `daily_normalized` (docs only) | di bawah |

## Delta desain vs practical

- **Task 1–3 (done, 211/211):** `vector.ts` `mockEmbedding` FNV 8-dim + `cosineSimilarity`, `search.ts` `searchEvidence` (keywordOverlap + cosine tie), `search.ts` CLI `/search` + `renderSearchResult`, normalized vision DDL docs only. `vector.test.ts` (4) + `search.test.ts` (4) hijau; `pnpm check` 211/211.

## Future Schema Vision (normalized, tidak dieksekusi Phase 7)

```sql
-- Vision (addendum §27 Future) — belum migrasi di Phase 7 prototype
-- Normalized financials (1 row per ticker-year)
CREATE TABLE financials_normalized (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  year INT NOT NULL,
  revenue REAL, earnings REAL, roe REAL, net_margin REAL,
  UNIQUE(ticker, year)
);
-- Daily normalized (1 row per ticker-date)
CREATE TABLE daily_normalized (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL, volume INT,
  UNIQUE(ticker, date)
);
-- Vector (pgvector Future): evidence.vec VECTOR(1536)
-- CREATE EXTENSION vector;
-- ALTER TABLE evidence ADD COLUMN vec VECTOR(1536);
```
Prototipe Phase 7 memakai `JSON.stringify(data)` + mock embedding, bukan pgvector real.
