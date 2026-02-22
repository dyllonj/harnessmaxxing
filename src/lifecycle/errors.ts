import type { LifecycleState, Trigger } from '../types/lifecycle.js';

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: LifecycleState,
    public readonly trigger: Trigger,
  ) {
    super(`Illegal transition: cannot apply trigger '${trigger}' in state '${from}'`);
    this.name = 'IllegalTransitionError';
  }
}
