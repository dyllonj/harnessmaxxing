import type { Command } from 'commander';
import { RedisMessageBus } from '../bus/redis-message-bus.js';
import type { Heartbeat } from '../types/heartbeat.js';
import type { Subscription } from '../types/message.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Stream heartbeat logs for an agent')
    .argument('<agent-id>', 'Agent ID to watch')
    .option('--redis-url <url>', 'Redis URL', 'redis://localhost:6379')
    .action(async (agentId: string, opts: { redisUrl: string }) => {
      const bus = new RedisMessageBus(opts.redisUrl);
      let sub: Subscription | null = null;

      sub = await bus.subscribeHeartbeats(agentId, async (heartbeat: Heartbeat) => {
        const ts = new Date(heartbeat.timestamp).toISOString();
        const line = `[${ts}] Tick ${heartbeat.tick} | ${heartbeat.execution.state} | ${heartbeat.health.status} | coherence=${heartbeat.health.coherence.toFixed(2)} | tokens=${heartbeat.resources.tokensUsed} | pending=${heartbeat.execution.pendingEffects}\n`;
        process.stdout.write(line);
      });

      process.stdout.write(`Streaming heartbeats for ${agentId}... (Ctrl+C to stop)\n`);

      const handleExit = () => {
        if (sub) {
          void sub.unsubscribe().then(() => bus.close()).then(() => process.exit(0));
        }
      };
      process.on('SIGINT', handleExit);
      process.on('SIGTERM', handleExit);
    });
}
