import type { HarnessContext } from '../context';
import type { CommandHandler, CommandResult } from '../repl/loop';
import {
  color,
  renderError,
  renderHelp,
  renderJudgeResult,
  renderScreenResult,
  renderStub,
  writeProgress,
} from '../repl/renderer';
import { judgeWorkflow } from '../workflows/judgeWorkflow';
import { screenWorkflow } from '../workflows/screenWorkflow';
import { UserFriendlyError } from '@harness/shared';
import { SectorsApiError } from '@harness/sectors-api';

const TICKER_RE = /^[A-Z]{2,6}$/;

function assertTicker(value: string): string {
  const ticker = value.toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    throw new UserFriendlyError(
      'INVALID_TICKER',
      `Ticker "${value}" looks invalid`,
      'Use an IDX ticker, e.g. /judge BBCA',
    );
  }
  return ticker;
}

function failToUserFriendly(error: unknown): UserFriendlyError {
  if (error instanceof UserFriendlyError) return error;
  if (error instanceof SectorsApiError) {
    return new UserFriendlyError(error.code, error.message, error.suggestion);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new UserFriendlyError('UNKNOWN_ERROR', message, 'Check the output above, or retry.');
}

function makeJudgeCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    if (args.length === 0) {
      throw new UserFriendlyError('MISSING_TICKER', 'No ticker provided', 'Usage: /judge TICKER  (e.g. /judge BBCA)');
    }
    const ticker = assertTicker(args[0]);
    const artifacts = await judgeWorkflow(ctx, ticker, (phase, line) =>
      writeProgress(process.stdout, phase, line),
    );
    process.stdout.write(`\n${renderJudgeResult(artifacts)}\n\n`);
  };
}

function makeScreenCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    const criteria = args.map((a) => a.toLowerCase());
    const artifacts = await screenWorkflow(ctx, criteria);
    process.stdout.write(`${renderScreenResult(artifacts)}\n\n`);
  };
}

/** Stub roadmap — pola pesan sama untuk semua (addendum §18). */
function makeStub(command: string): CommandHandler {
  return async () => {
    process.stdout.write(`${renderStub(command)}\n\n`);
  };
}

export function buildCommands(ctx: HarnessContext): Map<string, CommandHandler> {
  const commands: Map<string, CommandHandler> = new Map([
    ['judge', makeJudgeCommand(ctx)],
    ['screen', makeScreenCommand(ctx)],
    ['help', async () => {
      process.stdout.write(`${renderHelp()}\n\n`);
    }],
    ['exit', async (): Promise<CommandResult> => {
      process.stdout.write(`${color.dim('Goodbye! 👋')}\n`);
      return { quit: true };
    }],
  ]);
  for (const stub of ['challenge', 'compare', 'investigate', 'research']) {
    commands.set(stub, makeStub(stub));
  }
  return commands;
}

/** Jembatan Intent Router → command (dipakai handleNaturalLanguage). */
export function isRoutableCommand(name: string, commands: Map<string, CommandHandler>): boolean {
  return commands.has(name);
}

export { renderError, failToUserFriendly };
