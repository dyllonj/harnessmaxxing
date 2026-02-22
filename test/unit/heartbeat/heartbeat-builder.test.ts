import { describe, it, expect } from 'vitest';
import { buildHeartbeat } from '@/heartbeat/heartbeat-builder';
import type { SemanticHealth, ResourceConsumption, ExecutionMetadata } from '@/types/heartbeat';

function makeHealth(overrides?: Partial<SemanticHealth>): SemanticHealth {
  return {
    status: 'healthy',
    progress: 0.5,
    coherence: 0.8,
    confidence: 0.9,
    stuckTicks: 0,
    lastMeaningfulAction: 'test',
    ...overrides,
  };
}

function makeResources(overrides?: Partial<ResourceConsumption>): ResourceConsumption {
  return {
    tokensUsed: 100,
    tokensRemaining: 900,
    estimatedCostUsd: 0.01,
    wallTimeMs: 5000,
    apiCalls: 3,
    toolInvocations: 1,
    ...overrides,
  };
}

function makeExecution(overrides?: Partial<ExecutionMetadata>): ExecutionMetadata {
  return {
    state: 'RUNNING',
    currentTask: 'test-task',
    activeTools: ['tool-a'],
    pendingEffects: 0,
    subAgents: ['sub-1'],
    contextWindowUsage: 0.3,
    tickDurationMs: 50,
    tickRate: 10,
    ...overrides,
  };
}

describe('buildHeartbeat', () => {
  it('builds a valid heartbeat with all fields', () => {
    const hb = buildHeartbeat('agent-1', 0, 5, makeHealth(), makeResources(), makeExecution());
    expect(hb.agentId).toBe('agent-1');
    expect(hb.epoch).toBe(0);
    expect(hb.tick).toBe(5);
    expect(hb.health.status).toBe('healthy');
    expect(hb.resources.tokensUsed).toBe(100);
    expect(hb.execution.state).toBe('RUNNING');
  });

  it('sets timestamp automatically', () => {
    const before = Date.now();
    const hb = buildHeartbeat('agent-1', 0, 0, makeHealth(), makeResources(), makeExecution());
    const after = Date.now();
    expect(hb.timestamp).toBeGreaterThanOrEqual(before);
    expect(hb.timestamp).toBeLessThanOrEqual(after);
  });

  describe('validation', () => {
    it('throws on empty agentId', () => {
      expect(() => buildHeartbeat('', 0, 0, makeHealth(), makeResources(), makeExecution()))
        .toThrow('agentId must be non-empty');
    });

    it('throws on negative epoch', () => {
      expect(() => buildHeartbeat('agent-1', -1, 0, makeHealth(), makeResources(), makeExecution()))
        .toThrow('epoch must be >= 0');
    });

    it('throws on negative tick', () => {
      expect(() => buildHeartbeat('agent-1', 0, -1, makeHealth(), makeResources(), makeExecution()))
        .toThrow('tick must be >= 0');
    });

    it('throws when progress is out of range', () => {
      expect(() => buildHeartbeat('agent-1', 0, 0, makeHealth({ progress: 1.5 }), makeResources(), makeExecution()))
        .toThrow('progress must be in [0, 1]');
      expect(() => buildHeartbeat('agent-1', 0, 0, makeHealth({ progress: -0.1 }), makeResources(), makeExecution()))
        .toThrow('progress must be in [0, 1]');
    });

    it('throws when coherence is out of range', () => {
      expect(() => buildHeartbeat('agent-1', 0, 0, makeHealth({ coherence: 2 }), makeResources(), makeExecution()))
        .toThrow('coherence must be in [0, 1]');
    });

    it('throws when confidence is out of range', () => {
      expect(() => buildHeartbeat('agent-1', 0, 0, makeHealth({ confidence: -1 }), makeResources(), makeExecution()))
        .toThrow('confidence must be in [0, 1]');
    });

    it('throws when contextWindowUsage is out of range', () => {
      expect(() => buildHeartbeat('agent-1', 0, 0, makeHealth(), makeResources(), makeExecution({ contextWindowUsage: 1.1 })))
        .toThrow('contextWindowUsage must be in [0, 1]');
    });
  });

  describe('defaults', () => {
    it('fills stuckTicks default to 0', () => {
      const health = makeHealth();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (health as any).stuckTicks;
      const hb = buildHeartbeat('agent-1', 0, 0, health, makeResources(), makeExecution());
      expect(hb.health.stuckTicks).toBe(0);
    });

    it('fills lastMeaningfulAction default to none', () => {
      const health = makeHealth();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (health as any).lastMeaningfulAction;
      const hb = buildHeartbeat('agent-1', 0, 0, health, makeResources(), makeExecution());
      expect(hb.health.lastMeaningfulAction).toBe('none');
    });

    it('fills activeTools default to []', () => {
      const exec = makeExecution();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (exec as any).activeTools;
      const hb = buildHeartbeat('agent-1', 0, 0, makeHealth(), makeResources(), exec);
      expect(hb.execution.activeTools).toEqual([]);
    });

    it('fills subAgents default to []', () => {
      const exec = makeExecution();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (exec as any).subAgents;
      const hb = buildHeartbeat('agent-1', 0, 0, makeHealth(), makeResources(), exec);
      expect(hb.execution.subAgents).toEqual([]);
    });
  });
});
