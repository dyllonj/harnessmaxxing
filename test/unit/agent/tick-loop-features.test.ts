import { describe, it, expect, vi } from 'vitest';
import { createTickLoop } from '@/agent/tick-loop';
import type { TickLoopDeps } from '@/agent/tick-loop';
import type { TickContext, InboxDrain } from '@/agent/tick-context';
import type { SemanticHealth } from '@/types/heartbeat';
import type { BudgetLimits } from '@/types/budget';
import { LifecycleStateMachine } from '@/lifecycle/state-machine';
import { BudgetEnforcer } from '@/budget/budget-enforcer';
import { EffectLedger } from '@/effects/effect-ledger';
import { createToolRegistry } from '@/tools/tool-registry';
import { createTaskTracker } from '@/tasks/task-tracker';

type TestState = Record<string, unknown>;

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

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function makeAgent(onTick: (ctx: TickContext<TestState>) => Promise<void>) {
  return {
    agentId: 'test-agent',
    epoch: 0,
    tick: 0,
    state: {} as TestState,
    onTick: vi.fn(onTick),
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
  };
}

function createDeps(overrides?: Partial<TickLoopDeps<TestState>>): TickLoopDeps<TestState> {
  return {
    stateMachine: new LifecycleStateMachine('RUNNING'),
    agent: makeAgent(async () => {}),
    heartbeatSink: vi.fn(async () => {}),
    checkpointSink: vi.fn(async () => {}),
    inboxSource: createEmptyInbox(),
    budgetEnforcer: new BudgetEnforcer(makeDefaultLimits()),
    effectLedger: new EffectLedger('test-agent'),
    clock: { delay: () => Promise.resolve() },
    ...overrides,
  };
}

describe('TickContext with tools', () => {
  it('exposes tools surface when toolRegistry is provided', async () => {
    let hasTools = false;
    let toolList: string[] = [];

    const registry = createToolRegistry();
    registry.register(
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      async () => ({ results: [] }),
    );

    const agent = makeAgent(async (ctx) => {
      hasTools = ctx.tools !== undefined;
      if (ctx.tools) {
        toolList = ctx.tools.list().map((t) => t.name);
      }
      loop.stop();
    });

    const deps = createDeps({ agent, toolRegistry: registry });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(hasTools).toBe(true);
    expect(toolList).toEqual(['search']);
  });

  it('tool execution is tracked as effect', async () => {
    const registry = createToolRegistry();
    registry.register(
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      async (input) => ({ content: `contents of ${input['path']}` }),
    );

    const ledger = new EffectLedger('test-agent');
    const agent = makeAgent(async (ctx) => {
      if (ctx.tools) {
        await ctx.tools.execute('read_file', { path: '/etc/hosts' });
      }
      loop.stop();
    });

    const deps = createDeps({ agent, toolRegistry: registry, effectLedger: ledger });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    const committed = ledger.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0].type).toBe('tool_call');
    expect(committed[0].intent.action).toBe('read_file');
  });

  it('does not expose tools when no registry provided', async () => {
    let hasTools = false;

    const agent = makeAgent(async (ctx) => {
      hasTools = ctx.tools !== undefined;
      loop.stop();
    });

    const deps = createDeps({ agent });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(hasTools).toBe(false);
  });
});

describe('TickContext with tasks', () => {
  it('exposes task tracker when provided', async () => {
    let hasTasks = false;
    const tracker = createTaskTracker();

    const agent = makeAgent(async (ctx) => {
      hasTasks = ctx.tasks !== undefined;
      if (ctx.tasks) {
        ctx.tasks.add('First task');
      }
      loop.stop();
    });

    const deps = createDeps({ agent, taskTracker: tracker });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(hasTasks).toBe(true);
    expect(tracker.list()).toHaveLength(1);
  });

  it('task tracker persists across ticks', async () => {
    const tracker = createTaskTracker();
    let tickCount = 0;

    const agent = makeAgent(async (ctx) => {
      tickCount++;
      if (tickCount === 1) {
        ctx.tasks!.add('Created in tick 1');
      }
      if (tickCount === 2) {
        ctx.state['taskCount'] = ctx.tasks!.list().length;
        loop.stop();
      }
    });

    const deps = createDeps({ agent, taskTracker: tracker });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(agent.state!['taskCount']).toBe(1);
  });
});

