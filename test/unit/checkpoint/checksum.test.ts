import { describe, it, expect } from 'vitest';
import { computeChecksum, verifyChecksum } from '@/checkpoint/checksum';
import { createTestCheckpoint } from '../../helpers/checkpoint-factory';

describe('computeChecksum', () => {
  it('produces a 64-character hex string', () => {
    const checkpoint = createTestCheckpoint();
    const { checksum: _, ...rest } = checkpoint;
    const hash = computeChecksum(rest);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic (same input = same output)', () => {
    const checkpoint = createTestCheckpoint({ tick: 42 });
    const { checksum: _, ...rest } = checkpoint;

    const hash1 = computeChecksum(rest);
    const hash2 = computeChecksum(rest);

    expect(hash1).toBe(hash2);
  });

  it('produces different checksums for different inputs', () => {
    const cp1 = createTestCheckpoint({ tick: 1 });
    const cp2 = createTestCheckpoint({ tick: 2 });

    const { checksum: _1, ...rest1 } = cp1;
    const { checksum: _2, ...rest2 } = cp2;

    expect(computeChecksum(rest1)).not.toBe(computeChecksum(rest2));
  });

  it('property order does not affect checksum (sorted keys)', () => {
    const cp = createTestCheckpoint();
    const { checksum: _, ...rest } = cp;

    // Build an object with reversed key order
    const keys = Object.keys(rest);
    const reversed: Record<string, unknown> = {};
    for (let i = keys.length - 1; i >= 0; i--) {
      reversed[keys[i]] = (rest as Record<string, unknown>)[keys[i]];
    }

    const hash1 = computeChecksum(rest);
    const hash2 = computeChecksum(reversed as typeof rest);

    expect(hash1).toBe(hash2);
  });

  it('handles nested objects and arrays', () => {
    const cp = createTestCheckpoint({
      externalState: {
        taskQueue: [],
        completedTasks: [],
        keyValueStore: {
          nested: { deep: { value: [1, 2, 3] } },
          array: [{ a: 1 }, { b: 2 }],
        },
        pendingEffects: [],
        committedEffects: [],
      },
    });
    const { checksum: _, ...rest } = cp;

    const hash = computeChecksum(rest);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles empty data structures', () => {
    const cp = createTestCheckpoint({
      externalState: {
        taskQueue: [],
        completedTasks: [],
        keyValueStore: {},
        pendingEffects: [],
        committedEffects: [],
      },
    });
    const { checksum: _, ...rest } = cp;

    const hash = computeChecksum(rest);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyChecksum', () => {
  it('returns true for a valid checkpoint', () => {
    const checkpoint = createTestCheckpoint();
    expect(verifyChecksum(checkpoint)).toBe(true);
  });

  it('returns false when a field is tampered with', () => {
    const checkpoint = createTestCheckpoint();
    checkpoint.tick = 9999;
    expect(verifyChecksum(checkpoint)).toBe(false);
  });

  it('returns false when the checksum itself is tampered with', () => {
    const checkpoint = createTestCheckpoint();
    checkpoint.checksum = 'aaaa'.repeat(16);
    expect(verifyChecksum(checkpoint)).toBe(false);
  });

  it('returns false when a nested field is tampered with', () => {
    const checkpoint = createTestCheckpoint();
    checkpoint.llmState.temperature = 999;
    expect(verifyChecksum(checkpoint)).toBe(false);
  });

  it('returns false when conversation history is modified', () => {
    const checkpoint = createTestCheckpoint();
    checkpoint.llmState.conversationHistory.push({
      role: 'user',
      content: 'injected message',
    });
    expect(verifyChecksum(checkpoint)).toBe(false);
  });
});
