import type { SemanticHealth, ResourceConsumption, ExecutionMetadata, Heartbeat } from '../types/heartbeat.js';

export function buildHeartbeat(
  agentId: string,
  epoch: number,
  tick: number,
  health: SemanticHealth,
  resources: ResourceConsumption,
  execution: ExecutionMetadata,
): Heartbeat {
  if (!agentId) {
    throw new Error('agentId must be non-empty');
  }
  if (epoch < 0) {
    throw new Error('epoch must be >= 0');
  }
  if (tick < 0) {
    throw new Error('tick must be >= 0');
  }
  if (health.progress < 0 || health.progress > 1) {
    throw new Error('progress must be in [0, 1]');
  }
  if (health.coherence < 0 || health.coherence > 1) {
    throw new Error('coherence must be in [0, 1]');
  }
  if (health.confidence < 0 || health.confidence > 1) {
    throw new Error('confidence must be in [0, 1]');
  }
  if (execution.contextWindowUsage < 0 || execution.contextWindowUsage > 1) {
    throw new Error('contextWindowUsage must be in [0, 1]');
  }

  return {
    agentId,
    epoch,
    tick,
    timestamp: Date.now(),
    health: {
      ...health,
      stuckTicks: health.stuckTicks ?? 0,
      lastMeaningfulAction: health.lastMeaningfulAction ?? 'none',
    },
    resources,
    execution: {
      ...execution,
      activeTools: execution.activeTools ?? [],
      subAgents: execution.subAgents ?? [],
    },
  };
}
