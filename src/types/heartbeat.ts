import type { LifecycleState } from './lifecycle.js';

export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export type SemanticHealth = {
  status: HealthStatus;
  progress: number;
  coherence: number;
  confidence: number;
  stuckTicks: number;
  lastMeaningfulAction: string;
};

export type ResourceConsumption = {
  tokensUsed: number;
  tokensRemaining: number;
  estimatedCostUsd: number;
  wallTimeMs: number;
  apiCalls: number;
  toolInvocations: number;
};

export type ExecutionMetadata = {
  state: LifecycleState;
  currentTask: string | null;
  activeTools: string[];
  pendingEffects: number;
  subAgents: string[];
  contextWindowUsage: number;
  tickDurationMs: number;
  tickRate: number;
  pendingElicitation?: { requestId: string; question: string };
};

export type Heartbeat = {
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;
  health: SemanticHealth;
  resources: ResourceConsumption;
  execution: ExecutionMetadata;
};
