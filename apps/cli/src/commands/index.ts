import type { HarnessContext } from '../context';
import { loadConfig, writeCredentialsFile } from '../config';
import type { CommandHandler, CommandResult } from '../repl/loop';
import type { AgentEvent } from '../repl/events';
import {
  color,
  renderError,
  renderHelp,
  renderFilesResult,
  renderDocumentIndexResult,
  renderDocumentSearchResult,
  renderJudgeResult,
  renderScreenResult,
  renderStub,
  writeProgress,
} from '../repl/renderer';
import { judgeWorkflow } from '../workflows/judgeWorkflow';
import { screenWorkflow } from '../workflows/screenWorkflow';
import { makeExportCommand } from './export';
import { makeContinueCommand, makeHistoryCommand, makeResumeCommand, makeSessionCommand } from './history';
import { makeSearchCommand } from './search';
import { createWebServer } from '../repl/web';
import { makeVersionCommand } from './version';
import { UserFriendlyError } from '@harness/shared';
import { FinancialDataError } from '@harness/financial-data';
import { DocumentError, buildDocumentBundle } from '@harness/document';
import { PROVIDERS } from '../setup/providers';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  attachmentToolIds,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
  COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
  COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
  documentToolIds,
} from '@harness/engine';

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
  if (error instanceof FinancialDataError) {
    return new UserFriendlyError(error.code, error.message, error.suggestion);
  }
  if (error instanceof DocumentError) {
    return new UserFriendlyError(error.code, error.message, 'Check the attachment type and integrity, then retry the document command.');
  }
  const message = error instanceof Error ? error.message : String(error);
  return new UserFriendlyError('UNKNOWN_ERROR', message, 'Check the output above, or retry.');
}

function makeJudgeCommand(ctx: HarnessContext, options: {
  write?: (text: string) => void;
  events?: (event: AgentEvent) => void;
} = {}): CommandHandler {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  return async (args: string[], execution) => {
    if (args.length === 0) {
      throw new UserFriendlyError('MISSING_TICKER', 'No ticker provided', 'Usage: /judge TICKER  (e.g. /judge BBCA)');
    }
    const ticker = assertTicker(args[0]);
    if (args.slice(1).some((arg) => arg !== '--conditional')) throw new UserFriendlyError('INVALID_ARG', 'Unknown /judge argument', 'Usage: /judge TICKER [--conditional]');
    const artifacts = await judgeWorkflow(ctx, ticker, (phase, line) =>
      writeProgress({ write } as NodeJS.WritableStream, phase, line), options.events ?? (() => {}), {
        signal: execution?.signal,
        lifecycle: execution?.lifecycle,
        conditional: args.includes('--conditional'),
      },
    );
    write(`\n${renderJudgeResult(artifacts)}\n\n`);
  };
}
function makeScreenCommand(ctx: HarnessContext): CommandHandler {
  return async (args: string[]) => {
    const criteria = args.map((a) => a.toLowerCase());
    const artifacts = await screenWorkflow(ctx, criteria);
    process.stdout.write(`${renderScreenResult(artifacts)}\n\n`);
  };
}

function makeFilesCommand(ctx: HarnessContext, write: (text: string) => void): CommandHandler {
  return async (args, execution) => {
    if (args.length !== 0) {
      throw new UserFriendlyError('INVALID_ARG', '/files does not take arguments', 'Usage: /files');
    }
    const result = await ctx.capabilityGateway.invoke(
      COMMAND_FILES_CAPABILITY_PRINCIPAL,
      attachmentToolIds.list,
      {},
      { signal: execution?.signal },
    );
    write(`${renderFilesResult(result.value)}\n\n`);
  };
}

function makeAttachCommand(ctx: HarnessContext, write: (text: string) => void): CommandHandler {
  return async (args, execution) => {
    if (args.length === 0) {
      throw new UserFriendlyError('MISSING_ARG', 'No file path provided', 'Usage: /attach "path with spaces/report.pdf"');
    }
    if (args.length !== 1) {
      throw new UserFriendlyError('INVALID_ARG', 'Expected exactly one file path', 'Quote paths that contain spaces: /attach "path with spaces/report.pdf"');
    }
    const lifecycle = execution?.lifecycle;
    if (!lifecycle) {
      throw new UserFriendlyError('MISSING_LIFECYCLE', 'Attachment import requires an active Session Turn', 'Retry the import from the Kira command prompt.');
    }
    const sourcePath = resolve(args[0]!);
    let sourceStat;
    try {
      sourceStat = await stat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new UserFriendlyError('ATTACHMENT_NOT_FOUND', 'The selected file was not found', 'Check the path and try /attach again.');
      }
      throw error;
    }
    if (!sourceStat.isFile()) {
      throw new UserFriendlyError('ATTACHMENT_NOT_FILE', 'The selected path is not a file', 'Choose one local file, not a directory.');
    }
    const content = await readFile(sourcePath);
    const attachment = await ctx.db.attachments.save({
      sessionId: lifecycle.sessionId,
      turnId: lifecycle.turnId,
      filename: basename(sourcePath),
      mediaType: null,
      content,
    });
    write(`Attached ${attachment.filename}\nAttachment: ${attachment.attachmentId}\nSize: ${attachment.sizeBytes} bytes\nSHA-256: ${attachment.contentHash}\n`);
  };
}

