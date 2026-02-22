import type { LifecycleState, Trigger, TransitionEvent } from '../types/lifecycle.js';
import { IllegalTransitionError } from './errors.js';

export const TRANSITION_TABLE: Record<LifecycleState, Partial<Record<Trigger, LifecycleState>>> = {
  UNBORN: {
    spawn: 'INITIALIZING',
  },
  INITIALIZING: {
    ready: 'RUNNING',
    init_error: 'ERROR',
  },
  RUNNING: {
    sleep: 'SLEEPING',
    error: 'ERROR',
    checkpoint: 'CHECKPOINTED',
    kill: 'DEAD',
    budget_exhausted: 'DEAD',
  },
  SLEEPING: {
    wake: 'RUNNING',
    timer_expired: 'RUNNING',
    kill: 'DEAD',
  },
  ERROR: {
    recover: 'RECOVERING',
    abandon: 'DEAD',
    max_retries: 'DEAD',
  },
  CHECKPOINTED: {
    resume: 'RUNNING',
    restore_failed: 'RECOVERING',
  },
  RECOVERING: {
    recovery_success: 'RUNNING',
    recovery_failed: 'ERROR',
    all_strategies_exhausted: 'DEAD',
  },
  DEAD: {
    archive: 'ARCHIVED',
  },
  ARCHIVED: {},
};

export class LifecycleStateMachine {
  private _state: LifecycleState;

  constructor(initialState: LifecycleState = 'UNBORN') {
    this._state = initialState;
  }

  get state(): LifecycleState {
    return this._state;
  }

  canApply(trigger: Trigger): boolean {
    return TRANSITION_TABLE[this._state][trigger] !== undefined;
  }

  apply(trigger: Trigger): TransitionEvent {
    const to = TRANSITION_TABLE[this._state][trigger];
    if (to === undefined) {
      throw new IllegalTransitionError(this._state, trigger);
    }
    const from = this._state;
    this._state = to;
    return { from, to, trigger, timestamp: Date.now() };
  }
}
