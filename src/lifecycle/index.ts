export { LifecycleStateMachine, TRANSITION_TABLE } from './state-machine.js';
export { createHookRegistry } from './hook-registry.js';
export { IllegalTransitionError } from './errors.js';

export type {
  LifecycleState,
  Trigger,
  TransitionEvent,
} from '../types/lifecycle.js';

export {
  LIFECYCLE_STATES,
  ALL_TRIGGERS,
} from '../types/lifecycle.js';

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
} from '../types/hooks.js';

export {
  ALL_HOOK_NAMES,
} from '../types/hooks.js';
