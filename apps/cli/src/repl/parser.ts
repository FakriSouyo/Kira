/**
 * Parsing input REPL (addendum §09/§16):
 *   "/judge BBCA"   → command
 *   "apakah BBCA..." → natural language (→ Intent Router)
 */
export type ParsedInput =
  | { type: 'command'; command: string; args: string[] }
  | { type: 'natural_language'; text: string };

export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (!trimmed) return { type: 'natural_language', text: '' };

  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(/\s+/);
    const command = (parts[0] ?? '').toLowerCase();
    return { type: 'command', command, args: parts.slice(1).filter(Boolean) };
  }

  return { type: 'natural_language', text: trimmed };
}
