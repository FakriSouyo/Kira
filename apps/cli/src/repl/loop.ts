import * as readline from 'node:readline';
import { UserFriendlyError } from '@harness/shared';
import { parseInput } from './parser';
import { color, renderError, renderUnknownCommand, resetProgress } from './renderer';

export interface CommandResult {
  /** Akhiri REPL setelah command selesai. */
  quit?: boolean;
}

export type CommandHandler = (args: string[]) => Promise<CommandResult | void>;

export interface ReplOptions {
  commands: Map<string, CommandHandler>;
  handleNaturalLanguage: (text: string) => Promise<void>;
  /** Injection untuk test. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const PROMPT = color.cyan('❯ ');
const SIGINT_WINDOW_MS = 1500;

/**
 * Loop REPL interaktif (addendum §09/Task 16):
 *   - slash command → dispatcher; selain itu → Intent Router (NL)
 *   - Tab completion slash command (mode terminal)
 *   - History atas/bawah ( bawaan readline di mode terminal)
 *   - Ctrl+C: saat executing → cancel request (best effort); saat idle →
 *     double Ctrl+C keluar. /exit atau Ctrl+D keluar sopan.
 */
export async function startRepl(opts: ReplOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const isTerminal =
    (input as { isTTY?: boolean }).isTTY === true &&
    (output as { isTTY?: boolean }).isTTY === true;

  const rl = readline.createInterface({ input, output, terminal: isTerminal });
  const commandNames = [...opts.commands.keys()].sort();
  let executing = false;
  let shouldExit = false;
  let lastSigint = 0;

  const prompt = (): void => {
    if (isTerminal) {
      rl.setPrompt(PROMPT);
      rl.prompt(true);
    }
  };

  // Tab completion (hanya mode terminal — buffered pipe tidak punya line buffer).
  if (isTerminal) {
    rl.on('keypress', (_char, key) => {
      if (!key || key.name !== 'tab' || executing) return;
      const line = (key as { line?: string }).line ?? '';
      if (!line.startsWith('/')) return;
      const partial = line.slice(1).split(/\s+/)[0].toLowerCase();
      const hits = commandNames.filter((name) => name.startsWith(partial));
      try {
        if (hits.length === 1) {
          const state = rl as unknown as { _line?: string };
          state._line = `/${hits[0]} `;
          rl.prompt(true); // redraw baris dengan hasil completion
        } else if (hits.length > 1) {
          output.write(`\n  ${color.dim(hits.map((h) => `/${h}`).join('   '))}\n`);
        }
      } catch {
        // fallback: tampilkan daftar tanpa mengganti baris
        if (hits.length > 0) {
          output.write(`\n  ${color.dim(hits.map((h) => `/${h}`).join('   '))}\n`);
        }
      }
    });
  }

  rl.on('SIGINT', () => {
    if (executing) {
      // Phase 0: cancel best-effort — workflow melanjutkan langkah saat ini
      // lalu berhenti di batas fase berikutnya.
      output.write(`\n${color.yellow('⚠  Execution in progress — cancel requested at next phase boundary.')}\n`);
      return;
    }
    const now = Date.now();
    if (now - lastSigint < SIGINT_WINDOW_MS) {
      output.write('\n');
      shouldExit = true;
      rl.close();
      return;
    }
    lastSigint = now;
    output.write(`\n${color.gray('Press Ctrl+C again (or /exit) to quit.')}\n`);
  });

  // Line queue: piped input bisa mengirim semua baris sekaligus (burst);
  // event 'line' yang tiba sebelum loop meminta baris berikutnya ditampung,
  // tidak dibuang.
  const pendingLines: string[] = [];
  let pendingResolve: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on('line', (line: string) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(line);
    } else {
      pendingLines.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(null);
    }
  });

  const nextLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      const buffered = pendingLines.shift();
      if (buffered !== undefined) resolve(buffered);
      else if (closed) resolve(null);
      else pendingResolve = resolve;
    });

  prompt();
  for (;;) {
    if (shouldExit) break;
    const line = await nextLine();
    if (line === null) break; // close (Ctrl+D / stream habis)

    const parsed = parseInput(line);
    if (parsed.type === 'natural_language' && parsed.text === '') {
      prompt();
      continue;
    }

    executing = true;
    resetProgress();
    try {
      if (parsed.type === 'command') {
        if (parsed.command === '') {
          // "/" kosong — abaikan
        } else {
          const handler = opts.commands.get(parsed.command);
          if (handler) {
            const result = await handler(parsed.args);
            if (result?.quit) break;
          } else {
            output.write(`${renderUnknownCommand(parsed.command)}\n`);
          }
        }
      } else {
        await opts.handleNaturalLanguage(parsed.text);
      }
    } catch (error) {
      const friendly = toFriendly(error);
      output.write(`${renderError(friendly)}\n`);
    } finally {
      executing = false;
    }
    if (shouldExit) break;
    prompt();
  }

  rl.close();
}

function toFriendly(error: unknown): UserFriendlyError {
  if (error instanceof UserFriendlyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new UserFriendlyError('UNKNOWN_ERROR', message, 'Check the output above, or retry.');
}
