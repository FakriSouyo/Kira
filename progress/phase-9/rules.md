# Rules — Phase 9A

- Migration `0002` `IF NOT EXISTS` idempotent.
- `getEmbedding` offline → mock; online → mock fallback (hash vec) sampai API embedding real tersedia — tidak mem-block test.
- Abort check sebelum tiap step (`signal.aborted` → `UserFriendlyError ABORTED`).
