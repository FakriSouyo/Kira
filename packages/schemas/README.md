# @harness/schemas

Kontrak data Zod — satu-satunya tempat definisi shape; di-implement oleh `@harness/database`, divalidasi oleh agent dan validator.

| Modul | Isi |
|---|---|
| `claim.ts` | `ClaimSchema`/`Claim`, `BreakdownSchema`/`Breakdown`, `JudgmentSchema`/`Judgment` |
| `message.ts` | `AgentMessageSchema`/`AgentMessage` (message_type: observation/claim/decision) |
| `evidence.ts` | `EvidenceSchema`/`Evidence` (id, source, data, content_hash) |
| `intent.ts` | `IntentSchema`/`Intent` (judge/screen/challenge/compare/clarification + confidence) |
| `artifact.ts` | Versioned typed artifact envelopes and durable `ArtifactRef` identity for PR F (`BULL_CASE`, `BEAR_CASE`, `VERDICT`) |

Catatan:
- Bentuk TS di sini camelCase; pemetaan ke kolom DB snake_case hidup di `@harness/database` (bukan di paket ini).
- Skema juga dipakai `MockLLMClient` untuk memvalidasi output mock — mock yang menyimpang membuat test gagal.
