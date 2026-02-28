import { v7 as uuidv7 } from 'uuid';
import type { Checkpoint } from '@/types/checkpoint';
import { computeChecksum } from '@/checkpoint/checksum';

export function createTestCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  const base: Omit<Checkpoint, 'checksum'> = {
    id: uuidv7(),
    agentId: 'test-agent-001',
    epoch: 1,
    tick: 1,
    timestamp: Date.now(),

    llmState: {
      systemPrompt: 'You are a test agent.',
      conversationHistory: [
        { role: 'system', content: 'You are a test agent.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      contextWindowUsage: 0.15,
      modelId: 'test-model-v1',
      temperature: 0.7,
    },

    externalState: {
      taskQueue: [
        {
          id: 'task-001',
          description: 'Test task',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
      completedTasks: [],
      keyValueStore: { testKey: 'testValue' },
      pendingEffects: [],
      committedEffects: [],
    },

    metadata: {
      lifecycleState: 'RUNNING',
      parentAgentId: null,
      childAgentIds: [],
      budget: {
        tokensUsed: 100,
        estimatedCostUsd: 0.01,
        wallTimeMs: 5000,
        toolInvocations: 3,
        apiCalls: 2,
      },
      lastHeartbeat: {
        agentId: 'test-agent-001',
        epoch: 1,
        tick: 1,
        timestamp: Date.now(),
        health: {
          status: 'healthy',
          progress: 0.5,
          coherence: 0.9,
          confidence: 0.85,
          stuckTicks: 0,
          lastMeaningfulAction: 'processed message',
        },
        resources: {
          tokensUsed: 100,
          tokensRemaining: 9900,
          estimatedCostUsd: 0.01,
          wallTimeMs: 5000,
          apiCalls: 2,
          toolInvocations: 1,
        },
        execution: {
          state: 'RUNNING',
          currentTask: 'task-001',
          activeTools: [],
          pendingEffects: 0,
          subAgents: [],
          contextWindowUsage: 0.15,
          tickDurationMs: 250,
          tickRate: 4,
        },
      },
      createdAt: Date.now(),
      restoredFrom: null,
    },

    previousCheckpointId: null,

    ...overrides,
  };

  const checksum = computeChecksum(base);
  return { ...base, checksum };
}
