import type { Command } from 'commander';
import { SQLiteCheckpointStore } from '../checkpoint/sqlite-checkpoint-store.js';
import { stateColor, progressBar, formatDuration, formatCost, colorize, ansi } from './format.js';

export function registerInspectCommand(program: Command): void {
  program
    .command('inspect')
    .description('Inspect an agent by ID')
    .argument('<agent-id>', 'Agent ID to inspect')
    .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
    .option('--json', 'Output raw JSON')
    .action(async (agentId: string, opts: { dbPath: string; json?: boolean }) => {
      const store = new SQLiteCheckpointStore(opts.dbPath);

      const checkpoints = await store.list(agentId);
      const latest = await store.loadLatest(agentId);

      if (!latest) {
        process.stdout.write(`No checkpoints found for agent: ${agentId}\n`);
        store.close();
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(latest, null, 2) + '\n');
        store.close();
        return;
      }

      process.stdout.write(`\nAgent: ${agentId}\n`);
      process.stdout.write(`State: ${stateColor(latest.metadata.lifecycleState)}\n`);
      process.stdout.write(`Epoch: ${latest.epoch}\n`);
      process.stdout.write(`Tick:  ${latest.tick}\n`);
      process.stdout.write(`Checkpoints: ${checkpoints.length}\n`);

      const cwUsage = latest.metadata.lastHeartbeat?.execution?.contextWindowUsage;
      if (cwUsage !== undefined) {
        process.stdout.write(`Context Window: ${(cwUsage * 100).toFixed(0)}% ${progressBar(cwUsage)}\n`);
      }

      process.stdout.write(`\n${colorize('Budget Usage', ansi.bold)}:\n`);
      const b = latest.metadata.budget;
      const totalTokens = b.tokensUsed + (latest.metadata.lastHeartbeat?.resources?.tokensRemaining ?? 0);
      const tokenRatio = totalTokens > 0 ? b.tokensUsed / totalTokens : 0;
      process.stdout.write(`  Tokens:    ${b.tokensUsed.toLocaleString()} ${progressBar(tokenRatio)}\n`);
      process.stdout.write(`  Cost USD:  ${formatCost(b.estimatedCostUsd)}\n`);
      process.stdout.write(`  Wall Time: ${formatDuration(b.wallTimeMs)}\n`);
      process.stdout.write(`  Tool Invocations: ${b.toolInvocations}\n`);
      process.stdout.write(`  API Calls: ${b.apiCalls}\n`);

      process.stdout.write(`\nEffects:\n`);
      process.stdout.write(`  Pending:   ${latest.externalState.pendingEffects.length}\n`);
      process.stdout.write(`  Committed: ${latest.externalState.committedEffects.length}\n`);

      const recent = checkpoints.slice(0, 10);
      if (recent.length > 0) {
        process.stdout.write(`\nRecent Checkpoints:\n`);
        for (const cp of recent) {
          const ts = new Date(cp.timestamp).toISOString();
          process.stdout.write(`  [${ts}] epoch=${cp.epoch} tick=${cp.tick} id=${cp.id.slice(0, 8)}...\n`);
        }
      }

      process.stdout.write('\n');
      store.close();
    });
}
