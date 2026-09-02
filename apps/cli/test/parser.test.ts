import { describe, expect, it } from 'vitest';
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
});
