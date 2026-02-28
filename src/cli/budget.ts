import type { Command } from 'commander';
import { SQLiteCheckpointStore } from '../checkpoint/sqlite-checkpoint-store.js';
import { progressBar, formatDuration, formatCost, colorize, ansi } from './format.js';

export function registerBudgetCommand(program: Command): void {
  program
    .command('budget')
    .description('Show budget usage for an agent')
    .argument('<agent-id>', 'Agent ID to inspect')
    .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
    .action(async (agentId: string, opts: { dbPath: string }) => {
      const store = new SQLiteCheckpointStore(opts.dbPath);

      const latest = await store.loadLatest(agentId);

      if (!latest) {
        process.stdout.write(`No checkpoints found for agent: ${agentId}\n`);
        store.close();
        return;
      }

      const b = latest.metadata.budget;
      const totalTokens = b.tokensUsed + (latest.metadata.lastHeartbeat?.resources?.tokensRemaining ?? 0);
      const tokenRatio = totalTokens > 0 ? b.tokensUsed / totalTokens : 0;

      process.stdout.write(`\n${colorize('Budget Usage', ansi.bold)} — ${agentId}\n\n`);

      process.stdout.write(`  Tokens:          ${b.tokensUsed.toLocaleString()} ${progressBar(tokenRatio)}\n`);
      process.stdout.write(`  Cost:            ${formatCost(b.estimatedCostUsd)}\n`);
      process.stdout.write(`  Wall Time:       ${formatDuration(b.wallTimeMs)}\n`);
      process.stdout.write(`  Tool Invocations: ${b.toolInvocations}\n`);
      process.stdout.write(`  API Calls:       ${b.apiCalls}\n`);

      if (latest.tick > 0) {
        process.stdout.write(`\n${colorize('Per-Tick Rates', ansi.bold)}\n\n`);
        process.stdout.write(`  Tokens/tick:     ${(b.tokensUsed / latest.tick).toFixed(1)}\n`);
        process.stdout.write(`  Cost/tick:       ${formatCost(b.estimatedCostUsd / latest.tick)}\n`);
      }

      process.stdout.write('\n');
      store.close();
    });
}
