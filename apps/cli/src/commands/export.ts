import { writeFileSync } from 'node:fs';
import type { HarnessContext } from '../context';
import type { CommandHandler } from '../repl/loop';
import { color } from '../repl/renderer';
import { renderExportHtml, renderExportJson, renderExportMarkdown } from '../repl/renderer';
import { UserFriendlyError } from '@harness/shared';

/** /export <runId> [--format json|md|html] [--out <path>] */
export function makeExportCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    let runId: string | undefined;
    let format: string = 'json';
    let outPath: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--format' && i + 1 < args.length) {
        format = args[++i].toLowerCase();
      } else if (a.startsWith('--format=')) {
        format = a.slice('--format='.length).toLowerCase();
      } else if (a === '--out' && i + 1 < args.length) {
        outPath = args[++i];
      } else if (a.startsWith('--out=')) {
        outPath = a.slice('--out='.length);
      } else if (!a.startsWith('--') && !runId) {
        runId = a;
      } else if (!a.startsWith('--')) {
        // ignore extra non-flag args
      }
    }

    if (!runId) {
      throw new UserFriendlyError('MISSING_ARG', 'No runId provided', 'Usage: /export <runId> [--format json|md|html] [--out <path>]');
    }
    if (!['json', 'md', 'html'].includes(format)) {
      throw new UserFriendlyError('INVALID_ARG', `Unknown format "${format}"`, 'Known formats: json, md, html');
    }

    // will throw NOT_FOUND if runId tak ada (UserFriendlyError dari store)
    const artifacts = await ctx.db.execution.getExecutionWithArtifacts(runId);

    let output: string;
    if (format === 'json') output = renderExportJson(artifacts);
    else if (format === 'md') output = renderExportMarkdown(artifacts);
    else output = renderExportHtml(artifacts);

    if (outPath) {
      writeFileSync(outPath, output, 'utf8');
      process.stdout.write(`${color.green(`✓ Exported ${runId} (${format}) → ${outPath}`)}\n`);
    } else {
      process.stdout.write(output + '\n');
    }
  };
}
