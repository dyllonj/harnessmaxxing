import { describe, it, expect, vi } from 'vitest';
import { createTickLoop } from '@/agent/tick-loop';
import type { AgentLike, TickLoopDeps } from '@/agent/tick-loop';
import type { TickContext, InboxDrain, InboxMessage } from '@/agent/tick-context';
import type { Heartbeat, SemanticHealth } from '@/types/heartbeat';
import type { BudgetLimits } from '@/types/budget';
import { LifecycleStateMachine } from '@/lifecycle/state-machine';
import { BudgetEnforcer } from '@/budget/budget-enforcer';
import { EffectLedger } from '@/effects/effect-ledger';

type TestState = Record<string, unknown> & { count: number };

function createMockAgent(overrides?: Partial<AgentLike<TestState>>): AgentLike<TestState> {
  return {
    agentId: 'test-agent',
    epoch: 0,
    tick: 0,
    state: { count: 0 },
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
    ...overrides,
  };
}

function createEmptyInbox(): InboxDrain {
  return {
    drain: () => [],
    peek: () => [],
    count: () => 0,
  };
}

function createInboxWithMessages(messages: InboxMessage[]): InboxDrain {
  let drained = false;
  return {
    drain() {
      if (drained) return [];
      drained = true;
      return messages;
    },
    peek: () => (drained ? [] : messages),
    count: () => (drained ? 0 : messages.length),
  };
}

function createControllableClock(): { delay: (ms: number) => Promise<void> } {
  return {
    delay: () => Promise.resolve(),
  };
}

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function makeDefaultLimits(): BudgetLimits {
  return {
    tokensUsed: 20000,
    estimatedCostUsd: 200,
    wallTimeMs: 1200000,
    toolInvocations: 1000,
    apiCalls: 500,
  };
}

function createDeps(overrides?: Partial<TickLoopDeps<TestState>>): TickLoopDeps<TestState> {
  return {
    stateMachine: new LifecycleStateMachine('RUNNING'),
    agent: createMockAgent(),
    heartbeatSink: vi.fn(async () => {}),
    checkpointSink: vi.fn(async () => {}),
    inboxSource: createEmptyInbox(),
    budgetEnforcer: new BudgetEnforcer(makeDefaultLimits()),
    effectLedger: new EffectLedger('test-agent'),
    clock: createControllableClock(),
    ...overrides,
  };
}

