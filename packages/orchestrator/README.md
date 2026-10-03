# @harness/orchestrator

Main conversational Kira agent. It handles identity and bounded financial chat, then routes live or company-specific questions to an evidence workflow. Chat is analytical decision support and cannot issue transaction decisions; the human owns buy/sell/hold authority. MainKiraAgent and MAIN_KIRA_PROMPT are the current source identifiers; KB2 changed those names without changing behavior or prompt bytes.

It is deliberately separate from `packages/command/*` and `packages/subagent/*`: commands own workflow graphs and invoke only the specialists they need; this package never impersonates those specialists.
