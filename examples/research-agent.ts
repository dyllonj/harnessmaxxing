import type { AgentDefinition } from '../src/runtime.js';
import { createAnthropicClient } from '../src/llm/anthropic-adapter.js';

const llm = process.env['ANTHROPIC_API_KEY']
  ? createAnthropicClient({
      modelId: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      maxTokens: 1024,
      apiKey: process.env['ANTHROPIC_API_KEY'],
    })
  : undefined;

export const researchAgent: AgentDefinition = {
  name: 'research-agent',
  handler: async (ctx) => {
    // Check inbox for messages
    const messages = ctx.inbox.drain();
    for (const msg of messages) {
      if (msg.type === 'user_message') {
        (ctx.state as Record<string, unknown>)['lastMessage'] = msg.payload;
      }
    }

    if (ctx.llm) {
      // Use real LLM through tracked wrapper (effects + budget auto-recorded)
      const response = await ctx.llm.complete({
        messages: [
          { role: 'user', content: `Research tick ${ctx.tick}: summarize recent findings.` },
        ],
        systemPrompt: 'You are a research assistant. Be concise.',
      });

      (ctx.state as Record<string, unknown>)['lastResponse'] = response.message.content;
    } else {
      // Fallback: manual effect registration for demo/testing without API key
      const effect = ctx.effects.register(
        {
          type: 'tool_call',
          action: 'research_query',
          parameters: { query: `research-tick-${ctx.tick}` },
          idempotencyKey: `research-${ctx.epoch}-${ctx.tick}`,
        },
        ctx.tick,
      );

      ctx.effects.markExecuting(effect.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      ctx.effects.commit(effect.id, { findings: `Result for tick ${ctx.tick}` });

      ctx.recordBudget({
        tokensUsed: 100,
        estimatedCostUsd: 0.001,
        apiCalls: 1,
        toolInvocations: 1,
      });
    }

    // Track progress in state
    const count = ((ctx.state as Record<string, unknown>)['tickCount'] as number) ?? 0;
    (ctx.state as Record<string, unknown>)['tickCount'] = count + 1;
  },
  config: {
    budget: {
      tokensUsed: 100_000,
      estimatedCostUsd: 10,
      wallTimeMs: 600_000,
      toolInvocations: 1000,
      apiCalls: 500,
    },
    tickIntervalMs: 1000,
    checkpointEveryNTicks: 5,
  },
  llm,
  llmConfig: llm ? { modelId: 'claude-sonnet-4-20250514', temperature: 0.7 } : undefined,
};
