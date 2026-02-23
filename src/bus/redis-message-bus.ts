import { matchesGlob } from 'node:path';
import { Redis } from 'ioredis';
import pino from 'pino';
import { v4 as uuid } from 'uuid';
import type { Heartbeat } from '../types/heartbeat.js';
import type { Message, Subscription, MessageHandler, HeartbeatHandler } from '../types/message.js';
import type { MessageBus } from './message-bus.js';

const HEARTBEAT_CHANNEL = 'stream:heartbeats';
const MAX_STREAM_LEN = 10000;
const READ_COUNT = 10;
const BLOCK_MS = 5000;

const logger = pino({ name: 'redis-message-bus' });

export class RedisMessageBus implements MessageBus {
  private pub: Redis;
  private sub: Redis;
  private abortControllers: AbortController[] = [];

  constructor(url = 'redis://localhost:6379') {
    this.pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
    this.sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });

    this.pub.on('error', (err: Error) => {
      logger.error({ err }, 'Redis pub client error');
    });
    this.sub.on('error', (err: Error) => {
      logger.error({ err }, 'Redis sub client error');
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.pub.status === 'wait') {
      await this.pub.connect();
    }
    if (this.sub.status === 'wait') {
      await this.sub.connect();
    }
  }

  async publish(channel: string, message: Message): Promise<void> {
    try {
      await this.ensureConnected();
      const id = await this.pub.xadd(
        channel,
        'MAXLEN',
        '~',
        String(MAX_STREAM_LEN),
        '*',
        'data',
        JSON.stringify(message),
      );
      message.id = id as string;
    } catch (err) {
      logger.error({ err, channel }, 'Failed to publish message');
    }
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<Subscription> {
    await this.ensureConnected();
    const group = `group-${uuid()}`;
    const consumer = `consumer-${uuid()}`;

    await this.createConsumerGroup(channel, group);

    const ac = new AbortController();
    this.abortControllers.push(ac);

    const poll = async (): Promise<void> => {
      while (!ac.signal.aborted) {
        try {
          const results = await this.sub.xreadgroup(
            'GROUP',
            group,
            consumer,
            'COUNT',
            String(READ_COUNT),
            'BLOCK',
            String(BLOCK_MS),
            'STREAMS',
            channel,
            '>',
          );

          if (!results) continue;

          const streams = results as [string, [string, string[]][]][];
          for (const [, entries] of streams) {
            for (const [entryId, fields] of entries) {
              const dataIndex = fields.indexOf('data');
              if (dataIndex === -1) continue;
              const raw = fields[dataIndex + 1];
              try {
                const message = JSON.parse(raw) as Message;
                message.id = entryId;
                await handler(message);
                await this.acknowledge(channel, group, entryId);
              } catch (err) {
                logger.error({ err, entryId, channel }, 'Failed to process message');
              }
            }
          }
        } catch (err) {
          if (ac.signal.aborted) break;
          logger.error({ err, channel }, 'Error in subscription loop');
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };

    void poll();

    return {
      unsubscribe: async () => {
        ac.abort();
      },
    };
  }

  async createConsumerGroup(channel: string, group: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.pub.xgroup('CREATE', channel, group, '0', 'MKSTREAM');
    } catch (err) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) {
        return;
      }
      logger.error({ err, channel, group }, 'Failed to create consumer group');
    }
  }

  async acknowledge(channel: string, group: string, messageId: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.pub.xack(channel, group, messageId);
    } catch (err) {
      logger.error({ err, channel, group, messageId }, 'Failed to acknowledge message');
    }
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

  async close(): Promise<void> {
    for (const ac of this.abortControllers) {
      ac.abort();
    }
    this.abortControllers = [];

    try {
      this.pub.disconnect();
    } catch {
      // ignore
    }
    try {
      this.sub.disconnect();
    } catch {
      // ignore
    }
  }
}
