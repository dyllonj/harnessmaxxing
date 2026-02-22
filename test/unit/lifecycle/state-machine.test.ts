import { describe, it, expect } from 'vitest';
import {
  LifecycleStateMachine,
  TRANSITION_TABLE,
  IllegalTransitionError,
  LIFECYCLE_STATES,
  ALL_TRIGGERS,
} from '@/lifecycle/index';
import type { LifecycleState, Trigger } from '@/types/lifecycle';

describe('LifecycleStateMachine', () => {
  describe('default initial state', () => {
    it('starts in UNBORN when no constructor arg', () => {
      const sm = new LifecycleStateMachine();
      expect(sm.state).toBe('UNBORN');
    });

    it('starts in the provided initial state', () => {
      const sm = new LifecycleStateMachine('RUNNING');
      expect(sm.state).toBe('RUNNING');
    });
  });

  describe('valid transitions', () => {
    const cases: [LifecycleState, Trigger, LifecycleState][] = [
      ['UNBORN', 'spawn', 'INITIALIZING'],
      ['INITIALIZING', 'ready', 'RUNNING'],
      ['INITIALIZING', 'init_error', 'ERROR'],
      ['RUNNING', 'sleep', 'SLEEPING'],
      ['RUNNING', 'error', 'ERROR'],
      ['RUNNING', 'checkpoint', 'CHECKPOINTED'],
      ['RUNNING', 'kill', 'DEAD'],
      ['RUNNING', 'budget_exhausted', 'DEAD'],
      ['SLEEPING', 'wake', 'RUNNING'],
      ['SLEEPING', 'timer_expired', 'RUNNING'],
      ['SLEEPING', 'kill', 'DEAD'],
      ['ERROR', 'recover', 'RECOVERING'],
      ['ERROR', 'abandon', 'DEAD'],
      ['ERROR', 'max_retries', 'DEAD'],
      ['CHECKPOINTED', 'resume', 'RUNNING'],
      ['CHECKPOINTED', 'restore_failed', 'RECOVERING'],
      ['RECOVERING', 'recovery_success', 'RUNNING'],
      ['RECOVERING', 'recovery_failed', 'ERROR'],
      ['RECOVERING', 'all_strategies_exhausted', 'DEAD'],
      ['DEAD', 'archive', 'ARCHIVED'],
    ];

    it.each(cases)(
      '%s + %s -> %s',
      (from, trigger, to) => {
        const sm = new LifecycleStateMachine(from);
        const event = sm.apply(trigger);
        expect(event.from).toBe(from);
        expect(event.to).toBe(to);
        expect(event.trigger).toBe(trigger);
        expect(sm.state).toBe(to);
      },
    );
  });

  describe('TransitionEvent timestamp', () => {
    it('returns a numeric positive timestamp', () => {
      const sm = new LifecycleStateMachine('UNBORN');
      const event = sm.apply('spawn');
      expect(typeof event.timestamp).toBe('number');
      expect(event.timestamp).toBeGreaterThan(0);
    });
  });

  describe('invalid transitions', () => {
    for (const state of LIFECYCLE_STATES) {
      const validTriggers = new Set(Object.keys(TRANSITION_TABLE[state]));

      const invalidTriggers = ALL_TRIGGERS.filter((t) => !validTriggers.has(t));

      for (const trigger of invalidTriggers) {
        it(`${state} + ${trigger} throws IllegalTransitionError`, () => {
          const sm = new LifecycleStateMachine(state);
          expect(() => sm.apply(trigger)).toThrow(IllegalTransitionError);
        });
      }
    }
  });

  describe('IllegalTransitionError details', () => {
    it('contains from, trigger, and descriptive message', () => {
      const sm = new LifecycleStateMachine('UNBORN');
      try {
        sm.apply('kill');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalTransitionError);
        const e = err as IllegalTransitionError;
        expect(e.from).toBe('UNBORN');
        expect(e.trigger).toBe('kill');
        expect(e.message).toContain('kill');
        expect(e.message).toContain('UNBORN');
      }
    });
  });

  describe('canApply', () => {
    it('returns true for valid triggers', () => {
      const sm = new LifecycleStateMachine('RUNNING');
      expect(sm.canApply('sleep')).toBe(true);
      expect(sm.canApply('error')).toBe(true);
      expect(sm.canApply('checkpoint')).toBe(true);
      expect(sm.canApply('kill')).toBe(true);
      expect(sm.canApply('budget_exhausted')).toBe(true);
    });

    it('returns false for invalid triggers', () => {
      const sm = new LifecycleStateMachine('RUNNING');
      expect(sm.canApply('spawn')).toBe(false);
      expect(sm.canApply('ready')).toBe(false);
      expect(sm.canApply('recover')).toBe(false);
    });

    it('does not mutate state', () => {
      const sm = new LifecycleStateMachine('RUNNING');
      sm.canApply('sleep');
      expect(sm.state).toBe('RUNNING');
    });
  });
});
