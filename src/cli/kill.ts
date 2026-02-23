import type { Command } from 'commander';
import { RedisMessageBus } from '../bus/redis-message-bus.js';
import type { Heartbeat } from '../types/heartbeat.js';
import type { Message } from '../types/message.js';

export function registerKillCommand(program: Command): void {
  program
    .command('kill')
    .description('Kill a running agent')
    .argument('<agent-id>', 'Agent ID to kill')
    .option('--redis-url <url>', 'Redis URL', 'redis://localhost:6379')
    .option('--timeout <ms>', 'Timeout in ms', '5000')
    .action(async (agentId: string, opts: { redisUrl: string; timeout: string }) => {
      const bus = new RedisMessageBus(opts.redisUrl);
      const timeoutMs = parseInt(opts.timeout, 10);

      // Subscribe to heartbeats to confirm death
      const deathPromise = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);

        void bus.subscribeHeartbeats(agentId, (heartbeat: Heartbeat) => {
          if (heartbeat.execution.state === 'DEAD') {
            clearTimeout(timer);
            resolve(true);
          }
          return Promise.resolve();
        });
      });

      // Publish kill command
      const channel = `stream:commands:${agentId}`;
      const msg: Message = {
        id: '',
        channel,
        timestamp: Date.now(),
        payload: { type: 'kill' },
      };
      await bus.publish(channel, msg);

      const confirmed = await deathPromise;
      if (confirmed) {
        process.stdout.write(`Agent ${agentId} killed successfully.\n`);
      } else {
        process.stdout.write(`Kill command sent to ${agentId}. Confirmation timed out after ${timeoutMs}ms.\n`);
      }

      await bus.close();
    });
}
