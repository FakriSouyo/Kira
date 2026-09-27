import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCapabilityPlan, type CapabilityPlan } from '@harness/capability';
import {
  createJudgeExecutionProfile,
  createJudgeWorkflow,
  judgeWorkflowGraphFingerprint,
  type JudgeExecutionProfile,
} from '@harness/command-judge';
import {
  createExecutionProfile,
  createWorkflowNodeOutput,
  type ExecutionProfileStore,
  type JsonValue,
  type ResearchExecution,
  type ResearchSessionArtifacts,
} from '@harness/session-core';
import {
  JudgeExecutionPreparationError,
  prepareJudgeExecution,
  type JudgeCheckpointStores,
  type JudgeExecutionPreparationOptions,
} from '@harness/engine';

const sessionId = 'session-ua17b-preparation';
const turnId = 'turn-ua17b-preparation';
const executionId = 'execution-ua17b-preparation';
const createdAt = '2026-09-27T00:00:00.000Z';
const capabilityPlan = createCapabilityPlan({ list: () => [] }, []);

function execution(overrides: Partial<ResearchExecution> = {}): ResearchExecution {
  return {
    id: executionId,
    sessionId,
    turnId,
    attempt: 1,
    ticker: 'BBCA',
    command: 'judge',
    status: 'interrupted',
    executionTime: null,
    error: 'process stopped',
    createdAt,
    completedAt: null,
    resumeGeneration: 3,
    ...overrides,
  };
}

function profileFor(target: ResearchExecution = execution(), overrides: {
  profile?: Partial<Omit<JudgeExecutionProfile, 'schemaVersion' | 'fingerprint' | 'payload'>>;
  payload?: Partial<JudgeExecutionProfile['payload']>;
} = {}): JudgeExecutionProfile {
  const base = createJudgeExecutionProfile({
    executionId: target.id,
    ticker: target.ticker,
    reasoningMode: 'reasoning',
    conditional: true,
    researchers: { market: true, news: false },
    provider: 'test-provider',
    model: 'test-model',
    capabilityPlan,
    runtimePlan: { runtimeFingerprint: 'runtime-current' },
    createdAt: target.createdAt,
  });
  if (!overrides.profile && !overrides.payload) return base;
  const { schemaVersion: _schemaVersion, fingerprint: _fingerprint, ...input } = base;
  return createExecutionProfile({
    ...input,
    ...overrides.profile,
    payload: { ...base.payload, ...overrides.payload } as JsonValue,
  } as never) as JudgeExecutionProfile;
}

