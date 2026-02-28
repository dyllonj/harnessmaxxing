import { describe, it, expect, vi } from 'vitest';
import { createTickLoop } from '@/agent/tick-loop';
import type { TickLoopDeps } from '@/agent/tick-loop';
import type { TickContext, InboxDrain } from '@/agent/tick-context';
import type { SemanticHealth } from '@/types/heartbeat';
import type { BudgetLimits } from '@/types/budget';
import type { ElicitationRequest } from '@/elicitation/elicitation-types';
import { LifecycleStateMachine } from '@/lifecycle/state-machine';
import { BudgetEnforcer } from '@/budget/budget-enforcer';
import { EffectLedger } from '@/effects/effect-ledger';

type TestState = Record<string, unknown> & { asked: boolean };

function makeDefaultLimits(): BudgetLimits {
  return {
    tokensUsed: 20000,
    estimatedCostUsd: 200,
    wallTimeMs: 1200000,
    toolInvocations: 1000,
    apiCalls: 500,
  };
}

function createEmptyInbox(): InboxDrain {
  return {
    drain: () => [],
    peek: () => [],
    count: () => 0,
  };
}

function createDeps(overrides?: Partial<TickLoopDeps<TestState>>): TickLoopDeps<TestState> {
  return {
    stateMachine: new LifecycleStateMachine('RUNNING'),
    agent: {
      agentId: 'test-agent',
      epoch: 0,
      tick: 0,
      state: { asked: false },
      onTick: vi.fn(async () => {}),
      assessHealth: vi.fn((): SemanticHealth => ({
        status: 'healthy',
        progress: 0.5,
        coherence: 1,
        confidence: 1,
        stuckTicks: 0,
        lastMeaningfulAction: 'test',
      })),
      onCheckpoint: vi.fn(async (state: TestState) => state),
      onError: vi.fn(async () => {}),
    },
    heartbeatSink: vi.fn(async () => {}),
    checkpointSink: vi.fn(async () => {}),
    inboxSource: createEmptyInbox(),
    budgetEnforcer: new BudgetEnforcer(makeDefaultLimits()),
    effectLedger: new EffectLedger('test-agent'),
    clock: { delay: () => Promise.resolve() },
    ...overrides,
  };
}

describe('elicitation in tick loop', () => {
  it('askUser triggers sleep transition', async () => {
    const sm = new LifecycleStateMachine('RUNNING');
    const elicitationSink = vi.fn(async () => {});

    const deps = createDeps({
      stateMachine: sm,
      elicitationSink,
      agent: {
        agentId: 'test-agent',
        epoch: 0,
        tick: 0,
        state: { asked: false },
        onTick: vi.fn(async (ctx: TickContext<TestState>) => {
          ctx.askUser!({
            question: 'Which model?',
            type: 'single_select',
            options: [
              { label: 'GPT-4', value: 'gpt-4' },
              { label: 'Claude', value: 'claude' },
            ],
          });
        }),
        assessHealth: vi.fn((): SemanticHealth => ({
          status: 'healthy',
          progress: 0.5,
          coherence: 1,
          confidence: 1,
          stuckTicks: 0,
          lastMeaningfulAction: 'test',
        })),
        onCheckpoint: vi.fn(async (state: TestState) => state),
        onError: vi.fn(async () => {}),
      },
    });

    const loop = createTickLoop(deps);
    await loop.start();

    expect(sm.state).toBe('SLEEPING');
    expect(elicitationSink).toHaveBeenCalledTimes(1);

    const request = elicitationSink.mock.calls[0][0] as ElicitationRequest;
    expect(request.question).toBe('Which model?');
    expect(request.type).toBe('single_select');
    expect(request.id).toBeTruthy();
    expect(request.options).toHaveLength(2);
  });

  it('askUser is not available when no elicitationSink is provided', async () => {
    let hasAskUser = false;
    const deps = createDeps({
      agent: {
        agentId: 'test-agent',
        epoch: 0,
        tick: 0,
        state: { asked: false },
        onTick: vi.fn(async (ctx: TickContext<TestState>) => {
          hasAskUser = ctx.askUser !== undefined;
          loop.stop();
        }),
        assessHealth: vi.fn((): SemanticHealth => ({
          status: 'healthy',
          progress: 0.5,
          coherence: 1,
          confidence: 1,
          stuckTicks: 0,
          lastMeaningfulAction: 'test',
        })),
        onCheckpoint: vi.fn(async (state: TestState) => state),
        onError: vi.fn(async () => {}),
      },
    });

    const loop = createTickLoop(deps);
    await loop.start();

    expect(hasAskUser).toBe(false);
  });

  it('elicitation takes priority over sleep', async () => {
    const sm = new LifecycleStateMachine('RUNNING');
    const elicitationSink = vi.fn(async () => {});

    const deps = createDeps({
      stateMachine: sm,
      elicitationSink,
      agent: {
        agentId: 'test-agent',
        epoch: 0,
        tick: 0,
        state: { asked: false },
        onTick: vi.fn(async (ctx: TickContext<TestState>) => {
          // Both requested in same tick — elicitation should win
          ctx.sleep(5000);
          ctx.askUser!({ question: 'Choose', type: 'confirm' });
        }),
        assessHealth: vi.fn((): SemanticHealth => ({
          status: 'healthy',
          progress: 0.5,
          coherence: 1,
          confidence: 1,
          stuckTicks: 0,
          lastMeaningfulAction: 'test',
        })),
        onCheckpoint: vi.fn(async (state: TestState) => state),
        onError: vi.fn(async () => {}),
      },
    });

    const loop = createTickLoop(deps);
    await loop.start();

    expect(sm.state).toBe('SLEEPING');
    expect(elicitationSink).toHaveBeenCalledTimes(1);
  });
});
