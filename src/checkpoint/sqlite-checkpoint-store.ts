import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { CheckpointStore } from './checkpoint-store.js';
import type { Checkpoint, CheckpointMetadata } from '../types/checkpoint.js';
import { computeChecksum, verifyChecksum } from './checksum.js';

type CheckpointRow = {
  id: string;
  agent_id: string;
  epoch: number;
  tick: number;
  timestamp: number;
  llm_state: string;
  external_state: string;
  metadata: string;
  checksum: string;
  previous_checkpoint_id: string | null;
  created_at: number;
};

type MetadataRow = {
  id: string;
  agent_id: string;
  epoch: number;
  tick: number;
  timestamp: number;
  checksum: string;
};

function rowToCheckpoint(row: CheckpointRow): Checkpoint | null {
  try {
    const checkpoint: Checkpoint = {
      id: row.id,
      agentId: row.agent_id,
      epoch: row.epoch,
      tick: row.tick,
      timestamp: row.timestamp,
      llmState: JSON.parse(row.llm_state) as Checkpoint['llmState'],
      externalState: JSON.parse(row.external_state) as Checkpoint['externalState'],
      metadata: JSON.parse(row.metadata) as Checkpoint['metadata'],
      checksum: row.checksum,
      previousCheckpointId: row.previous_checkpoint_id,
    };

    if (!verifyChecksum(checkpoint)) {
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

export class SQLiteCheckpointStore implements CheckpointStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string = 'data/harnessmaxxing.db') {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        llm_state TEXT NOT NULL,
        external_state TEXT NOT NULL,
        metadata TEXT NOT NULL,
        checksum TEXT NOT NULL,
        previous_checkpoint_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(agent_id, epoch, tick)
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_id ON checkpoints(agent_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_epoch ON checkpoints(agent_id, epoch);
    `);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    const { checksum: _, ...rest } = checkpoint;
    const checksum = computeChecksum(rest);
    const checkedCheckpoint: Checkpoint = { ...checkpoint, checksum };

    const insert = this.db.prepare(`
      INSERT INTO checkpoints (id, agent_id, epoch, tick, timestamp, llm_state, external_state, metadata, checksum, previous_checkpoint_id, created_at)
      VALUES (@id, @agent_id, @epoch, @tick, @timestamp, @llm_state, @external_state, @metadata, @checksum, @previous_checkpoint_id, @created_at)
    `);

    const saveTransaction = this.db.transaction(() => {
      insert.run({
        id: checkedCheckpoint.id,
        agent_id: checkedCheckpoint.agentId,
        epoch: checkedCheckpoint.epoch,
        tick: checkedCheckpoint.tick,
        timestamp: checkedCheckpoint.timestamp,
        llm_state: JSON.stringify(checkedCheckpoint.llmState),
        external_state: JSON.stringify(checkedCheckpoint.externalState),
        metadata: JSON.stringify(checkedCheckpoint.metadata),
        checksum,
        previous_checkpoint_id: checkedCheckpoint.previousCheckpointId,
        created_at: checkedCheckpoint.metadata.createdAt,
      });
    });

    saveTransaction();
  }

  async load(agentId: string, epoch?: number): Promise<Checkpoint | null> {
    let row: CheckpointRow | undefined;

    if (epoch !== undefined) {
      row = this.db.prepare(
        'SELECT * FROM checkpoints WHERE agent_id = ? AND epoch = ? ORDER BY tick DESC LIMIT 1',
      ).get(agentId, epoch) as CheckpointRow | undefined;
    } else {
      row = this.db.prepare(
        'SELECT * FROM checkpoints WHERE agent_id = ? ORDER BY tick DESC LIMIT 1',
      ).get(agentId) as CheckpointRow | undefined;
    }

    if (!row) {
      return null;
    }

    return rowToCheckpoint(row);
  }

  async loadLatest(agentId: string): Promise<Checkpoint | null> {
    return this.load(agentId);
  }

  async list(agentId: string): Promise<CheckpointMetadata[]> {
    const rows = this.db.prepare(
      'SELECT id, agent_id, epoch, tick, timestamp, checksum FROM checkpoints WHERE agent_id = ? ORDER BY tick DESC',
    ).all(agentId) as MetadataRow[];

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      epoch: row.epoch,
      tick: row.tick,
      timestamp: row.timestamp,
      checksum: row.checksum,
    }));
  }

  async delete(checkpointId: string): Promise<void> {
    this.db.prepare('DELETE FROM checkpoints WHERE id = ?').run(checkpointId);
  }

  async verify(checkpointId: string): Promise<boolean> {
    const row = this.db.prepare(
      'SELECT * FROM checkpoints WHERE id = ?',
    ).get(checkpointId) as CheckpointRow | undefined;

    if (!row) {
      return false;
    }

    try {
      const checkpoint: Checkpoint = {
        id: row.id,
        agentId: row.agent_id,
        epoch: row.epoch,
        tick: row.tick,
        timestamp: row.timestamp,
        llmState: JSON.parse(row.llm_state) as Checkpoint['llmState'],
        externalState: JSON.parse(row.external_state) as Checkpoint['externalState'],
        metadata: JSON.parse(row.metadata) as Checkpoint['metadata'],
        checksum: row.checksum,
        previousCheckpointId: row.previous_checkpoint_id,
      };

      return verifyChecksum(checkpoint);
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}
