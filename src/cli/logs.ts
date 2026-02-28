import type { Command } from 'commander';
import { RedisMessageBus } from '../bus/redis-message-bus.js';
import type { Heartbeat } from '../types/heartbeat.js';
import type { Subscription } from '../types/message.js';
import { stateColor, healthColor, colorize, ansi } from './format.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Stream heartbeat logs for an agent')
    .argument('<agent-id>', 'Agent ID to watch')
    .option('--redis-url <url>', 'Redis URL', 'redis://localhost:6379')
    .option('--json', 'Output NDJSON (one JSON object per heartbeat)')
    .action(async (agentId: string, opts: { redisUrl: string; json?: boolean }) => {
      const bus = new RedisMessageBus(opts.redisUrl);
      let sub: Subscription | null = null;

      sub = await bus.subscribeHeartbeats(agentId, async (heartbeat: Heartbeat) => {
        if (opts.json) {
          process.stdout.write(JSON.stringify(heartbeat) + '\n');
          return;
        }

        const ts = new Date(heartbeat.timestamp).toISOString();
        const state = stateColor(heartbeat.execution.state);
        const health = healthColor(heartbeat.health.status);
        const rate = `rate=${heartbeat.execution.tickRate}/s`;

        const tokensLow = heartbeat.resources.tokensRemaining < heartbeat.resources.tokensUsed * 0.1;
        const tokens = tokensLow
          ? colorize(`tokens=${heartbeat.resources.tokensUsed}`, ansi.red)
          : `tokens=${heartbeat.resources.tokensUsed}`;

        const line = `[${ts}] Tick ${heartbeat.tick} | ${state} | ${health} | coherence=${heartbeat.health.coherence.toFixed(2)} | ${tokens} | ${rate} | pending=${heartbeat.execution.pendingEffects}\n`;
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
