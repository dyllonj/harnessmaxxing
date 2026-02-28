import { describe, it, expect } from 'vitest';
import { EffectLedger } from '@/effects/effect-ledger';

describe('EffectLedger', () => {
  it('register creates effect with correct fields', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register(
      { type: 'tool_call', action: 'search', parameters: { q: 'test' }, idempotencyKey: 'key-1' },
      5,
    );

    const effects = ledger.inspect();
    expect(effects).toHaveLength(1);
    expect(effects[0].id).toBe(effect.id);
    expect(effect.agentId).toBe('agent-1');
    expect(effect.tick).toBe(5);
    expect(effect.type).toBe('tool_call');
    expect(effect.intent.action).toBe('search');
    expect(effect.intent.parameters).toEqual({ q: 'test' });
    expect(effect.intent.idempotencyKey).toBe('key-1');
    expect(effect.status).toBe('registered');
    expect(effect.timestamps.registered).toBeTypeOf('number');
  });

  it('register supports compensatingAction in intent', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register(
      { type: 'tool_call', action: 'create', compensatingAction: 'delete' },
      0,
    );
    expect(effect.intent.compensatingAction).toBe('delete');
  });

  it('full lifecycle: registered -> executing -> committed', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'tool_call', action: 'run' }, 0);

    ledger.markExecuting(effect.id);
    expect(ledger.inspect()[0].status).toBe('executing');
    expect(ledger.inspect()[0].timestamps.executing).toBeTypeOf('number');

    ledger.commit(effect.id, { output: 'done' });
    expect(ledger.inspect()[0].status).toBe('committed');
    expect(ledger.inspect()[0].result).toEqual({ success: true, output: { output: 'done' }, sideEffects: [] });
    expect(ledger.inspect()[0].timestamps.committed).toBeTypeOf('number');
  });

  it('full lifecycle: registered -> executing -> failed', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'external_api', action: 'fetch' }, 1);

    ledger.markExecuting(effect.id);
    ledger.fail(effect.id, 'network timeout');

    const failed = ledger.inspect()[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('network timeout');
    expect(failed.result).toEqual({ success: false, output: 'network timeout', sideEffects: [] });
    expect(failed.timestamps.failed).toBeTypeOf('number');
  });

  it('failed -> compensated', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'message_send', action: 'notify' }, 2);
    ledger.markExecuting(effect.id);
    ledger.fail(effect.id, 'delivery failed');
    ledger.compensate(effect.id);

    const compensated = ledger.inspect()[0];
    expect(compensated.status).toBe('compensated');
    expect(compensated.timestamps.compensated).toBeTypeOf('number');
  });

  it('rejects invalid transition: registered -> committed', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'tool_call', action: 'x' }, 0);

    expect(() => ledger.commit(effect.id)).toThrow('Invalid transition: registered -> committed');
  });

  it('rejects invalid transition: committed -> registered', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'tool_call', action: 'x' }, 0);
    ledger.markExecuting(effect.id);
    ledger.commit(effect.id);

    // There's no method to go back to registered, but we can test markExecuting from committed
    expect(() => ledger.markExecuting(effect.id)).toThrow('Invalid transition: committed -> executing');
  });

  it('rejects invalid transition: committed -> executing', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'tool_call', action: 'x' }, 0);
    ledger.markExecuting(effect.id);
    ledger.commit(effect.id);

    expect(() => ledger.markExecuting(effect.id)).toThrow('Invalid transition: committed -> executing');
  });

  it('rejects invalid transition: registered -> failed', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'tool_call', action: 'x' }, 0);

    expect(() => ledger.fail(effect.id, 'err')).toThrow('Invalid transition: registered -> failed');
  });

  it('inspect returns all effects in insertion order', () => {
    const ledger = new EffectLedger('agent-1');
    const e1 = ledger.register({ type: 'tool_call', action: 'first' }, 0);
    const e2 = ledger.register({ type: 'message_send', action: 'second' }, 1);
    const e3 = ledger.register({ type: 'external_api', action: 'third' }, 2);

    const effects = ledger.inspect();
    expect(effects).toHaveLength(3);
    expect(effects[0].id).toBe(e1.id);
    expect(effects[1].id).toBe(e2.id);
    expect(effects[2].id).toBe(e3.id);
  });

  it('getPending returns registered and executing effects', () => {
    const ledger = new EffectLedger('agent-1');
    const e1 = ledger.register({ type: 'tool_call', action: 'a' }, 0);
    const e2 = ledger.register({ type: 'tool_call', action: 'b' }, 0);
    const e3 = ledger.register({ type: 'tool_call', action: 'c' }, 0);

    ledger.markExecuting(e2.id);
    ledger.markExecuting(e3.id);
    ledger.commit(e3.id);

    const pending = ledger.getPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].id).toBe(e1.id); // registered
    expect(pending[1].id).toBe(e2.id); // executing
  });

  it('getCommitted returns only committed effects', () => {
    const ledger = new EffectLedger('agent-1');
    const e1 = ledger.register({ type: 'tool_call', action: 'a' }, 0);
    const e2 = ledger.register({ type: 'tool_call', action: 'b' }, 0);
    ledger.markExecuting(e1.id);
    ledger.commit(e1.id);

    const committed = ledger.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0].id).toBe(e1.id);
  });

  it('getFailed returns only failed effects', () => {
    const ledger = new EffectLedger('agent-1');
    const e1 = ledger.register({ type: 'tool_call', action: 'a' }, 0);
    const e2 = ledger.register({ type: 'tool_call', action: 'b' }, 0);
    ledger.markExecuting(e1.id);
    ledger.fail(e1.id, 'err');
    ledger.markExecuting(e2.id);
    ledger.commit(e2.id);

    const failed = ledger.getFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(e1.id);
  });

  it('getByTick filters by tick number', () => {
    const ledger = new EffectLedger('agent-1');
    ledger.register({ type: 'tool_call', action: 'a' }, 0);
    ledger.register({ type: 'tool_call', action: 'b' }, 1);
    ledger.register({ type: 'tool_call', action: 'c' }, 1);
    ledger.register({ type: 'tool_call', action: 'd' }, 2);

    expect(ledger.getByTick(0)).toHaveLength(1);
    expect(ledger.getByTick(1)).toHaveLength(2);
    expect(ledger.getByTick(2)).toHaveLength(1);
    expect(ledger.getByTick(99)).toHaveLength(0);
  });

  it('serialization round-trip preserves all data', () => {
    const ledger = new EffectLedger('agent-1');
    const e1 = ledger.register({ type: 'tool_call', action: 'search', parameters: { q: 'x' } }, 0);
    ledger.markExecuting(e1.id);
    ledger.commit(e1.id, { found: true });

    const e2 = ledger.register({ type: 'external_api', action: 'fetch' }, 1);
    ledger.markExecuting(e2.id);
    ledger.fail(e2.id, 'timeout');

    const json = ledger.serialize();
    const restored = EffectLedger.deserialize(json);

    expect(restored.inspect()).toEqual(ledger.inspect());
    expect(restored.getCommitted()).toHaveLength(1);
    expect(restored.getFailed()).toHaveLength(1);
  });

  it('deserialized ledger continues working', () => {
    const ledger = new EffectLedger('agent-1');
    const effect = ledger.register({ type: 'tool_call', action: 'x' }, 0);
    ledger.markExecuting(effect.id);

    const json = ledger.serialize();
    const restored = EffectLedger.deserialize(json);

    // Continue from executing -> committed
    restored.commit(effect.id, 'result');
    expect(restored.inspect()[0].status).toBe('committed');

    // Can register new effects
    const e2 = restored.register({ type: 'message_send', action: 'notify' }, 1);
    expect(restored.inspect()).toHaveLength(2);
    expect(restored.inspect()[1].id).toBe(e2.id);
  });

  it('generates 100 unique effect IDs', () => {
    const ledger = new EffectLedger('agent-1');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const effect = ledger.register({ type: 'tool_call', action: `action-${i}` }, i);
      ids.add(effect.id);
    }
    expect(ids.size).toBe(100);
  });
});
