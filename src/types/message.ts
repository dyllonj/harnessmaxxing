import type { Heartbeat } from './heartbeat.js';

export type Message = {
  id: string;
  channel: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

export type LifecycleCommand = {
  type: 'kill' | 'checkpoint' | 'pause' | 'resume' | 'recover' | 'budget_update';
  targetAgentId: string;
  timestamp: number;
  nonce: string;
  payload?: Record<string, unknown>;
};

export type Subscription = {
  unsubscribe(): Promise<void>;
};

export type MessageHandler = (message: Message) => Promise<void>;

export type HeartbeatHandler = (heartbeat: Heartbeat) => Promise<void>;