function makeDocumentIndexCommand(ctx: HarnessContext, write: (text: string) => void): CommandHandler {
  return async (args, execution) => {
    if (args.length !== 1) {
      throw new UserFriendlyError('INVALID_ARG', '/doc-index expects exactly one attachment ID', 'Usage: /doc-index <attachmentId>');
    }
    const lifecycle = execution?.lifecycle;
    if (!lifecycle) {
      throw new UserFriendlyError('MISSING_LIFECYCLE', 'Document indexing requires an active Session Turn', 'Retry the command from the Kira command prompt.');
    }
    const result = await ctx.capabilityGateway.invoke(
      COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
      attachmentToolIds.read,
      { attachmentId: args[0] },
      { signal: execution?.signal },
    );
    const bundle = await buildDocumentBundle({
      attachment: result.value.attachment,
      content: result.value.content,
      createdByTurnId: lifecycle.turnId,
    });
    const saved = await ctx.db.documents.save(bundle);
    write(`${renderDocumentIndexResult(saved.document)}\n\n`);
  };
}

function makeDocumentSearchCommand(ctx: HarnessContext, write: (text: string) => void): CommandHandler {
  return async (args, execution) => {
    if (args.length === 0) {
      throw new UserFriendlyError('MISSING_ARG', 'No document query provided', 'Usage: /doc-search <query> [--document <id>] [--limit N]');
    }
    let documentId: string | undefined;
    let limit: number | undefined;
    const queryTokens: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--document') {
        documentId = args[++index];
        if (!documentId) throw new UserFriendlyError('INVALID_ARG', 'Missing document ID', 'Usage: /doc-search <query> [--document <id>] [--limit N]');
      } else if (arg === '--limit') {
        const raw = args[++index];
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
          throw new UserFriendlyError('INVALID_ARG', 'Document search limit must be between 1 and 20', 'Usage: /doc-search <query> [--document <id>] [--limit N]');
        }
        limit = parsed;
      } else if (arg.startsWith('--')) {
        throw new UserFriendlyError('INVALID_ARG', `Unknown /doc-search argument ${arg}`, 'Usage: /doc-search <query> [--document <id>] [--limit N]');
      } else {
        queryTokens.push(arg);
      }
    }
    const query = queryTokens.join(' ').trim();
    if (!query) throw new UserFriendlyError('MISSING_ARG', 'No document query provided', 'Usage: /doc-search <query> [--document <id>] [--limit N]');
    const result = await ctx.capabilityGateway.invoke(
      COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
      documentToolIds.search,
      { query, ...(documentId ? { documentId } : {}), ...(limit ? { limit } : {}) },
      { signal: execution?.signal },
    );
    write(`${renderDocumentSearchResult(query, result.value)}\n\n`);
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

