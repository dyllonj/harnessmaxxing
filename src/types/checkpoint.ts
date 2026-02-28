import type { LifecycleState } from './lifecycle.js';
import type { BudgetSnapshot } from './budget.js';
import type { Heartbeat } from './heartbeat.js';
import type { ContentBlock } from '../llm/types.js';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
};

export type Task = {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  dependsOn: string[];
  assignedTo: string | null;
  priority: number;
  metadata?: Record<string, unknown>;
};

export type CheckpointEffect = {
  id: string;
  tick: number;
  type: string;
  action: string;
  description: string;
  status: 'pending' | 'committed' | 'failed';
  timestamp: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  error?: string;
};

export type Checkpoint = {
  id: string;
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;

  llmState: {
    systemPrompt: string;
    conversationHistory: LlmMessage[];
    contextWindowUsage: number;
    modelId: string;
    temperature: number;
  };

  externalState: {
    taskQueue: Task[];
    completedTasks: Task[];
    keyValueStore: Record<string, unknown>;
    pendingEffects: CheckpointEffect[];
    committedEffects: CheckpointEffect[];
  };

  metadata: {
    lifecycleState: LifecycleState;
    parentAgentId: string | null;
    childAgentIds: string[];
    budget: BudgetSnapshot;
    lastHeartbeat: Heartbeat;
    createdAt: number;
    restoredFrom: string | null;
  };

  checksum: string;
  previousCheckpointId: string | null;
};

export type CheckpointMetadata = {
  id: string;
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;
  checksum: string;
};
