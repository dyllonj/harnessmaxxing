export type HookName =
  | 'PRE_SPAWN'
  | 'POST_SPAWN'
  | 'PRE_TICK'
  | 'POST_TICK'
  | 'PRE_SLEEP'
  | 'POST_SLEEP'
  | 'PRE_CHECKPOINT'
  | 'POST_CHECKPOINT'
  | 'PRE_RECOVER'
  | 'POST_RECOVER'
  | 'PRE_KILL'
  | 'POST_KILL'
  | 'PRE_RESTORE'
  | 'POST_RESTORE';

export const ALL_HOOK_NAMES: readonly HookName[] = [
  'PRE_SPAWN',
  'POST_SPAWN',
  'PRE_TICK',
  'POST_TICK',
  'PRE_SLEEP',
  'POST_SLEEP',
  'PRE_CHECKPOINT',
  'POST_CHECKPOINT',
  'PRE_RECOVER',
  'POST_RECOVER',
  'PRE_KILL',
  'POST_KILL',
  'PRE_RESTORE',
  'POST_RESTORE',
] as const;

export type HookHandler<T> = (event: T) => void | Promise<void>;

export type BaseHookEvent = {
  agentId: string;
  timestamp: number;
};

export type PreSpawnEvent = BaseHookEvent & { config: Record<string, unknown> };
export type PostSpawnEvent = BaseHookEvent;
export type PreTickEvent = BaseHookEvent & { tickNumber: number };
export type PostTickEvent = BaseHookEvent & { tickNumber: number; durationMs: number };
export type PreSleepEvent = BaseHookEvent & { reason: string };
export type PostSleepEvent = BaseHookEvent & { sleptMs: number };
export type PreCheckpointEvent = BaseHookEvent;
export type PostCheckpointEvent = BaseHookEvent & { checkpointId: string };
export type PreRecoverEvent = BaseHookEvent & { error: string };
export type PostRecoverEvent = BaseHookEvent & { strategy: string; success: boolean };
export type PreKillEvent = BaseHookEvent & { reason: string };
export type PostKillEvent = BaseHookEvent;
export type PreRestoreEvent = BaseHookEvent & { checkpointId: string };
export type PostRestoreEvent = BaseHookEvent & { checkpointId: string };

export type HookEvent =
  | PreSpawnEvent
  | PostSpawnEvent
  | PreTickEvent
  | PostTickEvent
  | PreSleepEvent
  | PostSleepEvent
  | PreCheckpointEvent
  | PostCheckpointEvent
  | PreRecoverEvent
  | PostRecoverEvent
  | PreKillEvent
  | PostKillEvent
  | PreRestoreEvent
  | PostRestoreEvent;

export type HookRegistry = {
  on(hook: HookName, handler: HookHandler<unknown>): void;
  off(hook: HookName, handler: HookHandler<unknown>): void;
  fire(hook: HookName, event: unknown): Promise<void>;
};
