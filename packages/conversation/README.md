# @harness/conversation

Abstraksi percakapan antar agent dalam satu run.

| Modul | Isi |
|---|---|
| `store.ts` | Interface `ConversationStore` (append/getByRun) — implementasi SQLite di `@harness/database` |

Catatan:
- Urutan dijamin `sequence_order` per run; agent menerima conversation sebagai input read-only.
- Persistensi (append) dilakukan workflow di `apps/cli`, bukan agent.
