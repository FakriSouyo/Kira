/**
 * Metrics helper (Phase 5): format durasi eksekusi untuk REPL /history & renderer.
 */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '0.0s';
  return `${seconds.toFixed(1)}s`;
}
