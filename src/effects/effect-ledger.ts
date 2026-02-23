import { v7 as uuidv7 } from 'uuid';
import type { Effect, EffectStatus, EffectType } from '../types/effect.js';

type EffectIntent = {
  type: EffectType;
  action: string;
  parameters?: Record<string, unknown>;
  idempotencyKey?: string;
};

const VALID_TRANSITIONS: Record<EffectStatus, EffectStatus[]> = {
  registered: ['executing'],
  executing: ['committed', 'failed'],
  committed: [],
  failed: ['compensated'],
  compensated: [],
};

export class EffectLedger {
  private readonly effects: Map<string, Effect> = new Map();
  private readonly effectOrder: string[] = [];
  private readonly agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  register(intent: EffectIntent, tick: number): string {
    const id = uuidv7();
    const effect: Effect = {
      id,
      agentId: this.agentId,
      tick,
      type: intent.type,
      intent: {
        action: intent.action,
        parameters: intent.parameters,
        idempotencyKey: intent.idempotencyKey,
      },
      status: 'registered',
      timestamps: {
        registered: Date.now(),
      },
    };
    this.effects.set(id, effect);
    this.effectOrder.push(id);
    return id;
  }

  markExecuting(effectId: string): void {
    this.transition(effectId, 'executing');
  }

  commit(effectId: string, result?: unknown): void {
    this.transition(effectId, 'committed');
    const effect = this.effects.get(effectId)!;
    if (result !== undefined) {
      effect.result = result;
    }
  }

  fail(effectId: string, error: string): void {
    this.transition(effectId, 'failed');
    const effect = this.effects.get(effectId)!;
    effect.error = error;
  }

  compensate(effectId: string): void {
    this.transition(effectId, 'compensated');
  }

  inspect(): Effect[] {
    return this.effectOrder.map((id) => this.effects.get(id)!);
  }

  getPending(): Effect[] {
    return this.inspect().filter((e) => e.status === 'registered' || e.status === 'executing');
  }

  getCommitted(): Effect[] {
    return this.inspect().filter((e) => e.status === 'committed');
  }

  getFailed(): Effect[] {
    return this.inspect().filter((e) => e.status === 'failed');
  }

  getByTick(tick: number): Effect[] {
    return this.inspect().filter((e) => e.tick === tick);
  }

  serialize(): string {
    return JSON.stringify({
      agentId: this.agentId,
      effects: this.inspect(),
      version: 1,
    });
  }

  static deserialize(json: string): EffectLedger {
    const data = JSON.parse(json) as {
      agentId: string;
      effects: Effect[];
      version: number;
    };
    const ledger = new EffectLedger(data.agentId);
    for (const effect of data.effects) {
      ledger.effects.set(effect.id, effect);
      ledger.effectOrder.push(effect.id);
    }
    return ledger;
  }

  private transition(effectId: string, to: EffectStatus): void {
    const effect = this.effects.get(effectId);
    if (!effect) {
      throw new Error(`Effect not found: ${effectId}`);
    }
    const from = effect.status;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid transition: ${from} -> ${to}`);
    }
    effect.status = to;
    effect.timestamps[to] = Date.now();
  }
}