function fixture(options: {
  execution?: ResearchExecution;
  turn?: Partial<ResearchSessionArtifacts['turns'][number]>;
  profile?: JudgeExecutionProfile | null;
  checkpointOutputs?: ReturnType<typeof createWorkflowNodeOutput>[];
} = {}) {
  const events: string[] = [];
  let currentExecution = options.execution ?? execution({ status: 'running', error: null, resumeGeneration: 0 });
  const targetTurn = {
    id: turnId,
    sessionId,
    runId: null,
    input: '/judge BBCA',
    command: 'judge',
    status: 'running' as const,
    startedAt: createdAt,
    completedAt: null,
    ...options.turn,
  };
  const outputs = [...(options.checkpointOutputs ?? [])];
  const sessionStore = {
    createExecution: vi.fn(async (params: { sessionId: string; turnId: string; ticker: string; command: string }) => {
      events.push('execution.create');
      currentExecution = execution({
        id: 'execution-created-fresh',
        sessionId: params.sessionId,
        turnId: params.turnId,
        ticker: params.ticker,
        command: params.command,
        status: 'running',
        error: null,
        resumeGeneration: 0,
      });
      return currentExecution;
    }),
    getSessionArtifacts: vi.fn(async (_requestedSessionId: string) => {
      events.push('session.load');
      return {
        session: {
          id: sessionId,
          title: 'Judge preparation test',
          provider: 'test-provider',
          model: 'test-model',
          reasoningMode: 'usual',
          createdAt,
          updatedAt: createdAt,
        },
        turns: [targetTurn],
        executions: [currentExecution],
        steps: [],
        modelCalls: [],
      } as ResearchSessionArtifacts;
    }),
    acquireInterruptedExecution: vi.fn(async (id: string) => {
      events.push('execution.acquire');
      expect(id).toBe(currentExecution.id);
      currentExecution = {
        ...currentExecution,
        status: 'running',
        error: null,
        resumeGeneration: currentExecution.resumeGeneration + 1,
      };
      return currentExecution;
    }),
  };

  const profiles = new Map<string, JudgeExecutionProfile>();
  if (options.profile) profiles.set(options.profile.executionId, options.profile);
  const executionProfiles = {
    save: vi.fn(async (value: JudgeExecutionProfile) => {
      events.push('profile.save');
      profiles.set(value.executionId, value);
      return value;
    }),
    getByExecutionId: vi.fn(async (id: string) => {
      events.push('profile.load');
      return profiles.get(id) ?? null;
    }),
  } as unknown as ExecutionProfileStore;

  const checkpointStores: JudgeCheckpointStores = {
    workflowNodeOutputs: {
      save: vi.fn(async output => output),
      listNodeOutputsForExecution: vi.fn(async id => {
        events.push('checkpoint.plan');
        return outputs.filter(output => output.executionId === id);
      }),
    },
    financialSnapshots: { getById: vi.fn(async () => null) },
    evidence: { getManyByIdsForRun: vi.fn(async () => []) },
    contextSnapshots: { getById: vi.fn(async () => null) },
  } as unknown as JudgeCheckpointStores;

  const optionsFor = (overrides: Partial<JudgeExecutionPreparationOptions> = {}): JudgeExecutionPreparationOptions => ({
    sessions: sessionStore,
    executionProfiles,
    checkpointStores,
    lifecycle: { sessionId, turnId },
    request: {
      ticker: 'BBCA',
      command: 'judge',
      reasoning: false,
      conditional: false,
      researchers: { market: false, news: true },
    },
    currentRuntime: {
      provider: 'test-provider',
      model: 'test-model',
      capabilityPlan,
      runtimePlan: { runtimeFingerprint: 'runtime-current' },
    },
    ...overrides,
  });

  return { events, sessionStore, executionProfiles, checkpointStores, optionsFor, outputs, profiles };
}

