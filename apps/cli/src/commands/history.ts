import type { HarnessContext } from '../context';
import type { CommandHandler } from '../repl/loop';
import { color } from '../repl/renderer';
import { formatDuration } from '@harness/shared';
import { UserFriendlyError } from '@harness/shared';
import { resumeJudgeRun } from '../workflows/judgeWorkflow';
import type { AgentEvent } from '../repl/events';

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

export function makeResumeCommand(ctx: HarnessContext, options: { events?: (event: AgentEvent) => void; write?: (text: string) => void } = {}): CommandHandler {
  return async (args: string[], execution) => {
    const runId = args[0] ?? execution?.resume?.executionId;
    if (!runId) throw new UserFriendlyError('MISSING_ARG', 'No runId provided', 'Usage: /resume <runId>');
    if (!execution?.lifecycle || !execution.resume) throw new UserFriendlyError('INVALID_RESUME_CONTEXT', 'Resume commands must run inside an active conversation Session.', 'Use /resume <executionId> from the Kira prompt.');
    const artifacts = await resumeJudgeRun(ctx, runId, () => undefined, options.events ?? (() => undefined), {
      signal: execution.signal,
      lifecycle: execution.lifecycle,
      resumeExecutionId: execution.resume.executionId,
    });
    (options.write ?? ((text: string) => process.stdout.write(text)))(`${color.green(`✓ Resumed ${artifacts.run.id} to completion.`)}\n\n`);
  };
}

export function makeContinueCommand(ctx: HarnessContext, options: { events?: (event: AgentEvent) => void; write?: (text: string) => void } = {}): CommandHandler {
  return async (args: string[], execution) => await makeResumeCommand(ctx, options)(args, execution);
}
