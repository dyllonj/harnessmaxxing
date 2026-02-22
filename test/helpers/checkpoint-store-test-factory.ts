import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CheckpointStore } from '@/checkpoint/checkpoint-store';
import { createTestCheckpoint } from './checkpoint-factory';

export function checkpointStoreTests(
  name: string,
  createStore: () => CheckpointStore | Promise<CheckpointStore>,
  cleanup?: () => void | Promise<void>,
): void {
  describe(`CheckpointStore conformance: ${name}`, () => {
    let store: CheckpointStore;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    describe('CRUD roundtrip', () => {
      it('saves and loads a checkpoint with all fields intact', async () => {
        const checkpoint = createTestCheckpoint();
        await store.save(checkpoint);

        const loaded = await store.load(checkpoint.agentId);
        expect(loaded).not.toBeNull();
        expect(loaded!.id).toBe(checkpoint.id);
        expect(loaded!.agentId).toBe(checkpoint.agentId);
        expect(loaded!.epoch).toBe(checkpoint.epoch);
        expect(loaded!.tick).toBe(checkpoint.tick);
        expect(loaded!.timestamp).toBe(checkpoint.timestamp);
        expect(loaded!.llmState).toEqual(checkpoint.llmState);
        expect(loaded!.externalState).toEqual(checkpoint.externalState);
        expect(loaded!.metadata).toEqual(checkpoint.metadata);
        expect(loaded!.previousCheckpointId).toBe(checkpoint.previousCheckpointId);
        expect(loaded!.checksum).toBe(loaded!.checksum);
      });

      it('recomputes checksum on save', async () => {
        const checkpoint = createTestCheckpoint();
        const originalChecksum = checkpoint.checksum;
        checkpoint.checksum = 'stale-checksum';

        await store.save(checkpoint);
        const loaded = await store.load(checkpoint.agentId);

        expect(loaded).not.toBeNull();
        expect(loaded!.checksum).toBe(originalChecksum);
        expect(loaded!.checksum).not.toBe('stale-checksum');
      });
    });

    describe('load with epoch filter', () => {
      it('returns only checkpoints from the specified epoch', async () => {
        const cp1 = createTestCheckpoint({ agentId: 'agent-a', epoch: 1, tick: 1 });
        const cp2 = createTestCheckpoint({ agentId: 'agent-a', epoch: 2, tick: 2 });

        await store.save(cp1);
        await store.save(cp2);

        const loaded = await store.load('agent-a', 1);
        expect(loaded).not.toBeNull();
        expect(loaded!.epoch).toBe(1);
        expect(loaded!.tick).toBe(1);
      });

      it('returns the highest tick within the specified epoch', async () => {
        const cp1 = createTestCheckpoint({ agentId: 'agent-a', epoch: 1, tick: 1 });
        const cp2 = createTestCheckpoint({ agentId: 'agent-a', epoch: 1, tick: 5 });

        await store.save(cp1);
        await store.save(cp2);

        const loaded = await store.load('agent-a', 1);
        expect(loaded).not.toBeNull();
        expect(loaded!.tick).toBe(5);
      });
    });

    describe('loadLatest', () => {
      it('returns the checkpoint with the highest tick', async () => {
        const cp1 = createTestCheckpoint({ agentId: 'agent-b', epoch: 1, tick: 1 });
        const cp2 = createTestCheckpoint({ agentId: 'agent-b', epoch: 1, tick: 10 });
        const cp3 = createTestCheckpoint({ agentId: 'agent-b', epoch: 2, tick: 3 });

        await store.save(cp1);
        await store.save(cp2);
        await store.save(cp3);

        const loaded = await store.loadLatest('agent-b');
        expect(loaded).not.toBeNull();
        expect(loaded!.tick).toBe(10);
      });
    });

    describe('list', () => {
      it('returns metadata ordered by tick descending', async () => {
        const cp1 = createTestCheckpoint({ agentId: 'agent-c', epoch: 1, tick: 1 });
        const cp2 = createTestCheckpoint({ agentId: 'agent-c', epoch: 1, tick: 5 });
        const cp3 = createTestCheckpoint({ agentId: 'agent-c', epoch: 2, tick: 3 });

        await store.save(cp1);
        await store.save(cp2);
        await store.save(cp3);

        const list = await store.list('agent-c');
        expect(list).toHaveLength(3);
        expect(list[0].tick).toBe(5);
        expect(list[1].tick).toBe(3);
        expect(list[2].tick).toBe(1);
      });

      it('returns metadata only (no llmState, externalState, metadata fields)', async () => {
        const cp = createTestCheckpoint({ agentId: 'agent-d' });
        await store.save(cp);

        const list = await store.list('agent-d');
        expect(list).toHaveLength(1);

        const meta = list[0];
        expect(meta).toHaveProperty('id');
        expect(meta).toHaveProperty('agentId');
        expect(meta).toHaveProperty('epoch');
        expect(meta).toHaveProperty('tick');
        expect(meta).toHaveProperty('timestamp');
        expect(meta).toHaveProperty('checksum');
        expect(meta).not.toHaveProperty('llmState');
        expect(meta).not.toHaveProperty('externalState');
        expect(meta).not.toHaveProperty('previousCheckpointId');
      });
    });

    describe('delete', () => {
      it('removes the checkpoint', async () => {
        const cp = createTestCheckpoint({ agentId: 'agent-e' });
        await store.save(cp);
        await store.delete(cp.id);

        const loaded = await store.load('agent-e');
        expect(loaded).toBeNull();
      });

      it('deleting a non-existent checkpoint does not throw', async () => {
        await expect(store.delete('non-existent-id')).resolves.toBeUndefined();
      });
    });

    describe('verify', () => {
      it('returns true for a valid checkpoint', async () => {
        const cp = createTestCheckpoint();
        await store.save(cp);

        const result = await store.verify(cp.id);
        expect(result).toBe(true);
      });

      it('returns false for a non-existent checkpoint', async () => {
        const result = await store.verify('non-existent-id');
        expect(result).toBe(false);
      });
    });

    describe('agent isolation', () => {
      it('different agents do not see each other\'s checkpoints', async () => {
        const cp1 = createTestCheckpoint({ agentId: 'agent-x', epoch: 1, tick: 1 });
        const cp2 = createTestCheckpoint({ agentId: 'agent-y', epoch: 1, tick: 1 });

        await store.save(cp1);
        await store.save(cp2);

        const loadedX = await store.load('agent-x');
        expect(loadedX).not.toBeNull();
        expect(loadedX!.agentId).toBe('agent-x');

        const loadedY = await store.load('agent-y');
        expect(loadedY).not.toBeNull();
        expect(loadedY!.agentId).toBe('agent-y');

        const listX = await store.list('agent-x');
        expect(listX).toHaveLength(1);
        expect(listX[0].agentId).toBe('agent-x');

        const listY = await store.list('agent-y');
        expect(listY).toHaveLength(1);
        expect(listY[0].agentId).toBe('agent-y');
      });
    });

    describe('empty store behavior', () => {
      it('load returns null for unknown agent', async () => {
        const result = await store.load('unknown-agent');
        expect(result).toBeNull();
      });

      it('loadLatest returns null for unknown agent', async () => {
        const result = await store.loadLatest('unknown-agent');
        expect(result).toBeNull();
      });

      it('list returns empty array for unknown agent', async () => {
        const result = await store.list('unknown-agent');
        expect(result).toEqual([]);
      });
    });
  });
}
