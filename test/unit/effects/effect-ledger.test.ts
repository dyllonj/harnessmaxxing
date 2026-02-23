import { describe, it, expect } from 'vitest';
import { EffectLedger } from '@/effects/effect-ledger';

describe('EffectLedger', () => {
  it('register creates effect with correct fields', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register(
      { type: 'tool_call', action: 'search', parameters: { q: 'test' }, idempotencyKey: 'key-1' },
      5,
    );

    const effects = ledger.inspect();
    expect(effects).toHaveLength(1);
    const effect = effects[0];
    expect(effect.id).toBe(id);
    expect(effect.agentId).toBe('agent-1');
    expect(effect.tick).toBe(5);
    expect(effect.type).toBe('tool_call');
    expect(effect.intent.action).toBe('search');
    expect(effect.intent.parameters).toEqual({ q: 'test' });
    expect(effect.intent.idempotencyKey).toBe('key-1');
    expect(effect.status).toBe('registered');
    expect(effect.timestamps.registered).toBeTypeOf('number');
  });

  it('full lifecycle: registered -> executing -> committed', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'tool_call', action: 'run' }, 0);

    ledger.markExecuting(id);
    expect(ledger.inspect()[0].status).toBe('executing');
    expect(ledger.inspect()[0].timestamps.executing).toBeTypeOf('number');

    ledger.commit(id, { output: 'done' });
    expect(ledger.inspect()[0].status).toBe('committed');
    expect(ledger.inspect()[0].result).toEqual({ output: 'done' });
    expect(ledger.inspect()[0].timestamps.committed).toBeTypeOf('number');
  });

  it('full lifecycle: registered -> executing -> failed', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'external_api', action: 'fetch' }, 1);

    ledger.markExecuting(id);
    ledger.fail(id, 'network timeout');

    const effect = ledger.inspect()[0];
    expect(effect.status).toBe('failed');
    expect(effect.error).toBe('network timeout');
    expect(effect.timestamps.failed).toBeTypeOf('number');
  });

  it('failed -> compensated', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'message_send', action: 'notify' }, 2);
    ledger.markExecuting(id);
    ledger.fail(id, 'delivery failed');
    ledger.compensate(id);

    const effect = ledger.inspect()[0];
    expect(effect.status).toBe('compensated');
    expect(effect.timestamps.compensated).toBeTypeOf('number');
  });

  it('rejects invalid transition: registered -> committed', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'tool_call', action: 'x' }, 0);

    expect(() => ledger.commit(id)).toThrow('Invalid transition: registered -> committed');
  });

  it('rejects invalid transition: committed -> registered', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'tool_call', action: 'x' }, 0);
    ledger.markExecuting(id);
    ledger.commit(id);

    // There's no method to go back to registered, but we can test markExecuting from committed
    expect(() => ledger.markExecuting(id)).toThrow('Invalid transition: committed -> executing');
  });

  it('rejects invalid transition: committed -> executing', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'tool_call', action: 'x' }, 0);
    ledger.markExecuting(id);
    ledger.commit(id);

    expect(() => ledger.markExecuting(id)).toThrow('Invalid transition: committed -> executing');
  });

  it('rejects invalid transition: registered -> failed', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'tool_call', action: 'x' }, 0);

    expect(() => ledger.fail(id, 'err')).toThrow('Invalid transition: registered -> failed');
  });

  it('inspect returns all effects in insertion order', () => {
    const ledger = new EffectLedger('agent-1');
    const id1 = ledger.register({ type: 'tool_call', action: 'first' }, 0);
    const id2 = ledger.register({ type: 'message_send', action: 'second' }, 1);
    const id3 = ledger.register({ type: 'external_api', action: 'third' }, 2);

    const effects = ledger.inspect();
    expect(effects).toHaveLength(3);
    expect(effects[0].id).toBe(id1);
    expect(effects[1].id).toBe(id2);
    expect(effects[2].id).toBe(id3);
  });

  it('getPending returns registered and executing effects', () => {
    const ledger = new EffectLedger('agent-1');
    const id1 = ledger.register({ type: 'tool_call', action: 'a' }, 0);
    const id2 = ledger.register({ type: 'tool_call', action: 'b' }, 0);
    const id3 = ledger.register({ type: 'tool_call', action: 'c' }, 0);

    ledger.markExecuting(id2);
    ledger.markExecuting(id3);
    ledger.commit(id3);

    const pending = ledger.getPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].id).toBe(id1); // registered
    expect(pending[1].id).toBe(id2); // executing
  });

  it('getCommitted returns only committed effects', () => {
    const ledger = new EffectLedger('agent-1');
    const id1 = ledger.register({ type: 'tool_call', action: 'a' }, 0);
    const id2 = ledger.register({ type: 'tool_call', action: 'b' }, 0);
    ledger.markExecuting(id1);
    ledger.commit(id1);

    const committed = ledger.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0].id).toBe(id1);
  });

  it('getFailed returns only failed effects', () => {
    const ledger = new EffectLedger('agent-1');
    const id1 = ledger.register({ type: 'tool_call', action: 'a' }, 0);
    const id2 = ledger.register({ type: 'tool_call', action: 'b' }, 0);
    ledger.markExecuting(id1);
    ledger.fail(id1, 'err');
    ledger.markExecuting(id2);
    ledger.commit(id2);

    const failed = ledger.getFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(id1);
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
    const id1 = ledger.register({ type: 'tool_call', action: 'search', parameters: { q: 'x' } }, 0);
    ledger.markExecuting(id1);
    ledger.commit(id1, { found: true });

    const id2 = ledger.register({ type: 'external_api', action: 'fetch' }, 1);
    ledger.markExecuting(id2);
    ledger.fail(id2, 'timeout');

    const json = ledger.serialize();
    const restored = EffectLedger.deserialize(json);

    expect(restored.inspect()).toEqual(ledger.inspect());
    expect(restored.getCommitted()).toHaveLength(1);
    expect(restored.getFailed()).toHaveLength(1);
  });

  it('deserialized ledger continues working', () => {
    const ledger = new EffectLedger('agent-1');
    const id = ledger.register({ type: 'tool_call', action: 'x' }, 0);
    ledger.markExecuting(id);

    const json = ledger.serialize();
    const restored = EffectLedger.deserialize(json);

    // Continue from executing -> committed
    restored.commit(id, 'result');
    expect(restored.inspect()[0].status).toBe('committed');

    // Can register new effects
    const id2 = restored.register({ type: 'message_send', action: 'notify' }, 1);
    expect(restored.inspect()).toHaveLength(2);
    expect(restored.inspect()[1].id).toBe(id2);
  });

  it('generates 100 unique effect IDs', () => {
    const ledger = new EffectLedger('agent-1');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(ledger.register({ type: 'tool_call', action: `action-${i}` }, i));
    }
    expect(ids.size).toBe(100);
  });
});
