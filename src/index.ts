export const VERSION = '0.0.1';

export { LifecycleStateMachine } from './lifecycle/index.js';
export { createHookRegistry } from './lifecycle/index.js';
export { IllegalTransitionError } from './lifecycle/index.js';

export type {
  LifecycleState,
  Trigger,
  TransitionEvent,
  HookName,
  HookHandler,
  BaseHookEvent,
  PreSpawnEvent,
  PostSpawnEvent,
  PreTickEvent,
  PostTickEvent,
  PreSleepEvent,
  PostSleepEvent,
  PreCheckpointEvent,
  PostCheckpointEvent,
  PreRecoverEvent,
  PostRecoverEvent,
  PreKillEvent,
  PostKillEvent,
  PreRestoreEvent,
  PostRestoreEvent,
  HookEvent,
  HookRegistry,
} from './lifecycle/index.js';

export {
  LIFECYCLE_STATES,
  ALL_TRIGGERS,
  ALL_HOOK_NAMES,
} from './lifecycle/index.js';

export type {
  HealthStatus,
  SemanticHealth,
  ResourceConsumption,
  ExecutionMetadata,
  Heartbeat,
} from './types/heartbeat.js';

export type {
  Budget,
  BudgetSnapshot,
  BudgetCheckResult,
  BudgetDimension,
  BudgetLimits,
} from './types/budget.js';

export { checkBudget } from './types/budget.js';

export type {
  EffectStatus,
  EffectType,
  EffectResult,
  Effect,
} from './types/effect.js';

export type {
  LlmMessage,
  Task,
  CheckpointEffect,
  Checkpoint,
  CheckpointMetadata,
} from './types/checkpoint.js';

export type { CheckpointStore } from './checkpoint/index.js';
export { SQLiteCheckpointStore } from './checkpoint/index.js';
export { computeChecksum, verifyChecksum } from './checkpoint/index.js';

export { buildHeartbeat } from './heartbeat/index.js';

export { Agent } from './agent/index.js';
export { createTickLoop } from './agent/index.js';

export type {
  TickContext,
  InboxMessage,
  InboxDrain,
  TickLoopConfig,
  TickLoopDeps,
  AgentLike,
  TickLoop,
} from './agent/index.js';

export type { MessageBus } from './bus/index.js';
export { RedisMessageBus } from './bus/index.js';

export type {
  Message,
  LifecycleCommand,
  Subscription,
  MessageHandler,
  HeartbeatHandler,
} from './types/message.js';

export type {
  RecoveryStrategyType,
  HealthSeverity,
  HealthPolicy,
  HealthPolicyConfig,
  RecoveryConfig,
  ChildSpec,
  SupervisorConfig,
  HealthVerdict,
  RecoveryResult,
} from './types/supervisor.js';

export {
  createDefaultHealthPolicyConfig,
  createDefaultRecoveryConfig,
} from './types/supervisor.js';

export { HealthAssessor } from './supervisor/index.js';
export { RecoveryEngine } from './supervisor/index.js';
export { Supervisor } from './supervisor/index.js';

export { EffectLedger } from './effects/index.js';
export { BudgetEnforcer } from './budget/index.js';

export type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  LlmToolDefinition,
  LlmCompletionRequest,
  LlmTokenUsage,
  LlmCompletionResponse,
  LlmClient,
  LlmClientConfig,
} from './llm/index.js';

export { createTrackedLlm, createAnthropicClient } from './llm/index.js';

// Tools
export type {
  ToolDefinition,
  ToolHandler,
  RegisteredTool,
  ToolRegistry,
  ToolSurface,
  ToolInputSchema,
} from './tools/index.js';

export { createToolRegistry } from './tools/index.js';
export { createTrackedToolSurface } from './tools/index.js';

// Tasks
export type { TaskTracker } from './tasks/index.js';
export { createTaskTracker } from './tasks/index.js';

// Elicitation
export type {
  ElicitationOption,
  ElicitationType,
  ElicitationRequest,
  ElicitationResponse,
  PendingElicitation,
} from './elicitation/index.js';

// Spawning
export type {
  SubAgentRequest,
  SubAgentHandle,
  SubAgentTool,
  SpawnSignal,
  ParentChildTracker,
} from './spawning/index.js';

export { createParentChildTracker } from './spawning/index.js';

// Runtime
export { createRuntime, spawn, send, query, kill } from './runtime.js';
export type { RuntimeHandle, RuntimeConfig, AgentDefinition, AgentToolDefinition, AgentStatus } from './runtime.js';
