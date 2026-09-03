import { describe, expect, it } from 'vitest';
import { createEventSink, serializeAgentEvent, type AgentEvent } from '../src/repl/events';

/** Wadah output minimal (aku-mirip WritableStream) untuk test sink. */
function fakeOutput() {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: unknown): boolean {
      writes.push(String(chunk));
      return true;
    },
  };
}

describe('Agent-Events JSONL (Phase 2 Task 2)', () => {
  it('serializeAgentEvent menghasilkan satu baris JSON untuk tiap varian', () => {
    const events: AgentEvent[] = [
      { type: 'session.start', runId: 'run_abc' },
      { type: 'session.complete', runId: 'run_abc', status: 'completed' },
      { type: 'phase', phase: 'researcher', label: "I'm starting..." },
      { type: 'tool.start', tool: 'company_report', ticker: 'BBCA' },
      { type: 'tool.complete', tool: 'company_report', durationMs: 12 },
      { type: 'evidence.found', id: 'ev_1', source: 'sectors.company_report' },
      { type: 'message.delta', agent: 'researcher', text: 'hello' },
    ];
    for (const ev of events) {
      const line = serializeAgentEvent(ev);
      // round-trip JSON
      expect(JSON.parse(line)).toEqual(ev);
    }
  });

  it('serializeAgentEvent menghasilkan output tanpa newline (JSONL murni)', () => {
    const line = serializeAgentEvent({ type: 'phase', phase: 'judge', label: 'x' });
    expect(line.includes('\n')).toBe(false);
    expect(line).toBe('{"type":"phase","phase":"judge","label":"x"}');
  });

  it('createEventSink menulis serialize+"\\n" ke output bila diberikan', () => {
    const out = fakeOutput();
    const sink = createEventSink(out as unknown as NodeJS.WritableStream);
    sink({ type: 'session.start', runId: 'run_1' });
    sink({ type: 'phase', phase: 'bull', label: 'go' });
    expect(out.writes).toHaveLength(2);
    expect(out.writes[0]).toBe('{"type":"session.start","runId":"run_1"}\n');
    expect(out.writes[1]).toBe('{"type":"phase","phase":"bull","label":"go"}\n');
  });

  it('createEventSink tanpa output adalah no-op (tidak melempar)', () => {
    const sink = createEventSink();
    expect(() => {
      sink({ type: 'session.complete', runId: 'run_1', status: 'failed' });
    }).not.toThrow();
  });
});