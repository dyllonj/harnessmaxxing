import type { BudgetLimits } from '../types/budget.js';
import type { LlmClient } from '../llm/types.js';
import type { TickContext } from '../agent/tick-context.js';
import type { ToolDefinition, ToolHandler } from '../tools/tool-types.js';

export type SubAgentTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export type SubAgentRequest = {
  name: string;
  handler: (ctx: TickContext<Record<string, unknown>>) => Promise<void>;
  config: {
    budget: BudgetLimits;
    tickIntervalMs: number;
    checkpointEveryNTicks: number;
  };
  llm?: LlmClient;
  llmConfig?: { modelId: string; temperature: number };
  tools?: SubAgentTool[];
};

export type SubAgentHandle = {
  agentId: string;
  name: string;
  parentAgentId: string;
};

export type SpawnSignal = {
  requests: SubAgentRequest[];
};

export type ParentChildTracker = {
  parentId: string | null;
  childIds: string[];
  addChild(childId: string): void;
  getChildren(): string[];
};

export function createParentChildTracker(parentId: string | null): ParentChildTracker {
  const childIds: string[] = [];

  return {
    parentId,
    childIds,
    addChild(childId: string): void {
      if (!childIds.includes(childId)) {
        childIds.push(childId);
      }
    },
    getChildren(): string[] {
      return [...childIds];
    },
  };
}
