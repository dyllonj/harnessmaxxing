export type EffectStatus = 'registered' | 'executing' | 'committed' | 'failed' | 'compensated';

export type EffectType = 'tool_call' | 'message_send' | 'sub_agent_spawn' | 'external_api';

export type EffectResult = {
  success: boolean;
  output: unknown;
  sideEffects: string[];
};

export type Effect = {
  id: string;
  agentId: string;
  tick: number;
  type: EffectType;
  intent: {
    action: string;
    parameters?: Record<string, unknown>;
    idempotencyKey?: string;
    compensatingAction?: string;
  };
  status: EffectStatus;
  result?: EffectResult;
  error?: string;
  timestamps: {
    registered: number;
    executing?: number;
    committed?: number;
    failed?: number;
    compensated?: number;
  };
};
