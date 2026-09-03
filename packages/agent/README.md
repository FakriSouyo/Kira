# @harness/agent

Agent — **pure function**: membaca evidence read-only, mengembalikan respons terstruktur, tanpa menyentuh DB. Persistensi dilakukan workflow di `apps/cli`.

| Modul | Isi |
|---|---|
| `bull.ts` | `BullAgent.analyze` + `rebuttal` (Phase 1) — system 2 zona (evidence + persona), `generateObject` → reasoning + klaim |
| `bear.ts` | `BearAgent.challenge` (Phase 1) — klaim Bull + evidence → counterpoints `targetClaimId`/`argument`/`strength` |
| `judge.ts` | `JudgeAgent.evaluate` — **menghitung ulang skor & stance** dari breakdown via rubrik `@harness/shared`; nilai LLM diabaikan |
| `router.ts` | `IntentRouter.route` — klasifikasi intent + ticker/criteria; confidence < 0.7 → clarification |
| `prompts/*` | Zona prompt: `EVIDENCE_PREAMBLE`, `buildEvidenceZone`, persona Bull/Bear/Judge/Router, `buildBullRebuttalPrompt` |
| `types.ts` | `BullAnalysisResponse`, `BearChallengeResponse`, `BearCounterpoint`, `JudgeLLMOutputSchema`, `BullLLMOutputSchema`, `BearLLMOutputSchema` |

Catatan:
- Zona [1] (preamble + evidence block) harus byte-identical antar agent dalam satu run — jangan sisipkan data volatil.
- Test memakai fakes (`test/fakes.ts`): `FakeLLM` + evidence store read-only yang menolak write.
