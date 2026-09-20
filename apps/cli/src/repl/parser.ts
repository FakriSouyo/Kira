/**
 * Parsing input REPL (addendum §09/§16):
 *   "/judge BBCA"   → command
 *   "apakah BBCA..." → natural language (→ MainFinHarnessAgent)
 */
import { UserFriendlyError } from '@harness/shared';

export type ParsedInput =
  | { type: 'command'; command: string; args: string[] }
  | { type: 'natural_language'; text: string };

function tokenizeCommand(input: string): string[] {
  const parts: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;

  for (const character of input) {
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        parts.push(token);
        token = '';
      }
    } else {
      token += character;
    }
  }

  if (quote) {
    throw new UserFriendlyError('INVALID_ARG', 'Unclosed quote', 'Close the quoted argument, then try again.');
  }

  if (token) parts.push(token);
  return parts;
}

export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (!trimmed) return { type: 'natural_language', text: '' };

  if (trimmed.startsWith('/')) {
    const parts = tokenizeCommand(trimmed.slice(1));
    const command = (parts[0] ?? '').toLowerCase();
    return { type: 'command', command, args: parts.slice(1).filter(Boolean) };
  }

  return { type: 'natural_language', text: trimmed };
}
