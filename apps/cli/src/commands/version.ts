import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandHandler } from '../repl/loop';
import { color } from '../repl/renderer';

function loadVersion(): string {
  try {
    // apps/cli/src/commands -> ../../.. -> root
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, '../../../..', 'package.json');
    const raw = readFileSync(root, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version) return parsed.version;
  } catch {
    // fallback
  }
  return '0.1.0';
}

export const VERSION = loadVersion();

export function makeVersionCommand(): CommandHandler {
  return async () => {
    process.stdout.write(`${color.cyan(`Kira v${VERSION}`)}\n\n`);
  };
}
