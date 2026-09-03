import type { HarnessContext } from '../context';
import { writeCredentialsFile } from '../config';
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

/** Kredensial yang bisa diset lewat `/auth-set` (pola DSH: key mentah di file terpisah). */
const AUTH_SET_FIELDS: ReadonlyArray<{ name: string; apply: (cred: Record<string, unknown>, value: string) => void }> = [
  {
    name: 'SECTORS',
    apply: (cred, value) => (cred.sectors_api = { key: value }),
  },
  {
    name: 'LLM.AGENT',
    apply: (cred, value) => (cred.llm = { ...(cred.llm as object), agent: { api_key: value } }),
  },
  {
    name: 'LLM.ROUTER',
    apply: (cred, value) => (cred.llm = { ...(cred.llm as object), router: { api_key: value } }),
  },
];

/** `/auth-set KEY=VALUE` — tulis kredensial ke `.credentials.json` (mode 0600). */
function makeAuthSetCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    if (args.length === 0) {
      throw new UserFriendlyError(
        'MISSING_ARG',
        'No credentials provided',
        'Usage: /auth-set SECTORS=KEY LLM.AGENT=KEY LLM.ROUTER=KEY',
      );
    }
    const cred: Record<string, unknown> = {};
    for (const arg of args) {
      const eq = arg.indexOf('=');
      if (eq <= 0) {
        throw new UserFriendlyError('INVALID_ARG', `"${arg}" is not a valid KEY=VALUE`, 'Example: /auth-set SECTORS=sk-abc LLM.AGENT=sk-def');
      }
      const name = arg.slice(0, eq).toUpperCase();
      const value = arg.slice(eq + 1);
      const field = AUTH_SET_FIELDS.find((f) => f.name === name);
      if (!field) {
        throw new UserFriendlyError('INVALID_ARG', `Unknown credential "${name}"`, 'Known keys: SECTORS, LLM.AGENT, LLM.ROUTER');
      }
      field.apply(cred, value);
    }
    const path = writeCredentialsFile(ctx.homeDir, cred as unknown as Parameters<typeof writeCredentialsFile>[1]);
    process.stdout.write(`${color.green(`✓ Credentials saved to ${path}`)}\n\n`);
  };
}

export function buildCommands(ctx: HarnessContext): Map<string, CommandHandler> {
  const commands: Map<string, CommandHandler> = new Map([
    ['judge', makeJudgeCommand(ctx)],
    ['screen', makeScreenCommand(ctx)],
    ['auth-set', makeAuthSetCommand(ctx)],
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
