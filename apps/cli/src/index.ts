import { openDb } from '@harness/database';
import type { Intent } from '@harness/schemas';
import { UserFriendlyError } from '@harness/shared';
import { buildCommands, failToUserFriendly } from './commands';
import { loadConfig } from './config';
import { buildContext, type HarnessContext } from './context';
import type { CommandHandler } from './repl/loop';
import { startRepl } from './repl/loop';
import { renderBanner, renderError, renderStub } from './repl/renderer';

const USAGE = `Usage: pnpm finharness [options]

Financial Agent Harness — evidence-based stock research REPL.

Options:
  --home <dir>       Data directory (default: ~/.finharness)
  --mock-sectors     Use offline Sectors API fixtures (no API key needed)
  --mock-llm         Use deterministic offline LLM (no API key needed)
  -h, --help         Show this help`;

interface CliArgs {
  home?: string;
  mockSectors?: boolean;
  mockLlm?: boolean;
  help?: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock-sectors') args.mockSectors = true;
    else if (a === '--mock-llm') args.mockLlm = true;
    else if (a === '--home') args.home = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/** Natural language → Intent Router → command (addendum §20). */
async function handleNaturalLanguage(
  ctx: HarnessContext,
  commands: Map<string, CommandHandler>,
  text: string,
): Promise<void> {
  let intent: Intent;
  try {
    intent = await ctx.router.route(text);
  } catch (error) {
    process.stdout.write(`${renderError(failToUserFriendly(error))}\n`);
    return;
  }

  if (intent.type === 'clarification') {
    process.stdout.write(`⚠️  Not sure what you mean. Did you mean:\n${intent.question ?? ''}\n\n`);
    return;
  }

  if (intent.type === 'judge') {
    if (!intent.ticker) {
      process.stdout.write('Which ticker should I analyze? Try: /judge BBCA\n\n');
      return;
    }
    process.stdout.write(`↳ Routing to /judge ${intent.ticker}...\n`);
    await runCommand(commands, 'judge', [intent.ticker]);
    return;
  }

  if (intent.type === 'screen') {
    const criteria = intent.criteria ?? text;
    process.stdout.write(`↳ Routing to /screen "${criteria}"...\n`);
    await runCommand(commands, 'screen', [criteria]);
    return;
  }

  // challenge / compare → stub roadmap (Phase 1)
  process.stdout.write(`↳ Routing to /${intent.type}...\n`);
  process.stdout.write(`${renderStub(intent.type)}\n\n`);
}

async function runCommand(
  commands: Map<string, CommandHandler>,
  name: string,
  args: string[],
): Promise<void> {
  const handler = commands.get(name);
  if (!handler) throw new UserFriendlyError('UNKNOWN_COMMAND', `Unknown command /${name}`, 'Try /help');
  await handler(args);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig({ homeDir: args.home, mockSectors: args.mockSectors, mockLlm: args.mockLlm });
  const db = openDb({ homeDir: config.homeDir, verbose: config.debug });
  const ctx = buildContext(db, config);
  const commands = buildCommands(ctx);

  process.stdout.write(`${renderBanner(config.homeDir, config.sectors.mock, config.mockLlm)}\n\n`);

  await startRepl({
    commands,
    handleNaturalLanguage: (text) => handleNaturalLanguage(ctx, commands, text),
  });

  db.raw.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${renderError(failToUserFriendly(error))}\n`);
  process.exit(1);
});
