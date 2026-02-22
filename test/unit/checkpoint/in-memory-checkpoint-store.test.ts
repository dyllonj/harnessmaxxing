import { describe, it, expect } from 'vitest';
import { InMemoryCheckpointStore } from '../../helpers/in-memory-checkpoint-store';
import { checkpointStoreTests } from '../../helpers/checkpoint-store-test-factory';
import { createTestCheckpoint } from '../../helpers/checkpoint-factory';

let store: InMemoryCheckpointStore;

checkpointStoreTests(
  'InMemoryCheckpointStore',
  () => {
    store = new InMemoryCheckpointStore();
    return store;
  },
);

describe('InMemoryCheckpointStore: implementation-specific', () => {
  it('corrupt method causes verify to return false', async () => {
    const memStore = new InMemoryCheckpointStore();
    const cp = createTestCheckpoint();
    await memStore.save(cp);

    memStore.corrupt(cp.id);

    const result = await memStore.verify(cp.id);
    expect(result).toBe(false);
  });

  it('corrupt method causes load to return null', async () => {
    const memStore = new InMemoryCheckpointStore();
    const cp = createTestCheckpoint({ agentId: 'corrupt-agent' });
    await memStore.save(cp);

    memStore.corrupt(cp.id);

    const loaded = await memStore.load('corrupt-agent');
    expect(loaded).toBeNull();
  });

  it('saved checkpoint is deep-cloned (mutations do not affect stored data)', async () => {
    const memStore = new InMemoryCheckpointStore();
    const cp = createTestCheckpoint({ agentId: 'clone-test' });
    await memStore.save(cp);

    // Mutate the original
    cp.llmState.systemPrompt = 'MUTATED';

    const loaded = await memStore.load('clone-test');
    expect(loaded).not.toBeNull();
    expect(loaded!.llmState.systemPrompt).toBe('You are a test agent.');
  });
});
