import { openDb } from '@harness/database';
import { createLLMClient } from '@harness/llm';
import { createSectorsApi } from '@harness/sectors-api';
import { failToUserFriendly } from './commands';
import { loadConfig } from './config';
import { startRepl } from './repl/loop';
import { renderBanner, renderError } from './repl/renderer';
import { createHarnessSession } from './repl/session';
import { VERSION } from './commands/version';
import { needsSetup } from './setup/service';
import { statusLine } from './setup/components/StatusLine';

const USAGE = `Usage: pnpm finharness [options]

Financial Agent Harness — evidence-based stock research REPL.

Options:
  --home <dir>       Data directory (default: ~/.finharness)
  --mock-sectors     Use offline Sectors API fixtures (no API key needed)
  --mock-llm         Use deterministic offline LLM (no API key needed)
  --no-setup         Skip first-run wizard even if config missing
  --debug            Verbose startup logs
  --version          Show version and exit
  -h, --help         Show this help`;

interface CliArgs {
  home?: string;
  mockSectors?: boolean;
  mockLlm?: boolean;
  help?: boolean;
  version?: boolean;
  noSetup?: boolean;
  debug?: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock-sectors') args.mockSectors = true;
    else if (a === '--mock-llm') args.mockLlm = true;
    else if (a === '--version') args.version = true;
    else if (a === '--no-setup') args.noSetup = true;
    else if (a === '--debug') args.debug = true;
    else if (a === '--home') args.home = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (args.debug) process.env.FINHARNESS_DEBUG = 'true';

  let config = loadConfig({ homeDir: args.home, mockSectors: args.mockSectors, mockLlm: args.mockLlm });

  const shouldWizard =
    !args.noSetup &&
    !args.mockSectors &&
    !args.mockLlm &&
    !process.env.CI &&
    process.stdout.isTTY &&
    needsSetup(config);

  if (shouldWizard) {
    const sectors = createSectorsApi({
      mock: false,
      apiKey: config.sectors.apiKey || undefined,
      baseUrl: config.sectors.baseUrl,
      cacheTtlHours: config.sectors.cacheTtlHours,
      newsCacheTtlHours: config.sectors.newsCacheTtlHours,
      homeDir: config.homeDir,
    });
    const agentLlm = createLLMClient(config.llm.agent, { mock: false });
    const routerLlm = createLLMClient(config.llm.router, { mock: false });
    const { default: React } = await import('react');
    const { render } = await import('ink');
    const { SetupWizard } = await import('./setup/wizard.js');
    await new Promise<void>((resolve) => {
      const instance = render(
        // @ts-ignore dynamic
        React.createElement(SetupWizard, {
          homeDir: config.homeDir,
          deps: { sectors, agentLlm, routerLlm },
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
    config = loadConfig({ homeDir: args.home, mockSectors: args.mockSectors, mockLlm: args.mockLlm });
  }

  const db = openDb({ homeDir: config.homeDir, verbose: config.debug });
  const session = await createHarnessSession(db, config);

  if (config.debug) {
    process.stdout.write(`${renderBanner(config.homeDir, config.sectors.mock, config.mockLlm, VERSION)}\n\n`);
  } else {
    const line = statusLine(config);
    process.stdout.write(`⚡ FinHarness\nEvidence-based financial research\n${line}\n────────────────────────────────────────────\n\n`);
  }

  try {
    await startRepl({
      commands: session.commands,
      handleNaturalLanguage: session.handleNaturalLanguage,
    });
  } finally {
    await session.close();
    db.raw.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${renderError(failToUserFriendly(error))}\n`);
  process.exit(1);
});