describe('prepareJudgeExecution', () => {
  it('creates one canonical fresh Execution and persists its immutable profile before returning', async () => {
    const f = fixture();
    const prepared = await prepareJudgeExecution(f.optionsFor());

    expect(f.sessionStore.createExecution).toHaveBeenCalledTimes(1);
    expect(f.sessionStore.createExecution).toHaveBeenCalledWith({ sessionId, turnId, ticker: 'BBCA', command: 'judge' });
    expect(f.executionProfiles.save).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['execution.create', 'profile.save']);
    expect(prepared).toMatchObject({
      execution: { id: 'execution-created-fresh', sessionId, turnId, command: 'judge', ticker: 'BBCA' },
      profile: {
        executionId: 'execution-created-fresh',
        workflowId: 'judge',
        command: 'judge',
        ticker: 'BBCA',
        payload: {
          reasoningMode: 'usual',
          conditional: false,
          researchers: { market: false, news: true },
          provider: 'test-provider',
          model: 'test-model',
        },
      },
      reasoning: false,
      conditional: false,
      researchers: { market: false, news: true },
    });
    expect(prepared.resumePlan).toBeUndefined();
  });

  it('preserves the created Execution in a preparation error when profile saving fails', async () => {
    const f = fixture();
    const saveFailure = new Error('profile store unavailable');
    vi.mocked(f.executionProfiles.save).mockRejectedValue(saveFailure);

    const error = await prepareJudgeExecution(f.optionsFor()).catch(cause => cause);
    expect(error).toBeInstanceOf(JudgeExecutionPreparationError);
    expect(error).toMatchObject({ name: 'JudgeExecutionPreparationError', message: 'profile store unavailable', cause: saveFailure });
    expect((error as JudgeExecutionPreparationError).execution.id).toBe('execution-created-fresh');
    expect(f.events).toEqual(['execution.create']);
    expect(f.executionProfiles.save).toHaveBeenCalledTimes(1);
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
  });

  it('preserves the fresh runtime-configuration error instead of classifying it as a resume incompatibility', async () => {
    const f = fixture();
    const error = await prepareJudgeExecution(f.optionsFor({
      currentRuntime: { provider: undefined, model: undefined, capabilityPlan, runtimePlan: undefined },
    })).catch(cause => cause);

    expect(error).toBeInstanceOf(JudgeExecutionPreparationError);
    expect(error.cause).toMatchObject({
      message: 'Canonical judge execution requires runtime configuration for its execution profile',
    });
    expect(error.cause).not.toHaveProperty('code', 'INCOMPATIBLE_CHECKPOINT');
    expect(f.executionProfiles.save).not.toHaveBeenCalled();
    expect(f.events).toEqual(['execution.create']);
  });

  it('keeps the resume-specific missing runtime-configuration compatibility error', async () => {
    const target = execution();
    const f = fixture({ execution: target, profile: profileFor(target) });
    const error = await prepareJudgeExecution(f.optionsFor({
      request: { ...f.optionsFor().request, resumeExecutionId: executionId },
      currentRuntime: { provider: undefined, model: undefined, capabilityPlan, runtimePlan: undefined },
    })).catch(cause => cause);

    expect(error).toMatchObject({
      code: 'INCOMPATIBLE_CHECKPOINT',
      message: 'The active runtime configuration is unavailable for resume validation.',
      suggestion: 'Start a new /judge after checking configuration.',
    });
    expect(f.events).toEqual(['session.load', 'profile.load']);
    expect(f.checkpointStores.workflowNodeOutputs.listNodeOutputsForExecution).not.toHaveBeenCalled();
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
  });

  it.each([
    ['Session', { sessionId: 'other-session' }, {}],
    ['Turn', { turnId: 'other-turn' }, {}],
    ['command', { command: 'research' }, {}],
    ['ticker', { ticker: 'BMRI' }, {}],
  ])('rejects a resume target with mismatched %s identity before acquisition', async (_label, executionOverrides, turnOverrides) => {
    const f = fixture({
      execution: execution(executionOverrides),
      profile: profileFor(execution(executionOverrides)),
      turn: turnOverrides,
    });

    await expect(prepareJudgeExecution(f.optionsFor({
      request: { ...f.optionsFor().request, resumeExecutionId: executionId },
    }))).rejects.toMatchObject({ code: 'RESUME_NOT_FOUND' });
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
  });

  it('rejects a target that is no longer interrupted before profile planning or acquisition', async () => {
    const running = execution({ status: 'running', resumeGeneration: 3 });
    const f = fixture({ execution: running, profile: profileFor(running) });

    await expect(prepareJudgeExecution(f.optionsFor({
      request: { ...f.optionsFor().request, resumeExecutionId: executionId },
    }))).rejects.toMatchObject({ code: 'RESUME_NOT_INTERRUPTED' });
    expect(f.executionProfiles.getByExecutionId).not.toHaveBeenCalled();
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
  });

  it('rejects a missing immutable profile without acquiring the Execution', async () => {
    const target = execution();
    const f = fixture({ execution: target, profile: null });

    await expect(prepareJudgeExecution(f.optionsFor({
      request: { ...f.optionsFor().request, resumeExecutionId: executionId },
    }))).rejects.toMatchObject({ code: 'INCOMPATIBLE_CHECKPOINT' });
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
  });

  it.each([
    ['graph drift', profileFor(execution(), { profile: { graphFingerprint: 'f'.repeat(64) } }), {}],
    ['provider drift', profileFor(), { currentRuntime: { provider: 'other-provider', model: 'test-model', capabilityPlan, runtimePlan: { runtimeFingerprint: 'runtime-current' } } }],
    ['runtime-plan drift', profileFor(), { currentRuntime: { provider: 'test-provider', model: 'test-model', capabilityPlan, runtimePlan: { runtimeFingerprint: 'runtime-other' } } }],
    ['capability-plan drift', profileFor(), { currentRuntime: { provider: 'test-provider', model: 'test-model', capabilityPlan: { ...capabilityPlan, fingerprint: 'different-capability-plan' } as CapabilityPlan, runtimePlan: { runtimeFingerprint: 'runtime-current' } } }],
    ['release-contract drift', profileFor(execution(), { payload: { releaseContractFingerprint: 'f'.repeat(64) } }), {}],
  ])('rejects %s before acquiring the interrupted Execution', async (_label, profile, overrides) => {
    const f = fixture({ profile });

    await expect(prepareJudgeExecution(f.optionsFor({
      ...overrides,
      request: { ...f.optionsFor().request, resumeExecutionId: executionId },
    }))).rejects.toThrow();
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
    expect(f.events).not.toContain('execution.acquire');
  });

  it('rejects a profile returned for the requested Execution when its internal identity differs before planning or acquisition', async () => {
    const target = execution();
    const mismatchedProfile = profileFor(execution({ id: 'other-execution' }));
    const f = fixture({ execution: target });
    vi.mocked(f.executionProfiles.getByExecutionId).mockImplementation(async requestedId => {
      f.events.push('profile.load');
      expect(requestedId).toBe(executionId);
      return mismatchedProfile as never;
    });

    await expect(prepareJudgeExecution(f.optionsFor({
      request: { ...f.optionsFor().request, resumeExecutionId: executionId },
    }))).rejects.toMatchObject({
      code: 'INCOMPATIBLE_CHECKPOINT',
      message: 'The immutable execution profile does not belong to this Judge Execution.',
    });

    expect(f.executionProfiles.getByExecutionId).toHaveBeenCalledWith(executionId);
    expect(f.events).toEqual(['session.load', 'profile.load']);
    expect(f.checkpointStores.workflowNodeOutputs.listNodeOutputsForExecution).not.toHaveBeenCalled();
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
  });

  it('rejects an incompatible checkpoint without changing interruption state or generation', async () => {
    const target = execution();
    const profile = profileFor(target);
    const invalid = createWorkflowNodeOutput({
      executionId: target.id,
      workflowId: 'judge',
      workflowVersion: 2,
      nodeId: 'unknown-node',
      status: 'completed',
      outputKind: 'judge.unknown.v1',
      dependencyFingerprint: 'a'.repeat(64),
      payload: {} as JsonValue,
      completionGeneration: target.resumeGeneration,
      createdAt,
    });
    const f = fixture({ execution: target, profile, checkpointOutputs: [invalid] });

    await expect(prepareJudgeExecution(f.optionsFor({
      request: { ...f.optionsFor().request, resumeExecutionId: executionId },
    }))).rejects.toThrow(/unknown graph node/i);
    expect(f.sessionStore.acquireInterruptedExecution).not.toHaveBeenCalled();
    expect(f.events).not.toContain('execution.acquire');
    const unchanged = await f.sessionStore.getSessionArtifacts(sessionId);
    expect(unchanged.executions[0]).toMatchObject({ id: executionId, status: 'interrupted', resumeGeneration: 3 });
  });

  it('finishes resume planning before acquiring and returns the same Execution with one generation advance', async () => {
    const target = execution();
    const f = fixture({ execution: target, profile: profileFor(target) });
    const currentRequest = f.optionsFor().request;
    const prepared = await prepareJudgeExecution(f.optionsFor({
      request: {
        ...currentRequest,
        reasoning: false,
        conditional: false,
        researchers: { market: false, news: true },
        resumeExecutionId: executionId,
      },
    }));

    expect(f.events.indexOf('checkpoint.plan')).toBeGreaterThanOrEqual(0);
    expect(f.events.indexOf('checkpoint.plan')).toBeLessThan(f.events.indexOf('execution.acquire'));
    expect(f.sessionStore.acquireInterruptedExecution).toHaveBeenCalledTimes(1);
    expect(f.sessionStore.acquireInterruptedExecution).toHaveBeenCalledWith(executionId);
    expect(prepared.execution).toMatchObject({ id: executionId, status: 'running', resumeGeneration: 4 });
    expect(prepared).toMatchObject({
      reasoning: true,
      conditional: true,
      researchers: { market: true, news: false },
      profile: { executionId },
    });
    expect(prepared.resumePlan).toMatchObject({
      reasoning: true,
      conditional: true,
      researchers: { market: true, news: false },
    });
  });

  it('keeps CLI, database implementation, presentation, and filesystem dependencies out of the module', () => {
    const source = readFileSync(new URL('../src/judge/executionPreparation.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/@harness\/database|apps\/cli|HarnessContext|ConversationController|AgentEvent|FinharnessDatabase|node:fs|better-sqlite3/i);
  });
});
