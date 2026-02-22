import type { Checkpoint, CheckpointMetadata } from '../types/checkpoint.js';

export interface CheckpointStore {
  /** Write a checkpoint atomically. */
  save(checkpoint: Checkpoint): Promise<void>;

  /** Load checkpoint by agent ID, optionally filtered by epoch. */
  load(agentId: string, epoch?: number): Promise<Checkpoint | null>;

  /** Load the most recent checkpoint for an agent (highest tick). */
  loadLatest(agentId: string): Promise<Checkpoint | null>;

  /** List metadata for all checkpoints of an agent, ordered by tick descending. */
  list(agentId: string): Promise<CheckpointMetadata[]>;

  /** Delete a checkpoint by ID. */
  delete(checkpointId: string): Promise<void>;

  /** Verify checkpoint integrity by recomputing and comparing checksum. */
  verify(checkpointId: string): Promise<boolean>;
}
