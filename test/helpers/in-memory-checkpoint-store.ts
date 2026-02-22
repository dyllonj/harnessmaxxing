import type { CheckpointStore } from '@/checkpoint/checkpoint-store';
import type { Checkpoint, CheckpointMetadata } from '@/types/checkpoint';
import { computeChecksum, verifyChecksum } from '@/checkpoint/checksum';

export class InMemoryCheckpointStore implements CheckpointStore {
  private store = new Map<string, Checkpoint>();

  async save(checkpoint: Checkpoint): Promise<void> {
    const { checksum: _, ...rest } = checkpoint;
    const checksum = computeChecksum(rest);
    const clone: Checkpoint = JSON.parse(JSON.stringify({ ...checkpoint, checksum })) as Checkpoint;
    this.store.set(clone.id, clone);
  }

  async load(agentId: string, epoch?: number): Promise<Checkpoint | null> {
    const matches = [...this.store.values()]
      .filter((c) => c.agentId === agentId)
      .filter((c) => epoch === undefined || c.epoch === epoch)
      .sort((a, b) => b.tick - a.tick);

    if (matches.length === 0) {
      return null;
    }

    const checkpoint = matches[0];
    if (!verifyChecksum(checkpoint)) {
      return null;
    }

    return JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
  }

  async loadLatest(agentId: string): Promise<Checkpoint | null> {
    return this.load(agentId);
  }

  async list(agentId: string): Promise<CheckpointMetadata[]> {
    return [...this.store.values()]
      .filter((c) => c.agentId === agentId)
      .sort((a, b) => b.tick - a.tick)
      .map((c) => ({
        id: c.id,
        agentId: c.agentId,
        epoch: c.epoch,
        tick: c.tick,
        timestamp: c.timestamp,
        checksum: c.checksum,
      }));
  }

  async delete(checkpointId: string): Promise<void> {
    this.store.delete(checkpointId);
  }

  async verify(checkpointId: string): Promise<boolean> {
    const checkpoint = this.store.get(checkpointId);
    if (!checkpoint) {
      return false;
    }

    return verifyChecksum(checkpoint);
  }

  /** Test helper: corrupt a stored checkpoint's checksum to simulate data corruption. */
  corrupt(checkpointId: string): void {
    const checkpoint = this.store.get(checkpointId);
    if (checkpoint) {
      checkpoint.checksum = 'corrupted-checksum-value';
    }
  }
}
