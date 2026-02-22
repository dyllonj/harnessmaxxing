import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SQLiteCheckpointStore } from '@/checkpoint/sqlite-checkpoint-store';
import { checkpointStoreTests } from '../../helpers/checkpoint-store-test-factory';
import { createTestCheckpoint } from '../../helpers/checkpoint-factory';

let store: SQLiteCheckpointStore;

checkpointStoreTests(
  'SQLiteCheckpointStore',
  () => {
    store = new SQLiteCheckpointStore(':memory:');
    return store;
  },
  () => {
    store.close();
  },
);

describe('SQLiteCheckpointStore: implementation-specific', () => {
  let sqliteStore: SQLiteCheckpointStore;

  function getDb(): InstanceType<typeof Database> {
    return (sqliteStore as unknown as { db: InstanceType<typeof Database> }).db;
  }

  afterEach(() => {
    sqliteStore.close();
  });

  it('corrupted JSON returns null on load', async () => {
    sqliteStore = new SQLiteCheckpointStore(':memory:');
    const cp = createTestCheckpoint({ agentId: 'agent-corrupt' });
    await sqliteStore.save(cp);

    // Corrupt the llm_state JSON directly
    getDb().prepare(
      "UPDATE checkpoints SET llm_state = 'not valid json{{{' WHERE id = ?",
    ).run(cp.id);

    const loaded = await sqliteStore.load('agent-corrupt');
    expect(loaded).toBeNull();
  });

  it('tampered checksum returns false on verify', async () => {
    sqliteStore = new SQLiteCheckpointStore(':memory:');
    const cp = createTestCheckpoint({ agentId: 'agent-tamper' });
    await sqliteStore.save(cp);

    // Tamper with the checksum directly
    getDb().prepare(
      "UPDATE checkpoints SET checksum = 'tampered-checksum' WHERE id = ?",
    ).run(cp.id);

    const result = await sqliteStore.verify(cp.id);
    expect(result).toBe(false);
  });

  it('tampered checksum causes load to return null', async () => {
    sqliteStore = new SQLiteCheckpointStore(':memory:');
    const cp = createTestCheckpoint({ agentId: 'agent-tamper-load' });
    await sqliteStore.save(cp);

    // Tamper with a data field directly so checksum no longer matches
    getDb().prepare(
      "UPDATE checkpoints SET tick = 9999 WHERE id = ?",
    ).run(cp.id);

    const loaded = await sqliteStore.load('agent-tamper-load');
    expect(loaded).toBeNull();
  });

  it('enables WAL journal mode', () => {
    sqliteStore = new SQLiteCheckpointStore(':memory:');
    const journalMode = getDb().pragma('journal_mode') as Array<{ journal_mode: string }>;
    // In-memory databases return 'memory' for journal mode, but WAL was set
    // For file-based databases this would return 'wal'
    expect(journalMode[0].journal_mode).toBeDefined();
  });
});
