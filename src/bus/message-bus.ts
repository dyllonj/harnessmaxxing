import type { Heartbeat } from '../types/heartbeat.js';
import type { Message, Subscription, MessageHandler, HeartbeatHandler } from '../types/message.js';

export interface MessageBus {
  publish(channel: string, message: Message): Promise<void>;
  subscribe(channel: string, handler: MessageHandler): Promise<Subscription>;
  createConsumerGroup(channel: string, group: string): Promise<void>;
  acknowledge(channel: string, group: string, messageId: string): Promise<void>;
  publishHeartbeat(agentId: string, heartbeat: Heartbeat): Promise<void>;
  subscribeHeartbeats(pattern: string, handler: HeartbeatHandler): Promise<Subscription>;
}
