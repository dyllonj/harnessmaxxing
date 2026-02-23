import { matchesGlob } from 'node:path';
import type { MessageBus } from '@/bus/message-bus';
import type { Heartbeat } from '@/types/heartbeat';
import type { Message, Subscription, MessageHandler, HeartbeatHandler } from '@/types/message';

const HEARTBEAT_CHANNEL = 'stream:heartbeats';

export class InMemoryMessageBus implements MessageBus {
  private messages = new Map<string, Message[]>();
  private subscribers = new Map<string, MessageHandler[]>();
  private groups = new Map<string, Set<string>>();
  private acknowledged = new Set<string>();
  private idCounter = 0;

  async publish(channel: string, message: Message): Promise<void> {
    this.idCounter++;
    message.id = `inmem-${this.idCounter}`;
    message.channel = channel;

    if (!this.messages.has(channel)) {
      this.messages.set(channel, []);
    }
    this.messages.get(channel)!.push(JSON.parse(JSON.stringify(message)) as Message);

    const handlers = this.subscribers.get(channel) ?? [];
    await Promise.all(handlers.map((h) => h(JSON.parse(JSON.stringify(message)) as Message)));
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<Subscription> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    const handlers = this.subscribers.get(channel)!;
    handlers.push(handler);

    return {
      unsubscribe: async () => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) {
          handlers.splice(idx, 1);
        }
      },
    };
  }

  async createConsumerGroup(channel: string, group: string): Promise<void> {
    if (!this.groups.has(channel)) {
      this.groups.set(channel, new Set());
    }
    this.groups.get(channel)!.add(group);
  }

  async acknowledge(_channel: string, _group: string, messageId: string): Promise<void> {
    this.acknowledged.add(messageId);
  }

  async publishHeartbeat(agentId: string, heartbeat: Heartbeat): Promise<void> {
    const message: Message = {
      id: '',
      channel: HEARTBEAT_CHANNEL,
      timestamp: Date.now(),
      payload: { agentId, heartbeat },
    };
    await this.publish(HEARTBEAT_CHANNEL, message);
  }

  async subscribeHeartbeats(pattern: string, handler: HeartbeatHandler): Promise<Subscription> {
    return this.subscribe(HEARTBEAT_CHANNEL, async (message) => {
      const agentId = message.payload['agentId'] as string;
      if (pattern === '*' || matchesGlob(agentId, pattern)) {
        await handler(message.payload['heartbeat'] as Heartbeat);
      }
    });
  }

  // Inspection methods for tests

  getMessages(channel: string): Message[] {
    return [...(this.messages.get(channel) ?? [])];
  }

  getAcknowledged(): Set<string> {
    return new Set(this.acknowledged);
  }

  clear(): void {
    this.messages.clear();
    this.subscribers.clear();
    this.groups.clear();
    this.acknowledged.clear();
    this.idCounter = 0;
  }
}
