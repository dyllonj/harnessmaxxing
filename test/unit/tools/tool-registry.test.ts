import { describe, it, expect, vi } from 'vitest';
import { createToolRegistry } from '@/tools/tool-registry';
import { createTrackedToolSurface } from '@/tools/create-tracked-tool';
import { EffectLedger } from '@/effects/effect-ledger';
import type { ToolDefinition, ToolHandler } from '@/tools/tool-types';

function makeTool(name: string, handler?: ToolHandler): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name,
      description: `A tool called ${name}`,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    handler: handler ?? (async (input) => ({ result: `called ${name}`, input })),
  };
}

describe('createToolRegistry', () => {
  it('registers and lists tools', () => {
    const registry = createToolRegistry();
    const tool = makeTool('search');
    registry.register(tool.definition, tool.handler);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe('search');
  });

  it('checks tool existence with has()', () => {
    const registry = createToolRegistry();
    const tool = makeTool('search');
    registry.register(tool.definition, tool.handler);

    expect(registry.has('search')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('gets registered tool', () => {
    const registry = createToolRegistry();
    const tool = makeTool('search');
    registry.register(tool.definition, tool.handler);

    const registered = registry.get('search');
    expect(registered).toBeDefined();
    expect(registered!.definition.name).toBe('search');
  });

  it('returns undefined for unregistered tool', () => {
    const registry = createToolRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('executes tool by name', async () => {
    const registry = createToolRegistry();
    const handler = vi.fn(async (input: Record<string, unknown>) => ({ answer: input['query'] }));
    registry.register(makeTool('search', handler).definition, handler);

    const result = await registry.execute('search', { query: 'hello' });
    expect(result).toEqual({ answer: 'hello' });
    expect(handler).toHaveBeenCalledWith({ query: 'hello' });
  });

  it('throws on duplicate registration', () => {
    const registry = createToolRegistry();
    const tool = makeTool('search');
    registry.register(tool.definition, tool.handler);

    expect(() => registry.register(tool.definition, tool.handler)).toThrow('already registered');
  });

  it('throws on executing unknown tool', async () => {
    const registry = createToolRegistry();
    await expect(registry.execute('nonexistent', {})).rejects.toThrow('Unknown tool');
  });

  it('lists multiple tools', () => {
    const registry = createToolRegistry();
    registry.register(makeTool('search').definition, makeTool('search').handler);
    registry.register(makeTool('read').definition, makeTool('read').handler);

    expect(registry.list()).toHaveLength(2);
  });
});

describe('createTrackedToolSurface', () => {
  it('tracks tool execution as effects', async () => {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => ({ done: true }));
    registry.register(makeTool('search', handler).definition, handler);

    const ledger = new EffectLedger('test-agent');
    const recordBudget = vi.fn();
    const surface = createTrackedToolSurface(registry, ledger, 0, recordBudget);

    await surface.execute('search', { query: 'test' });

    const committed = ledger.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0].type).toBe('tool_call');
    expect(committed[0].intent.action).toBe('search');
    expect(committed[0].intent.parameters).toEqual({ query: 'test' });
  });

  it('records budget on successful execution', async () => {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => 'ok');
    registry.register(makeTool('search', handler).definition, handler);

    const ledger = new EffectLedger('test-agent');
    const recordBudget = vi.fn();
    const surface = createTrackedToolSurface(registry, ledger, 0, recordBudget);

    await surface.execute('search', {});

    expect(recordBudget).toHaveBeenCalledWith({ toolInvocations: 1 });
  });

  it('marks effect as failed on error and re-throws', async () => {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => { throw new Error('tool broke'); });
    registry.register(makeTool('search', handler).definition, handler);

    const ledger = new EffectLedger('test-agent');
    const recordBudget = vi.fn();
    const surface = createTrackedToolSurface(registry, ledger, 0, recordBudget);

    await expect(surface.execute('search', {})).rejects.toThrow('tool broke');

    const failed = ledger.getFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('tool broke');
    expect(recordBudget).not.toHaveBeenCalled();
  });

  it('delegates list() and has() to registry', () => {
    const registry = createToolRegistry();
    registry.register(makeTool('search').definition, makeTool('search').handler);

    const ledger = new EffectLedger('test-agent');
    const surface = createTrackedToolSurface(registry, ledger, 0, vi.fn());

    expect(surface.list()).toHaveLength(1);
    expect(surface.has('search')).toBe(true);
    expect(surface.has('nope')).toBe(false);
  });
});
