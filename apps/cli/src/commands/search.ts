import type { HarnessContext } from '../context';
import type { CommandHandler } from '../repl/loop';
import { renderSearchResult } from '../repl/renderer';
import { searchEvidence } from '@harness/database';
import { UserFriendlyError } from '@harness/shared';

export function makeSearchCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    if (args.length === 0) throw new UserFriendlyError('MISSING_ARG', 'No query provided', 'Usage: /search <query> [--run <runId>] [--limit N]');
    let runId: string | undefined;
    let limit = 5;
    const queryTokens: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run') runId = args[++i];
      else if (args[i] === '--limit') {
        const v = Number(args[++i]);
        if (Number.isFinite(v) && v > 0) limit = Math.min(20, Math.floor(v));
      } else queryTokens.push(args[i]);
    }
    const query = queryTokens.join(' ');
    if (!query) throw new UserFriendlyError('MISSING_ARG', 'No query provided', 'Usage: /search <query> [--run <runId>] [--limit N]');
    const results = await searchEvidence(ctx.db as unknown as import('@harness/database').FinharnessDatabase, { runId, query, limit });
    if (results.length === 0) {
      process.stdout.write(`${renderSearchResult(query, [], runId)}\n\n`);
      return;
    }
    process.stdout.write(`${renderSearchResult(query, results, runId)}\n\n`);
  };
}
