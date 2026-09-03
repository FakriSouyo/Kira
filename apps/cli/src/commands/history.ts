import type { HarnessContext } from '../context';
import type { CommandHandler } from '../repl/loop';
import { color } from '../repl/renderer';
import { formatDuration } from '@harness/shared';
import { UserFriendlyError } from '@harness/shared';

export function makeHistoryCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    let limit = 20;
    const limitIdx = args.indexOf('--limit');
    if (limitIdx !== -1) {
      const v = Number(args[limitIdx + 1]);
      if (!Number.isFinite(v) || v <= 0) throw new UserFriendlyError('INVALID_ARG', '--limit must be a positive number', 'Usage: /history [--limit N]');
      limit = Math.min(100, Math.floor(v));
    }
    const runs = await ctx.db.execution.listRuns({ limit });
    if (runs.length === 0) {
      process.stdout.write(`${color.gray('No runs yet — try /judge BBCA')}\n\n`);
      return;
    }
    const lines = [color.bold('History (recent runs):'), ''];
    for (const r of runs) {
      const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '';
      const dur = formatDuration(r.executionTime);
      lines.push(`  ${color.gray(r.id)}  ${color.bold(r.ticker)}  ${r.status}  ${color.dim(when)}  ${color.dim(dur)}`);
    }
    lines.push('', color.gray('View: /session <runId>  ·  Export: /export <runId>'));
    process.stdout.write(lines.join('\n') + '\n\n');
  };
}

export function makeSessionCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    const runId = args[0];
    if (!runId) throw new UserFriendlyError('MISSING_ARG', 'No runId provided', 'Usage: /session <runId>');
    const art = await ctx.db.execution.getExecutionWithArtifacts(runId);
    // reuse markdown renderer for audit trail
    const { renderExportMarkdown } = await import('../repl/renderer.js');
    const md = renderExportMarkdown(art);
    process.stdout.write(md + '\n\n');
  };
}

export function makeResumeCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    const runId = args[0];
    if (!runId) throw new UserFriendlyError('MISSING_ARG', 'No runId provided', 'Usage: /resume <runId>');
    // Phase 4: alias to session view — full re-run deferred (hemat token, no side effect)
    const art = await ctx.db.execution.getExecutionWithArtifacts(runId);
    const { renderExportMarkdown } = await import('../repl/renderer.js');
    const md = renderExportMarkdown(art);
    process.stdout.write(`${color.yellow('Resume (Phase 4): displaying session ' + runId + ' — full re-run deferred')}\n\n` + md + '\n\n');
  };
}
