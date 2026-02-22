import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  LifecycleStateMachine,
  TRANSITION_TABLE,
  LIFECYCLE_STATES,
  ALL_TRIGGERS,
} from '@/lifecycle/index';
import type { LifecycleState, Trigger } from '@/types/lifecycle';

const triggerArb = fc.constantFrom(...ALL_TRIGGERS);
const triggerSeqArb = fc.array(triggerArb, { minLength: 1, maxLength: 100 });

describe('LifecycleStateMachine property tests', () => {
  it('DEAD invariant: only archive leads to ARCHIVED', () => {
    fc.assert(
      fc.property(triggerSeqArb, (triggers) => {
        const sm = new LifecycleStateMachine();
        for (const trigger of triggers) {
          if (sm.canApply(trigger)) {
            sm.apply(trigger);
          }
          if (sm.state === 'DEAD') {
            for (const t of ALL_TRIGGERS) {
              if (t === 'archive') {
                expect(sm.canApply(t)).toBe(true);
              } else {
                expect(sm.canApply(t)).toBe(false);
              }
            }
            return;
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('ARCHIVED invariant: terminal state with no outgoing transitions', () => {
    fc.assert(
      fc.property(triggerSeqArb, (triggers) => {
        const sm = new LifecycleStateMachine();
        for (const trigger of triggers) {
          if (sm.canApply(trigger)) {
            sm.apply(trigger);
          }
          if (sm.state === 'ARCHIVED') {
            for (const t of ALL_TRIGGERS) {
              expect(sm.canApply(t)).toBe(false);
            }
            return;
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('UNBORN invariant: never re-entered after leaving', () => {
    fc.assert(
      fc.property(triggerSeqArb, (triggers) => {
        const sm = new LifecycleStateMachine();
        let leftUnborn = false;
        for (const trigger of triggers) {
          if (sm.canApply(trigger)) {
            const prev = sm.state;
            sm.apply(trigger);
            if (prev === 'UNBORN') {
              leftUnborn = true;
            }
            if (leftUnborn) {
              expect(sm.state).not.toBe('UNBORN');
            }
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('state is always one of the 9 valid LifecycleState values', () => {
    const validStates = new Set<string>(LIFECYCLE_STATES);
    fc.assert(
      fc.property(triggerSeqArb, (triggers) => {
        const sm = new LifecycleStateMachine();
        expect(validStates.has(sm.state)).toBe(true);
        for (const trigger of triggers) {
          if (sm.canApply(trigger)) {
            sm.apply(trigger);
          }
          expect(validStates.has(sm.state)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('reachability: BFS from UNBORN reaches all 9 states', () => {
    const visited = new Set<LifecycleState>();
    const queue: LifecycleState[] = ['UNBORN'];
    visited.add('UNBORN');

    while (queue.length > 0) {
      const current = queue.shift()!;
      const transitions = TRANSITION_TABLE[current];
      for (const trigger of Object.keys(transitions) as Trigger[]) {
        const next = transitions[trigger]!;
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    expect(visited.size).toBe(9);
    for (const state of LIFECYCLE_STATES) {
      expect(visited.has(state)).toBe(true);
    }
  });

  it('determinism: same (state, trigger) pair always produces same result', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LIFECYCLE_STATES),
        triggerArb,
        (state, trigger) => {
          const sm1 = new LifecycleStateMachine(state);
          const sm2 = new LifecycleStateMachine(state);

          const can1 = sm1.canApply(trigger);
          const can2 = sm2.canApply(trigger);
          expect(can1).toBe(can2);

          if (can1) {
            const e1 = sm1.apply(trigger);
            const e2 = sm2.apply(trigger);
            expect(e1.from).toBe(e2.from);
            expect(e1.to).toBe(e2.to);
            expect(e1.trigger).toBe(e2.trigger);
            expect(sm1.state).toBe(sm2.state);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
