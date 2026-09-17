/** Public conversation contracts. Opaque evidence/execution IDs belong to the audit stores. */
export type RunState = 'running' | 'completed' | 'failed' | 'cancelled';
export type ResearchState = 'starting' | 'fetching' | 'processing' | 'cross_checking' | 'building_evidence' | 'complete' | 'failed' | 'cancelled';
export interface ResearchTask {
  id: string;
  title: string;
  state: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  summary?: string;
}
export interface DisplayEvidence {
  displayId: string;
  title: string;
  type: string;
  sourceName: string;
  sourceDate?: string;
  metrics: Array<{ name: string; value: string }>;
  summary: string;
  confidence?: string;
}
export interface ResearchRun {
  state: ResearchState;
  tasks: ResearchTask[];
  evidence: DisplayEvidence[];
  summary?: string;
}
export interface AgentPosition {
  side: 'bull' | 'bear';
  headline: string;
  summary: string;
  /** Intentionally generated public rationale, never provider reasoning tokens. */
  reasoningSummary: string;
  evidenceIds: string[];
  durationMs: number;
}
export interface DebateArgument extends AgentPosition {
  id: string;
  round: number;
  state: RunState;
}
export interface DebateRound {
  number: number;
  arguments: DebateArgument[];
  monitor?: JudgeMonitorState;
}
export interface JudgeMonitorState {
  claimsChallenged: number;
  totalClaims: number;
  evidenceReferences: number;
  conflicts: number;
  unresolvedClaims: number;
  continueDebate: boolean;
  summary: string;
}
export interface JudgeVerdict {
  verdict: 'undervalued' | 'fairly_valued' | 'overvalued' | 'insufficient_evidence';
  confidence: number | null;
  conviction: string;
  marginOfSafety: string;
  thesis: string;
  bullCase: string[];
  bearCase: string[];
  survivingArguments: Array<{ side: 'bull' | 'bear'; argument: string; survived: boolean }>;
  whyVerdict: string;
  whyNotUndervalued: string;
  whyNotOvervalued: string;
  evidenceIds: string[];
  score: number;
  stance: string;
}
export interface JudgeRun {
  id: string;
  kind: 'run';
  sequence: number;
  subject: string;
  companyName?: string;
  command: 'judge' | 'research';
  state: RunState;
  phase: 'research' | 'bull' | 'bear' | 'debate' | 'judge' | 'complete';
  research: ResearchRun;
  positions: AgentPosition[];
  debate: DebateRound[];
  finalVerdict?: JudgeVerdict;
  summaryForConversation?: string;
  error?: string;
}
export interface ConversationMessage {
  kind: 'message';
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  state: RunState;
}
export type ConversationBlock = ConversationMessage | JudgeRun;
export interface ConversationSession {
  id: string;
  title: string;
  activeSubject?: string;
  blocks: ConversationBlock[];
  sequence: number;
}
export interface ConversationCorrelation {
  /** New PR B events write version 1; absent means a readable legacy event. */
  schemaVersion?: 1;
  /** Canonical accepted request that caused this event. */
  turnId?: string;
  /** Canonical execution attempt, only when the request actually has one. */
  executionId?: string;
  /** Stable request-level correlation; PR B uses the canonical Turn ID. */
  correlationId?: string;
  /** Immediately preceding journal entry in the same live request, when known. */
  causationId?: string;
}

type ConversationEventPayload =
  | { type: 'message.added'; id: string; role: 'user' | 'assistant'; content: string; state: RunState }
  | { type: 'message.delta'; id: string; content: string }
  | { type: 'message.settled'; id: string; state: Exclude<RunState, 'running'> }
  | { type: 'turn.started'; id: string }
  | { type: 'turn.settled'; id: string; state: Exclude<RunState, 'running'> }
  | { type: 'run.started'; id: string; subject: string; command: 'judge' | 'research' }
  | { type: 'research.task'; id: string; task: ResearchTask; state?: ResearchState; companyName?: string }
  | { type: 'research.evidence'; id: string; evidence: DisplayEvidence }
  | { type: 'research.completed'; id: string; summary: string }
  | { type: 'run.phase'; id: string; phase: JudgeRun['phase'] }
  | { type: 'position.completed'; id: string; position: AgentPosition }
  | { type: 'debate.argument'; id: string; argument: DebateArgument }
  | { type: 'debate.delta'; id: string; argumentId: string; content: string }
  | { type: 'judge.monitor'; id: string; round: number; monitor: JudgeMonitorState }
  | { type: 'judge.verdict'; id: string; verdict: JudgeVerdict; summaryForConversation: string }
  | { type: 'run.settled'; id: string; state: Exclude<RunState, 'running'>; error?: string }
  /**
   * PR D: a committed working-context version. Carries references only — the
   * durable payload lives in the context version store, so the journal never
   * becomes a context store.
   */
  | { type: 'session.context.updated'; id: string; sessionId: string; turnId: string; oldVersion: number; newVersion: number; sourceSequence: number };

