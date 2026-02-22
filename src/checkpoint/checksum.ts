import { createHash } from 'node:crypto';
import type { Checkpoint } from '../types/checkpoint.js';

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined ? 'null' : stableStringify(item),
    );
    return '[' + items.join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) {
        continue;
      }
      pairs.push(JSON.stringify(key) + ':' + stableStringify(v));
    }
    return '{' + pairs.join(',') + '}';
  }

  return String(value);
}

export function computeChecksum(checkpoint: Omit<Checkpoint, 'checksum'>): string {
  const serialized = stableStringify(checkpoint);
  return createHash('sha256').update(serialized).digest('hex');
}

export function verifyChecksum(checkpoint: Checkpoint): boolean {
  const { checksum, ...rest } = checkpoint;
  const computed = computeChecksum(rest);
  return computed === checksum;
}
