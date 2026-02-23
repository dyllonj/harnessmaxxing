import type { Command } from 'commander';
import { SQLiteCheckpointStore } from '../checkpoint/sqlite-checkpoint-store.js';

export function registerInspectCommand(program: Command): void {
  program
    .command('inspect')
    .description('Inspect an agent by ID')
    .argument('<agent-id>', 'Agent ID to inspect')
    .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
    .action(async (agentId: string, opts: { dbPath: string }) => {
      const store = new SQLiteCheckpointStore(opts.dbPath);

      const checkpoints = await store.list(agentId);
      const latest = await store.loadLatest(agentId);

      if (!latest) {
        process.stdout.write(`No checkpoints found for agent: ${agentId}\n`);
        (store as unknown as { close(): void }).close();
        return;
      }

      process.stdout.write(`\nAgent: ${agentId}\n`);
      process.stdout.write(`State: ${latest.metadata.lifecycleState}\n`);
      process.stdout.write(`Epoch: ${latest.epoch}\n`);
      process.stdout.write(`Tick:  ${latest.tick}\n`);
      process.stdout.write(`Checkpoints: ${checkpoints.length}\n`);

      process.stdout.write(`\nBudget Usage:\n`);
      const b = latest.metadata.budget;
      process.stdout.write(`  Tokens:    ${b.tokensUsed}\n`);
      process.stdout.write(`  Cost USD:  $${b.estimatedCostUsd.toFixed(4)}\n`);
      process.stdout.write(`  Wall Time: ${b.wallTimeMs}ms\n`);
      process.stdout.write(`  Invocations: ${b.invocations}\n`);

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
      (store as unknown as { close(): void }).close();
    });
}
