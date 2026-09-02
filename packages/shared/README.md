# @harness/shared

Utilitas lintas paket — nol dependensi internal, dipakai semua paket lain.

| Modul | Isi |
|---|---|
| `errors.ts` | `UserFriendlyError { code, message, suggestion }`, `toUserFriendly` |
| `constants.ts` | `ENV` (nama env terkunci), limit, konstanta sistem |
| `canonical.ts` | `sortKeys` + `canonicalJson` — JSON deterministik (key di-sort rekursif) |
| `prompt.ts` | `renderEvidenceBlock` — zona [1] prompt; format harus byte-identical antar agent dalam satu run (cache prefix) |
| `rubric.ts` | `RUBRIC_WEIGHTS` (25/20/20/20/15), `normalizeJudgmentScore` (renormalisasi atas kategori non-null), `stanceForScore` (>60 bullish, <40 bearish, selainnya neutral) |

Catatan:
- `@harness/evidence` me-re-export `sortKeys`/`canonicalJson` dari sini — satu implementasi, dua pintu.
- Rubrik bersifat non-negotiable: `JudgeAgent` menghitung ulang skor/stance dari breakdown LLM; nilai skor yang datang dari LLM diabaikan.
