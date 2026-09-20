import { describe, expect, it } from 'vitest';
import { UserFriendlyError } from '@harness/shared';
import { parseInput } from '../src/repl/parser';

describe('parseInput (addendum §09)', () => {
  it('parses slash command with arguments', () => {
    expect(parseInput('/judge BBCA')).toEqual({ type: 'command', command: 'judge', args: ['BBCA'] });
    expect(parseInput('/screen profitable growing')).toEqual({
      type: 'command',
      command: 'screen',
      args: ['profitable', 'growing'],
    });
  });

  it('keeps one double-quoted argument together', () => {
    expect(parseInput('/search "net income growth"')).toEqual({
      type: 'command',
      command: 'search',
      args: ['net income growth'],
    });
  });

  it('supports mixed quoted and unquoted arguments', () => {
    expect(parseInput('/command BBRI "net income growth"')).toEqual({
      type: 'command',
      command: 'command',
      args: ['BBRI', 'net income growth'],
    });
  });

  it('supports multiple quoted arguments', () => {
    expect(parseInput('/command "first value" "second value"')).toEqual({
      type: 'command',
      command: 'command',
      args: ['first value', 'second value'],
    });
  });

  it('supports single-quoted arguments without retaining delimiters', () => {
    expect(parseInput("/command 'first value'")).toEqual({
      type: 'command',
      command: 'command',
      args: ['first value'],
    });
  });

  it('preserves backslashes instead of applying escape processing', () => {
    expect(parseInput('/export run_1 --out "C:\\My Reports\\result.md"')).toEqual({
      type: 'command',
      command: 'export',
      args: ['run_1', '--out', 'C:\\My Reports\\result.md'],
    });
  });

  it('command names are case-insensitive', () => {
    expect(parseInput('/JUDGE BBCA').command).toBe('judge');
    expect(parseInput('/HeLp').command).toBe('help');
  });

  it('routes non-slash input to natural language', () => {
    expect(parseInput('apakah BBCA layak dibeli?')).toEqual({
      type: 'natural_language',
      text: 'apakah BBCA layak dibeli?',
    });
  });

  it('does not tokenize quoted natural-language text', () => {
    expect(parseInput('should I judge "BBRI" now?')).toEqual({
      type: 'natural_language',
      text: 'should I judge "BBRI" now?',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseInput('  /judge BBCA  ')).toEqual({ type: 'command', command: 'judge', args: ['BBCA'] });
  });

  it('empty / whitespace-only input is empty natural language', () => {
    expect(parseInput('')).toEqual({ type: 'natural_language', text: '' });
    expect(parseInput('   ')).toEqual({ type: 'natural_language', text: '' });
  });

  it('bare "/" is an empty command', () => {
    expect(parseInput('/')).toEqual({ type: 'command', command: '', args: [] });
  });

  it('rejects an unmatched quote with a user-facing invalid-argument error', () => {
    expect(() => parseInput('/search "net income')).toThrow(UserFriendlyError);

    try {
      parseInput('/search "net income');
      throw new Error('expected parseInput to reject an unmatched quote');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_ARG',
        message: 'Unclosed quote',
        suggestion: 'Close the quoted argument, then try again.',
      });
    }
  });
});
