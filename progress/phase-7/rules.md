# Rules — Phase 7

- `mockEmbedding` deterministik (FNV hash → 8-dim normalized), tanpa network/API key (placeholder OpenAI `text-embedding-3-small` Future).
- `searchEvidence` read-only, scoring `keywordOverlap` + `cosineSimilarity` tie-break (placeholder pgvector).
- `/search <query> [--run <id>] [--limit N]` limit default 5 max 20, run default = last run (`listRuns(1)`).
- Normalized tables vision hanya docs (tidak migrasi) — Phase 7 tidak menambah tabel baru.
