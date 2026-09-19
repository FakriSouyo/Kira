import * as readline from 'node:readline';
import { failToUserFriendly } from '../commands';
import { parseInput } from './parser';
import { color, renderError, renderUnknownCommand, resetProgress } from './renderer';

export interface CommandResult {
  quit?: boolean;
  reload?: boolean;
  /** The input owner releases readline/raw mode while this interaction runs. */
  suspend?: () => Promise<void>;
}
export interface CommandExecution {
  signal?: AbortSignal;
  input?: string;
  lifecycle?: { sessionId: string; turnId: string };
  /** Existing lifecycle ownership for /resume and /continue control commands. */
  resume?: { executionId: string; turnId: string };
}
export type CommandHandler = (args: string[], execution?: CommandExecution) => Promise<CommandResult | void>;
export interface ReplOptions {
  commands: Map<string, CommandHandler>;
  handleNaturalLanguage: (text: string, execution?: { signal?: AbortSignal }) => Promise<void>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function completeCommand(line: string, names: string[]): [string[], string] {
  const commands = names.map((name) => `/${name}`).sort();
  if (!line.startsWith('/') || /\s/.test(line)) return [[], line];
  return [commands.filter((name) => name.startsWith(line.toLowerCase())), line];
}

/** Serial line queue for pipes; real completion, cancellation and suspension for TTY. */
export async function startRepl(opts: ReplOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const terminal = (input as NodeJS.ReadStream).isTTY === true && (output as NodeJS.WriteStream).isTTY === true;
  const pending: string[] = [];
  let resolveLine: ((line: string | null) => void) | undefined;
  let closed = false;
  let shouldExit = false;
  let active: AbortController | undefined;
  let lastSigint = 0;
  let history: string[] = [];
  const prompt = () => { if (terminal && !closed) { rl.setPrompt(color.cyan('❯ ')); rl.prompt(); } };
  const open = () => {
    closed = false;
    const reader = readline.createInterface({ input, output, terminal, history, completer: (line: string) => completeCommand(line, [...opts.commands.keys()]) });
    reader.on('line', (line) => {
      if (resolveLine) { const resolve = resolveLine; resolveLine = undefined; resolve(line); }
      else pending.push(line);
    });
    reader.on('history', (lines: string[]) => {
      for (let i = lines.length - 1; i >= 0; i--) if (/^\s*\/auth-set\b/i.test(lines[i])) lines.splice(i, 1);
      history = [...lines];
    });
    reader.on('close', () => { closed = true; resolveLine?.(null); resolveLine = undefined; });
    reader.on('SIGINT', () => {
      if (active) {
        active.abort();
        output.write('\nCancellation requested — waiting for the current operation to finish.\n');
      } else if (Date.now() - lastSigint < 1500) {
        shouldExit = true; reader.close();
      } else {
        lastSigint = Date.now();
        reader.write(null, { ctrl: true, name: 'u' });
        output.write('\nPress Ctrl+C again (or /exit) to quit.\n'); prompt();
      }
    });
    return reader;
  };
  let rl = open();
  const nextLine = () => new Promise<string | null>((resolve) => {
    const line = pending.shift();
    if (line !== undefined) resolve(line);
    else if (closed) resolve(null);
    else resolveLine = resolve;
  });

  prompt();
  try {
    while (!shouldExit) {
      const line = await nextLine();
      if (line === null) break;
      active = new AbortController();
      resetProgress();
      try {
        const parsed = parseInput(line);
        if (parsed.type === 'command' && parsed.command) {
          const handler = opts.commands.get(parsed.command);
          if (!handler) output.write(`${renderUnknownCommand(parsed.command)}\n`);
          else {
            const result = await handler(parsed.args, { signal: active.signal, input: line });
            if (result?.suspend) {
              rl.close();
              try { await result.suspend(); } finally { rl = open(); }
            }
            if (result?.quit) break;
          }
        } else if (parsed.type === 'natural_language' && parsed.text) {
          await opts.handleNaturalLanguage(parsed.text, { signal: active.signal });
        }
      } catch (error) { output.write(`${renderError(failToUserFriendly(error))}\n`); }
      finally { active = undefined; }
      prompt();
    }
  } finally { rl.close(); }
}