/** Immutable journal payload. Lifecycle correlation is optional for legacy replay. */
export type ConversationEvent = ConversationEventPayload & ConversationCorrelation;

export interface ConversationEntry {
  id: string;
  sessionId: string;
  sequence: number;
  createdAt: string;
  payload: ConversationEvent;
}

/** Append-only events update a block at its original sequence; completion time never sorts it. */
export function projectConversation(state: ConversationSession, entry: ConversationEntry): ConversationSession {
  if (entry.sessionId !== state.id || entry.sequence <= state.sequence) return state;
  const event = entry.payload;
  let blocks = state.blocks;
  let activeSubject = state.activeSubject;
  // Working-context audit events describe session state, not transcript blocks.
  if (event.type === 'session.context.updated') return { ...state, sequence: entry.sequence };
  if (event.type === 'message.added') {
    if (!blocks.some(block => block.id === event.id)) blocks = [...blocks, { kind: 'message', ...event, sequence: entry.sequence }];
  } else if (event.type === 'run.started') {
    activeSubject = event.subject;
    if (!blocks.some(block => block.id === event.id)) blocks = [...blocks, {
      kind: 'run', id: event.id, sequence: entry.sequence, subject: event.subject, command: event.command,
      state: 'running', phase: 'research', research: { state: 'starting', tasks: [], evidence: [] }, positions: [], debate: [],
    }];
  } else {
    blocks = blocks.map(block => {
      if (block.id !== event.id) return block;
      if (block.kind === 'message') {
        if (event.type === 'message.delta' && block.state === 'running') return { ...block, content: block.content + event.content };
        if (event.type === 'message.settled') return { ...block, state: event.state };
        return block;
      }
      switch (event.type) {
        case 'research.task': return { ...block, companyName: event.companyName ?? block.companyName,
          research: { ...block.research, state: event.state ?? 'fetching', tasks: block.research.tasks.some(task => task.id === event.task.id)
            ? block.research.tasks.map(task => task.id === event.task.id ? event.task : task) : [...block.research.tasks, event.task] } };
        case 'research.evidence': return { ...block, research: { ...block.research, evidence: block.research.evidence.some(item => item.displayId === event.evidence.displayId)
          ? block.research.evidence : [...block.research.evidence, event.evidence] } };
        case 'research.completed': return { ...block, research: { ...block.research, state: 'complete', summary: event.summary } };
        case 'run.phase': return { ...block, phase: event.phase };
        case 'position.completed': return { ...block, positions: [...block.positions.filter(position => position.side !== event.position.side), event.position]
          .sort((a, b) => a.side === b.side ? 0 : a.side === 'bull' ? -1 : 1) };
        case 'debate.argument': {
          const round = block.debate.find(item => item.number === event.argument.round) ?? { number: event.argument.round, arguments: [] };
          const updated = { ...round, arguments: round.arguments.some(argument => argument.id === event.argument.id)
            ? round.arguments.map(argument => argument.id === event.argument.id ? event.argument : argument) : [...round.arguments, event.argument] };
          return { ...block, phase: 'debate', debate: block.debate.some(item => item.number === round.number)
            ? block.debate.map(item => item.number === round.number ? updated : item) : [...block.debate, updated] };
        }
        case 'debate.delta': return { ...block, debate: block.debate.map(round => ({ ...round, arguments: round.arguments.map(argument => argument.id === event.argumentId
          ? { ...argument, summary: argument.summary + event.content } : argument) })) };
        case 'judge.monitor': return { ...block, debate: block.debate.map(round => round.number === event.round ? { ...round, monitor: event.monitor } : round) };
        case 'judge.verdict': return { ...block, phase: 'complete', finalVerdict: event.verdict, summaryForConversation: event.summaryForConversation };
        case 'run.settled': return { ...block, state: event.state, error: event.error,
          research: { ...block.research, state: block.research.state === 'complete' ? 'complete' : event.state === 'completed' ? 'complete' : event.state,
            tasks: block.research.tasks.map(task => task.state === 'running' ? { ...task, state: event.state === 'failed' ? 'failed' : 'skipped' } : task) },
          debate: block.debate.map(round => ({ ...round, arguments: round.arguments.map(argument => argument.state === 'running' ? { ...argument, state: event.state } : argument) })) };
        default: return block;
      }
    });
  }
  return { ...state, blocks, activeSubject, sequence: entry.sequence };
}
