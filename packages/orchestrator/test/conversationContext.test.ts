import { describe, expect, it } from 'vitest';
import { classifyConversationFocus, renderContextPacket } from '../src/conversationContext.js';
import type { ContextPacket } from '@harness/context';

const packet = (overrides: Partial<ContextPacket> = {}): ContextPacket => ({
  schemaVersion: 1,
  sessionId: 'session-conversation',
  turnId: 'turn-follow-up',
  activeSubjects: [{ ticker: 'BBRI' }, { ticker: 'BMRI' }],
  intent: { command: 'conversation' },
  focusTopics: [],
  artifacts: [],
  userAssertions: [{ kind: 'USER_ASSERTION', id: 'assertion-1', text: 'Saya fokus pada kualitas bank.', turnId: 'turn-previous' }],
  assumptions: [{ kind: 'ASSUMPTION', id: 'assumption-1', text: 'Gunakan horizon jangka panjang.', turnId: 'turn-previous' }],
  unresolvedQuestions: [{ kind: 'OPEN_QUESTION', id: 'question-1', text: 'Apakah valuasinya masih masuk akal?', turnId: 'turn-previous' }],
  provenance: {
    sessionId: 'session-conversation',
    turnId: 'turn-follow-up',
    workingContextVersion: 4,
    sourceContextSequence: 9,
    sourceRefs: [],
    selectedArtifactIds: [],
    diagnostics: [],
  },
  ...overrides,
});

describe('conversation context focus and renderer', () => {
  it.each([
    ['jadi menurutmu bagaimana?', 'generic'],
    ['downside paling bahayanya apa?', 'downside'],
    ['bear case-nya gimana?', 'bear'],
    ['balik ke thesis BBRI tadi', 'thesis'],
    ['kenapa masih bullish?', 'bull'],
  ] as const)('classifies %s as %s without model work', (message, expected) => {
    expect(classifyConversationFocus(message)).toBe(expected);
  });

  it('falls back to generic for ambiguous wording', () => {
    expect(classifyConversationFocus('jelaskan lebih lanjut')).toBe('generic');
  });

  it('renders trust categories, subjects, and current-turn framing deterministically', () => {
    const first = renderContextPacket(packet());
    const second = renderContextPacket(packet());

    expect(first).toBe(second);
    expect(first).toContain('Active subjects: BBRI, BMRI');
    expect(first).toContain('USER ASSERTIONS');
    expect(first).toContain('Saya fokus pada kualitas bank.');
    expect(first).toContain('ASSUMPTIONS');
    expect(first).toContain('OPEN QUESTIONS');
    expect(first).toContain('prior Kira research state');
    expect(first).not.toContain('snapshot_');
    expect(first).not.toContain('workingContextVersion');
    expect(first).not.toContain('createdAt');
  });
});