function makeWebCommand(ctx: HarnessContext): CommandHandler {
  let server: ReturnType<typeof createWebServer>['server'] | null = null;
  return async (args: string[]) => {
    if (server) {
      process.stdout.write(`${color.yellow('Web preview already running — stop it first with Ctrl+C')}\n\n`);
      return;
    }
    let port = 3280;
    const idx = args.indexOf('--port');
    if (idx !== -1) {
      const v = Number(args[idx + 1]);
      if (Number.isFinite(v) && v > 0) port = Math.floor(v);
    }
    const { server: srv } = createWebServer(ctx.db, { port });
    server = srv;
    await new Promise<void>((resolve, reject) => {
      srv.listen(port, () => {
        process.stdout.write(`${color.green(`✓ Web preview listening at http://localhost:${port}/`)}\n${color.dim('GET /  ·  GET /api/history  ·  GET /api/run/:id')}\n\n`);
        resolve();
      });
      srv.on('error', reject);
    });
  };
}

function maskKey(key: string): string {
  if (!key) return '(not set)';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}${'•'.repeat(Math.min(12, key.length - 6))}${key.slice(-3)}`;
}

function makeStatusCommand(ctx: HarnessContext): CommandHandler {
  return async () => {
    const cfg = loadConfig({ homeDir: ctx.homeDir });
    process.stdout.write(
      `${color.cyan('Kira Status')}\n` +
        `  Sectors API: ${cfg.sectors.apiKey ? color.green('✓ configured') : color.red('✗ missing')} ${color.dim(maskKey(cfg.sectors.apiKey))}\n` +
        `  AI Provider: ${cfg.llm.agent.provider} · ${cfg.llm.agent.model} ${cfg.llm.agent.apiKey ? color.green('✓') : color.red('✗')}\n` +
        `  Router: ${cfg.llm.router.provider} · ${cfg.llm.router.model} ${cfg.llm.router.apiKey ? color.green('✓') : color.red('✗')}\n` +
        `  Config: ${ctx.homeDir}/config.json | creds: ${ctx.homeDir}/.credentials.json\n\n`,
    );
  };
}

function makeProvidersCommand(): CommandHandler {
  return async () => {
    process.stdout.write(`${color.cyan('Providers')}\n`);
    for (const p of PROVIDERS) {
      const models = p.models.map((m) => m.label).join(', ');
      process.stdout.write(`  ${color.green(p.label)} (${p.id}) — ${models}${p.baseURL ? ` — ${p.baseURL}` : ''}\n`);
    }
    process.stdout.write('\n');
  };
}

function makeSetupCommand(ctx: HarnessContext): CommandHandler {
  return async () => {
    if (!process.stdout.isTTY) {
      const cfg = loadConfig({ homeDir: ctx.homeDir });
      process.stdout.write(
        `${color.cyan('Kira Setup')}\n` +
          `  Sectors API: ${cfg.sectors.apiKey ? '✓' : '✗'}\n` +
          `  AI Provider: ${cfg.llm.agent.provider} · ${cfg.llm.agent.model}\n` +
          `  Use /auth-set for non-interactive setup.\n\n`,
      );
      return;
    }
    const cfg = loadConfig({ homeDir: ctx.homeDir });
    const { createSectorsFinancialDataProvider } = await import('@harness/sectors-api');
    const { createLLMClient } = await import('@harness/llm');
    const { default: React } = await import('react');
    const { render } = await import('ink');
    const { SetupWizard } = await import('../setup/wizard.js');
    const financialData = createSectorsFinancialDataProvider({
      mock: false,
      apiKey: cfg.sectors.apiKey || undefined,
      baseUrl: cfg.sectors.baseUrl,
      cacheTtlHours: cfg.sectors.cacheTtlHours,
      newsCacheTtlHours: cfg.sectors.newsCacheTtlHours,
      homeDir: cfg.homeDir,
    });
    const agentLlm = createLLMClient(cfg.llm.agent, { mock: false });
    const routerLlm = createLLMClient(cfg.llm.router, { mock: false });
    await new Promise<void>((resolve) => {
      const instance = render(
        // @ts-ignore dynamic
        React.createElement(SetupWizard, {
          homeDir: cfg.homeDir,
          deps: { financialData, agentLlm, routerLlm },
          onDone: () => {
            try {
              (instance as unknown as { unmount: () => void }).unmount();
            } catch {}
            resolve();
          },
        }),
      );
      (instance as unknown as { waitUntilExit: () => Promise<void> }).waitUntilExit().then(() => resolve()).catch(() => resolve());
    });
    process.stdout.write('\n');
  };
}

export function buildCommands(ctx: HarnessContext, options: {
  write?: (text: string) => void;
  events?: (event: AgentEvent) => void;
  renderEvents?: boolean;
  onCleanup?: (fn: () => Promise<void>) => void;
  getReasoningMode?: () => 'usual' | 'reasoning';
} = {}): Map<string, CommandHandler> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const commands: Map<string, CommandHandler> = new Map([
    ['judge', makeJudgeCommand(ctx, options)],
    ['screen', makeScreenCommand(ctx)],
    ['files', makeFilesCommand(ctx, write)],
    ['attach', makeAttachCommand(ctx, write)],
    ['doc-index', makeDocumentIndexCommand(ctx, write)],
    ['doc-search', makeDocumentSearchCommand(ctx, write)],
    ['export', makeExportCommand(ctx)],
    ['history', makeHistoryCommand(ctx)],
    ['session', makeSessionCommand(ctx)],
    ['resume', makeResumeCommand(ctx, options)],
    ['continue', makeContinueCommand(ctx, options)],
    ['search', makeSearchCommand(ctx)],
    ['web', makeWebCommand(ctx)],
    ['version', makeVersionCommand()],
    ['auth-set', makeAuthSetCommand(ctx)],
    ['setup', makeSetupCommand(ctx)],
    ['status', makeStatusCommand(ctx)],
    ['providers', makeProvidersCommand()],
    ['new', async () => { write(`${color.dim('New session ready.')}\n\n`); }],
    ['help', async () => { write(`${renderHelp()}\n\n`); }],
    ['exit', async (): Promise<CommandResult> => {
      write(`${color.dim('Goodbye! 👋')}\n`);
      return { quit: true };
    }],
  ]);
  for (const stub of ['challenge', 'compare', 'investigate', 'research']) commands.set(stub, makeStub(stub));
  return commands;
}
/** Jembatan Intent Router → command (dipakai handleNaturalLanguage). */
export function isRoutableCommand(name: string, commands: Map<string, CommandHandler>): boolean {
  return commands.has(name);
}

export { renderError, failToUserFriendly };
