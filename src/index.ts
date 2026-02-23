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
} from './types/budget.js';

export { checkBudget } from './types/budget.js';

export type {
  ChatMessage,
  Task,
  Effect,
  Checkpoint,
  CheckpointMetadata,
} from './types/checkpoint.js';

export type { CheckpointStore } from './checkpoint/index.js';
export { SQLiteCheckpointStore } from './checkpoint/index.js';
export { computeChecksum, verifyChecksum } from './checkpoint/index.js';

export { buildHeartbeat } from './heartbeat/index.js';

export { Agent } from './agent/index.js';
export { Watchdog } from './agent/index.js';
export { createTickLoop } from './agent/index.js';

export type {
  TickContext,
  InboxMessage,
  InboxDrain,
  EffectLedger,
  TickLoopConfig,
  TickLoopDeps,
  AgentLike,
  TickLoop,
  WatchdogConfig,
  WatchdogSignal,
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