describe('createTickLoop', () => {
  it('executes the 6-step cycle in order', async () => {
    const order: string[] = [];
    const agent = createMockAgent({
      onTick: vi.fn(async () => { order.push('onTick'); }),
      assessHealth: vi.fn(() => {
        order.push('assessHealth');
        return {
          status: 'healthy' as const,
          progress: 0.5,
          coherence: 1,
          confidence: 1,
          stuckTicks: 0,
          lastMeaningfulAction: 'test',
        };
      }),
    });

    const deps = createDeps({
      agent,
      heartbeatSink: vi.fn(async () => { order.push('heartbeat'); }),
    });

    // Stop after first tick
    let tickCount = 0;
    const originalOnTick = agent.onTick;
    agent.onTick = vi.fn(async (ctx: TickContext<TestState>) => {
      await originalOnTick(ctx);
      tickCount++;
      if (tickCount >= 1) {
        loop.stop();
      }
    });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(order).toEqual(['onTick', 'assessHealth', 'heartbeat']);
  });

  it('calls onTick exactly once per tick', async () => {
    const agent = createMockAgent();
    const deps = createDeps({ agent });

    let tickCount = 0;
    agent.onTick = vi.fn(async () => {
      tickCount++;
      if (tickCount >= 3) {
        loop.stop();
      }
    });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(agent.onTick).toHaveBeenCalledTimes(3);
  });

  it('increments tick counter after each tick', async () => {
    const agent = createMockAgent();
    const deps = createDeps({ agent });
    const ticks: number[] = [];

    agent.onTick = vi.fn(async () => {
      ticks.push(agent.tick);
      if (agent.tick >= 2) {
        loop.stop();
      }
    });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(ticks).toEqual([0, 1, 2]);
  });

  it('transitions to ERROR on onTick error and stops', async () => {
    const agent = createMockAgent({
      onTick: vi.fn(async () => { throw new Error('boom'); }),
    });
    const sm = new LifecycleStateMachine('RUNNING');
    const deps = createDeps({ agent, stateMachine: sm });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(sm.state).toBe('ERROR');
    expect(agent.onError).toHaveBeenCalled();
  });

  it('hard budget fires budget_exhausted before onTick', async () => {
    const agent = createMockAgent();
    const sm = new LifecycleStateMachine('RUNNING');
    const enforcer = new BudgetEnforcer(makeDefaultLimits());
    enforcer.record({ tokensUsed: 20000 });
    const deps = createDeps({
      agent,
      stateMachine: sm,
      budgetEnforcer: enforcer,
    });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(sm.state).toBe('DEAD');
    expect(agent.onTick).not.toHaveBeenCalled();
  });

  it('soft budget triggers forced checkpoint', async () => {
    const agent = createMockAgent();
    const checkpointSink = vi.fn(async () => {});
    const enforcer = new BudgetEnforcer(makeDefaultLimits());
    // 80% of 20000 = 16000, record above that
    enforcer.record({ tokensUsed: 17000 });
    const deps = createDeps({
      agent,
      checkpointSink,
      budgetEnforcer: enforcer,
    });

    agent.onTick = vi.fn(async () => {
      loop.stop();
    });

    const loop = createTickLoop(deps, { checkpointEveryNTicks: 9999 }, createNoopLogger());
    await loop.start();

    expect(checkpointSink).toHaveBeenCalled();
  });

  it('periodic checkpoint fires every N ticks', async () => {
    const agent = createMockAgent();
    const checkpointSink = vi.fn(async () => {});
    const deps = createDeps({ agent, checkpointSink });

    agent.onTick = vi.fn(async () => {
      if (agent.tick >= 5) {
        loop.stop();
      }
    });

    const loop = createTickLoop(deps, { checkpointEveryNTicks: 2 }, createNoopLogger());
    await loop.start();

    // Checkpoint at tick 2 and 4 (after increment: tick 2 → check 2%2=0, tick 4 → check 4%2=0)
    expect(checkpointSink).toHaveBeenCalledTimes(2);
  });

  it('stop() halts the loop', async () => {
    const agent = createMockAgent();
    const deps = createDeps({ agent });

    agent.onTick = vi.fn(async () => {
      loop.stop();
    });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(agent.onTick).toHaveBeenCalledTimes(1);
  });

  it('heartbeat failure counter triggers ERROR on max exceeded', async () => {
    const agent = createMockAgent();
    const sm = new LifecycleStateMachine('RUNNING');
    const deps = createDeps({
      agent,
      stateMachine: sm,
      heartbeatSink: vi.fn(async () => { throw new Error('sink down'); }),
    });

    const loop = createTickLoop(deps, { maxConsecutiveHeartbeatFailures: 3 }, createNoopLogger());
    await loop.start();

    expect(sm.state).toBe('ERROR');
    expect(agent.onTick).toHaveBeenCalledTimes(3);
  });

  it('sleep signal transitions to SLEEPING state', async () => {
    const agent = createMockAgent({
      onTick: vi.fn(async (ctx: TickContext<TestState>) => {
        ctx.sleep(5000);
      }),
    });
    const sm = new LifecycleStateMachine('RUNNING');
    const deps = createDeps({ agent, stateMachine: sm });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(sm.state).toBe('SLEEPING');
  });

  it('kill message transitions to DEAD state and short-circuits', async () => {
    const agent = createMockAgent();
    const sm = new LifecycleStateMachine('RUNNING');
    const inbox = createInboxWithMessages([
      { id: '1', type: 'kill', payload: null, timestamp: Date.now() },
    ]);
    const deps = createDeps({ agent, stateMachine: sm, inboxSource: inbox });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(sm.state).toBe('DEAD');
    expect(agent.onTick).not.toHaveBeenCalled();
  });

  it('loop stops when state is DEAD', async () => {
    const agent = createMockAgent();
    const sm = new LifecycleStateMachine('DEAD');
    const deps = createDeps({ agent, stateMachine: sm });

    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(agent.onTick).not.toHaveBeenCalled();
  });
});
