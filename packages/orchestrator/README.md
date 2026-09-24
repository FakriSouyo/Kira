# @harness/orchestrator

Main conversational Kira agent. It handles identity and bounded financial chat, then recommends an evidence workflow when live or company-specific facts are needed. The source symbol MainFinHarnessAgent remains unchanged until KB.

It is deliberately separate from `packages/command/*` and `packages/subagent/*`: commands own workflow graphs and invoke only the specialists they need; this package never impersonates those specialists.
