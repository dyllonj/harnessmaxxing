import { describe, it, expect } from 'vitest';
import * as core from '@/index';

describe('smoke', () => {
  it('should import the core module', () => {
    expect(core).toBeDefined();
  });
});
