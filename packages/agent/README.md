# @harness/agent

Agent — **pure function**: membaca evidence read-only, mengembalikan respons terstruktur, tanpa menyentuh DB. Persistensi dilakukan workflow di `apps/cli`.

| Modul | Isi |
|---|---|
| `bull.ts` | `BullAgent.analyze` — system 2 zona (evidence + persona), `generateObject` → reasoning + klaim |
| `judge.ts` | `JudgeAgent.evaluate` — **menghitung ulang skor & stance** dari breakdown via rubrik `@harness/shared`; nilai LLM diabaikan |
| `router.ts` | `IntentRouter.route` — klasifikasi intent + ticker/criteria; confidence < 0.7 → clarification |
| `bear.ts` | Stub Phase 1 — melempar `BEAR_NOT_AVAILABLE` |
| `prompts/*` | Zona prompt: `EVIDENCE_PREAMBLE`, `buildEvidenceZone`, persona Bull/Judge/Router |
| `types.ts` | `BullAnalysisResponse`, `JudgeLLMOutputSchema`, `BullLLMOutputSchema` |

Catatan:
- Zona [1] (preamble + evidence block) harus byte-identical antar agent dalam satu run — jangan sisipkan data volatil.
- Test memakai fakes (`test/fakes.ts`): `FakeLLM` + evidence store read-only yang menolak write.
