import type { Command } from 'commander';
import Database from 'better-sqlite3';
import { SQLiteCheckpointStore } from '../checkpoint/sqlite-checkpoint-store.js';

type AgentIdRow = { agent_id: string };

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List all known agents')
    .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
    .action(async (opts: { dbPath: string }) => {
      // Use raw SQL to get distinct agent IDs (cannot add methods to CheckpointStore interface)
      const db = new Database(opts.dbPath, { readonly: true });
      const rows = db.prepare('SELECT DISTINCT agent_id FROM checkpoints').all() as AgentIdRow[];
      db.close();

      if (rows.length === 0) {
        process.stdout.write('No agents found.\n');
        return;
      }

      const store = new SQLiteCheckpointStore(opts.dbPath);

      const header = `${'AGENT ID'.padEnd(40)} ${'STATE'.padEnd(15)} ${'EPOCH'.padEnd(6)} ${'TICK'.padEnd(6)} TIMESTAMP\n`;
      const divider = `${'-'.repeat(40)} ${'-'.repeat(15)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(24)}\n`;
      process.stdout.write(header);
      process.stdout.write(divider);

      for (const row of rows) {
        const latest = await store.loadLatest(row.agent_id);
        if (latest) {
          const ts = new Date(latest.timestamp).toISOString();
          const line = `${latest.agentId.padEnd(40)} ${latest.metadata.lifecycleState.padEnd(15)} ${String(latest.epoch).padEnd(6)} ${String(latest.tick).padEnd(6)} ${ts}\n`;
          process.stdout.write(line);
        }
      }

      (store as unknown as { close(): void }).close();
    });
}