describe('TickContext with sub-agent spawning', () => {
  it('exposes spawnSubAgent when spawnSink is provided', async () => {
    let hasSpawn = false;

    const agent = makeAgent(async (ctx) => {
      hasSpawn = ctx.spawnSubAgent !== undefined;
      loop.stop();
    });

    const spawnSink = vi.fn(async () => 'child-agent-1');
    const deps = createDeps({ agent, spawnSink, childAgentIds: [] });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(hasSpawn).toBe(true);
  });

  it('defers spawn execution to post-tick', async () => {
    const spawnSink = vi.fn(async () => 'child-1');
    const childIds: string[] = [];

    const agent = makeAgent(async (ctx) => {
      ctx.spawnSubAgent!({
        name: 'worker',
        handler: async () => {},
        config: {
          budget: makeDefaultLimits(),
          tickIntervalMs: 100,
          checkpointEveryNTicks: 10,
        },
      });
      // At this point spawn hasn't happened yet
      loop.stop();
    });

    const deps = createDeps({ agent, spawnSink, childAgentIds: childIds });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    // Spawn happens post-tick
    expect(spawnSink).toHaveBeenCalledTimes(1);
    expect(childIds).toContain('child-1');
  });

  it('does not expose spawnSubAgent when no spawnSink', async () => {
    let hasSpawn = false;

    const agent = makeAgent(async (ctx) => {
      hasSpawn = ctx.spawnSubAgent !== undefined;
      loop.stop();
    });

    const deps = createDeps({ agent });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(hasSpawn).toBe(false);
  });

  it('handles spawn failures gracefully (non-fatal)', async () => {
    const spawnSink = vi.fn(async () => { throw new Error('spawn failed'); });

    let tickRan = false;
    const agent = makeAgent(async (ctx) => {
      ctx.spawnSubAgent!({
        name: 'worker',
        handler: async () => {},
        config: {
          budget: makeDefaultLimits(),
          tickIntervalMs: 100,
          checkpointEveryNTicks: 10,
        },
      });
      tickRan = true;
      loop.stop();
    });

    const sm = new LifecycleStateMachine('RUNNING');
    const deps = createDeps({ agent, spawnSink, childAgentIds: [], stateMachine: sm });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(tickRan).toBe(true);
    // Agent should NOT crash from spawn failure
    // (state could be SLEEPING from stop() or still RUNNING depending on timing)
    expect(sm.state).not.toBe('ERROR');
  });
});

describe('heartbeat reports tool and task data', () => {
  it('includes activeTools from registry', async () => {
    const heartbeatSink = vi.fn(async () => {});
    const registry = createToolRegistry();
    registry.register(
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      async () => 'ok',
    );
    registry.register(
      { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
      async () => 'ok',
    );

    const agent = makeAgent(async () => {
      loop.stop();
    });

    const deps = createDeps({ agent, heartbeatSink, toolRegistry: registry });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(heartbeatSink).toHaveBeenCalled();
    const heartbeat = heartbeatSink.mock.calls[0][0];
    expect(heartbeat.execution.activeTools).toEqual(['search', 'read']);
  });

  it('includes currentTask from tracker', async () => {
    const heartbeatSink = vi.fn(async () => {});
    const tracker = createTaskTracker();
    const task = tracker.add('Doing work');
    tracker.start(task.id);

    const agent = makeAgent(async () => {
      loop.stop();
    });

    const deps = createDeps({ agent, heartbeatSink, taskTracker: tracker });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(heartbeatSink).toHaveBeenCalled();
    const heartbeat = heartbeatSink.mock.calls[0][0];
    expect(heartbeat.execution.currentTask).toBe('Doing work');
  });

  it('includes childAgentIds as subAgents', async () => {
    const heartbeatSink = vi.fn(async () => {});
    const childIds = ['child-1', 'child-2'];

    const agent = makeAgent(async () => {
      loop.stop();
    });

    const spawnSink = vi.fn(async () => 'not-used');
    const deps = createDeps({ agent, heartbeatSink, spawnSink, childAgentIds: childIds });
    const loop = createTickLoop(deps, undefined, createNoopLogger());
    await loop.start();

    expect(heartbeatSink).toHaveBeenCalled();
    const heartbeat = heartbeatSink.mock.calls[0][0];
    expect(heartbeat.execution.subAgents).toEqual(['child-1', 'child-2']);
  });
});
