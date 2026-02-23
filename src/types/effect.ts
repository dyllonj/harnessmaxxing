export type EffectStatus = 'registered' | 'executing' | 'committed' | 'failed' | 'compensated';

export type EffectType = 'tool_call' | 'message_send' | 'sub_agent_spawn' | 'external_api';

export type Effect = {
  id: string;
  agentId: string;
  tick: number;
  type: EffectType;
  intent: {
    action: string;
    parameters?: Record<string, unknown>;
    idempotencyKey?: string;
  };
  status: EffectStatus;
  result?: unknown;
  error?: string;
  timestamps: {
    registered: number;
    executing?: number;
    committed?: number;
    failed?: number;
    compensated?: number;
  };
};
