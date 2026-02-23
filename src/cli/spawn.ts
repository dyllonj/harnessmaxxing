import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createRuntime } from '../runtime.js';
import type { AgentDefinition } from '../runtime.js';

export function registerSpawnCommand(program: Command): void {
  program
    .command('spawn')
    .description('Spawn a new agent from a definition file')
    .argument('<agent-file>', 'Path to agent definition module')
    .option('--redis-url <url>', 'Redis URL', 'redis://localhost:6379')
    .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
    .action(async (agentFile: string, opts: { redisUrl: string; dbPath: string }) => {
      const absPath = resolve(process.cwd(), agentFile);

      const mod = await import(absPath) as { default: AgentDefinition };
      const agentDef = mod.default;

      if (!agentDef || !agentDef.name || !agentDef.handler || !agentDef.config) {
        process.stderr.write('Error: agent file must export a default AgentDefinition\n');
        process.exit(1);
      }

      const runtime = createRuntime({
        redis: { url: opts.redisUrl },
        sqlite: { path: opts.dbPath },
      });

      const agentId = await runtime.spawn(agentDef);
      process.stdout.write(`${agentId}\n`);

      // Keep process alive — tick loop timers keep the event loop running
      const handleShutdown = () => {
        void runtime.shutdown().then(() => process.exit(0));
      };
      process.on('SIGINT', handleShutdown);
      process.on('SIGTERM', handleShutdown);
    });
}
