import { describe, it, expect, afterAll } from 'vitest';
import { createRuntime } from '@/runtime';
import type { RuntimeHandle, AgentDefinition } from '@/runtime';
import type { TickContext } from '@/agent/tick-context';
import type { Heartbeat } from '@/types/heartbeat';
import { InMemoryMessageBus } from '../helpers/in-memory-message-bus';
import { InMemoryCheckpointStore } from '../helpers/in-memory-checkpoint-store';

function waitFor(
  conditionFn: () => boolean,
  timeoutMs = 5000,
  pollMs = 25,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (conditionFn()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}

describe('E2E Integration Test', () => {
  let runtime: RuntimeHandle;
  const bus = new InMemoryMessageBus();
  const store = new InMemoryCheckpointStore();

  afterAll(async () => {
    await runtime.shutdown();
  });

  it('completes the full agent lifecycle', async () => {
    // Collect heartbeats
    const heartbeats: Heartbeat[] = [];
    await bus.subscribeHeartbeats('*', async (hb: Heartbeat) => {
      heartbeats.push(hb);
    });

    runtime = await createRuntime({
      _bus: bus,
      _store: store,
      logger: { level: 'warn' },
    });

    // --- Step 1: Spawn agent ---
    let tickCount = 0;
    const crashAfterTick = 6;

    const testAgentDef: AgentDefinition = {
      name: 'e2e-test',
      handler: async (ctx: TickContext<Record<string, unknown>>) => {
        tickCount++;

        // Register and commit an effect each tick
        const effect = ctx.effects.register(
          {
            type: 'tool_call',
            action: `work-tick-${ctx.tick}`,
            idempotencyKey: `e2e-${ctx.epoch}-${ctx.tick}`,
          },
          ctx.tick,
        );
        ctx.effects.markExecuting(effect.id);
        ctx.effects.commit(effect.id, { done: true });

        // Record budget
        ctx.recordBudget({
          tokensUsed: 50,
          estimatedCostUsd: 0.0005,
          apiCalls: 1,
          toolInvocations: 1,
        });

        // Track in state
        ctx.state['tickCount'] = tickCount;
        ctx.state['lastTick'] = ctx.tick;

        // Crash after N ticks in epoch 0
        if (ctx.epoch === 0 && tickCount > crashAfterTick) {
          throw new Error('Simulated crash for recovery test');
        }
      },
      config: {
        budget: {
          tokensUsed: 50_000,
          estimatedCostUsd: 50,
          wallTimeMs: 600_000,
          toolInvocations: 10_000,
          apiCalls: 5_000,
        },
        tickIntervalMs: 30,
        checkpointEveryNTicks: 3,
      },
    };

    const agentId = await runtime.spawn(testAgentDef);
    expect(agentId).toBeTruthy();
    expect(agentId).toMatch(/^e2e-test-/);

    // Verify initial state
    const initialStatus = await runtime.query(agentId);
    expect(['RUNNING', 'INITIALIZING']).toContain(initialStatus.state);

    // --- Step 2: Observe heartbeats ---
    await waitFor(() => heartbeats.filter((h) => h.agentId === agentId).length >= 3, 5000);

    const agentHeartbeats = heartbeats.filter((h) => h.agentId === agentId);
    expect(agentHeartbeats.length).toBeGreaterThanOrEqual(3);

    // Verify heartbeat structure
    const hb = agentHeartbeats[0];
    expect(hb.agentId).toBe(agentId);
    expect(hb.health).toBeDefined();
    expect(hb.resources).toBeDefined();
    expect(hb.execution).toBeDefined();
    expect(typeof hb.tick).toBe('number');
    expect(typeof hb.timestamp).toBe('number');

    // Verify monotonically increasing ticks
    for (let i = 1; i < Math.min(agentHeartbeats.length, 5); i++) {
      expect(agentHeartbeats[i].tick).toBeGreaterThan(agentHeartbeats[i - 1].tick);
    }

    // --- Step 3: Multi-step work ---
    await waitFor(() => {
      const hbs = heartbeats.filter((h) => h.agentId === agentId);
      return hbs.length >= 5;
    }, 5000);

    // Verify budget consumption increasing
    const laterHeartbeats = heartbeats.filter((h) => h.agentId === agentId);
    const firstHb = laterHeartbeats[0];
    const fifthHb = laterHeartbeats[4];
    expect(fifthHb.resources.tokensUsed).toBeGreaterThan(firstHb.resources.tokensUsed);

    // --- Step 4: Simulate crash ---
    // The handler throws after crashAfterTick ticks. Wait for error state.
    await waitFor(() => {
      const hbs = heartbeats.filter((h) => h.agentId === agentId && h.epoch === 0);
      // Tick loop should have stopped (heartbeats stop)
      return hbs.length >= crashAfterTick;
    }, 5000);

    // --- Step 5: Recover from checkpoint ---
    // The runtime's recovery handler should detect the loop exit and restart.
    // Wait for heartbeats from epoch 1.
    await waitFor(() => {
      const hbs = heartbeats.filter((h) => h.agentId === agentId && h.epoch === 1);
      return hbs.length >= 1;
    }, 8000);

    const epoch1Heartbeats = heartbeats.filter((h) => h.agentId === agentId && h.epoch === 1);
    expect(epoch1Heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(epoch1Heartbeats[0].epoch).toBe(1);

    // Verify tick resumes from checkpoint (not 0)
    // Checkpoint happens every 3 ticks, so if we crashed after tick 6+, last checkpoint was at tick 6
    const firstRecoveredTick = epoch1Heartbeats[0].tick;
    expect(firstRecoveredTick).toBeGreaterThan(0);

    // --- Step 6: Verify continuation ---
    await waitFor(() => {
      const hbs = heartbeats.filter((h) => h.agentId === agentId && h.epoch === 1);
      return hbs.length >= 3;
    }, 5000);

    const continuedHeartbeats = heartbeats.filter((h) => h.agentId === agentId && h.epoch === 1);
    expect(continuedHeartbeats.length).toBeGreaterThanOrEqual(3);

    // Verify tick numbers continue from checkpoint point
    for (let i = 1; i < Math.min(continuedHeartbeats.length, 3); i++) {
      expect(continuedHeartbeats[i].tick).toBeGreaterThan(continuedHeartbeats[i - 1].tick);
    }

    // --- Step 7: Budget exhaustion ---
    const lowBudgetAgent: AgentDefinition = {
      name: 'budget-test',
      handler: async (ctx: TickContext<Record<string, unknown>>) => {
        ctx.recordBudget({
          tokensUsed: 150,
          estimatedCostUsd: 0.001,
          apiCalls: 1,
          toolInvocations: 1,
        });
        ctx.state['ticks'] = ((ctx.state['ticks'] as number) ?? 0) + 1;
      },
      config: {
        budget: {
          tokensUsed: 500,
          estimatedCostUsd: 100,
          wallTimeMs: 600_000,
          toolInvocations: 10_000,
          apiCalls: 5_000,
        },
        tickIntervalMs: 20,
        checkpointEveryNTicks: 100,
      },
    };

    const budgetAgentId = await runtime.spawn(lowBudgetAgent);
    expect(budgetAgentId).toBeTruthy();

    // Wait for the agent to hit budget limit
    // 500 / 150 = ~3.3 ticks before hard limit triggers
    await waitFor(() => {
      const hbs = heartbeats.filter((h) => h.agentId === budgetAgentId);
      // Either the heartbeats stop coming (budget_exhausted -> DEAD) or we see enough
      return hbs.length >= 2;
    }, 5000);

    // Give it a moment to hit the limit
    await new Promise((resolve) => setTimeout(resolve, 300));

    const budgetStatus = await runtime.query(budgetAgentId);
    // Should have reached DEAD (budget_exhausted) or be close to it
    // After ~4 ticks at 150 tokens each, total = 600 > 500 hard limit
    expect(['DEAD', 'ERROR']).toContain(budgetStatus.state);
    expect(budgetStatus.budgetUsage.tokensUsed).toBeGreaterThan(0);
  }, 30_000); // 30s timeout for the full e2e test
});
