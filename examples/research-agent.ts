import type { AgentDefinition } from '../src/runtime.js';

const researchAgent: AgentDefinition = {
  name: 'research-agent',
  handler: async (ctx) => {
    // Check inbox for messages
    const messages = ctx.inbox.drain();
    for (const msg of messages) {
      if (msg.type === 'user_message') {
        (ctx.state as Record<string, unknown>)['lastMessage'] = msg.payload;
      }
    }

    // Register a research effect
    const effectId = ctx.effects.register(
      {
        type: 'tool_call',
        action: 'research_query',
        parameters: { query: `research-tick-${ctx.tick}` },
        idempotencyKey: `research-${ctx.epoch}-${ctx.tick}`,
      },
      ctx.tick,
    );

    // Simulate work
    ctx.effects.markExecuting(effectId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctx.effects.commit(effectId, { findings: `Result for tick ${ctx.tick}` });

    // Record budget usage
    ctx.recordBudget({
      tokensUsed: 100,
      estimatedCostUsd: 0.001,
      apiCalls: 1,
      invocations: 1,
    });

    // Track progress in state
    const count = ((ctx.state as Record<string, unknown>)['tickCount'] as number) ?? 0;
    (ctx.state as Record<string, unknown>)['tickCount'] = count + 1;
  },
  config: {
    budget: {
      tokensUsed: 100_000,
      estimatedCostUsd: 10,
      wallTimeMs: 600_000,
      invocations: 1000,
      apiCalls: 500,
    },
    tickIntervalMs: 1000,
    checkpointEveryNTicks: 5,
  },
};

export default researchAgent;
