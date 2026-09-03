# Rules — Phase 5

- Version single source: `package.json` version. `apps/cli/src/commands/version.ts` baca via `readFileSync` + fallback `0.1.0` bila tidak ada.
- Banner `renderBanner(homeDir, mockSectors, mockLlm, version?)` — version opsional, default `0.1.0`.
- Metrics: `formatDuration(sec: number | null): string` → `0.0s` bila null, `X.Ys` satu desimal.
- Help harus mencantumkan `/history`, `/session`, `/resume`, `/web`, `/export`, `/judge`, `/screen`.
