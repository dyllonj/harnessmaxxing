export type LifecycleState =
  | 'UNBORN'
  | 'INITIALIZING'
  | 'RUNNING'
  | 'SLEEPING'
  | 'ERROR'
  | 'CHECKPOINTED'
  | 'RECOVERING'
  | 'DEAD'
  | 'ARCHIVED';

export type Trigger =
  | 'spawn'
  | 'ready'
  | 'init_error'
  | 'sleep'
  | 'error'
  | 'checkpoint'
  | 'kill'
  | 'budget_exhausted'
  | 'wake'
  | 'timer_expired'
  | 'recover'
  | 'abandon'
  | 'max_retries'
  | 'resume'
  | 'restore_failed'
  | 'recovery_success'
  | 'recovery_failed'
  | 'all_strategies_exhausted'
  | 'archive';

export type TransitionEvent = {
  from: LifecycleState;
  to: LifecycleState;
  trigger: Trigger;
  timestamp: number;
};

export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'UNBORN',
  'INITIALIZING',
  'RUNNING',
  'SLEEPING',
  'ERROR',
  'CHECKPOINTED',
  'RECOVERING',
  'DEAD',
  'ARCHIVED',
] as const;

export const ALL_TRIGGERS: readonly Trigger[] = [
  'spawn',
  'ready',
  'init_error',
  'sleep',
  'error',
  'checkpoint',
  'kill',
  'budget_exhausted',
  'wake',
  'timer_expired',
  'recover',
  'abandon',
  'max_retries',
  'resume',
  'restore_failed',
  'recovery_success',
  'recovery_failed',
  'all_strategies_exhausted',
  'archive',
] as const;
