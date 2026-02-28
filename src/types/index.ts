export type {
  LifecycleState,
  Trigger,
  TransitionEvent,
} from './lifecycle.js';

export {
  LIFECYCLE_STATES,
  ALL_TRIGGERS,
} from './lifecycle.js';

export type {
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
} from './hooks.js';

export {
  ALL_HOOK_NAMES,
} from './hooks.js';

export type {
  HealthStatus,
  SemanticHealth,
  ResourceConsumption,
  ExecutionMetadata,
  Heartbeat,
} from './heartbeat.js';

export type {
  Budget,
  BudgetSnapshot,
  BudgetCheckResult,
  BudgetDimension,
  BudgetLimits,
} from './budget.js';

export { checkBudget } from './budget.js';

export type {
  EffectStatus,
  EffectType,
  EffectResult,
  Effect,
} from './effect.js';

export type {
  LlmMessage,
  Task,
  CheckpointEffect,
  Checkpoint,
  CheckpointMetadata,
} from './checkpoint.js';

export type {
  Message,
  LifecycleCommand,
  Subscription,
  MessageHandler,
  HeartbeatHandler,
} from './message.js';

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
} from './supervisor.js';

export {
  createDefaultHealthPolicyConfig,
  createDefaultRecoveryConfig,
} from './supervisor.js';
