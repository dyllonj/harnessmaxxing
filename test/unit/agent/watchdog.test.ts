import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watchdog } from '@/agent/watchdog';
import type { WatchdogSignal } from '@/agent/watchdog';

describe('Watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits signals at the configured interval', () => {
    const signals: WatchdogSignal[] = [];
    const wd = new Watchdog('agent-1', { intervalMs: 1000 });
    wd.onSignal((s) => signals.push(s));
    wd.start();

    vi.advanceTimersByTime(3000);
    expect(signals).toHaveLength(3);

    wd.stop();
  });

  it('stop() prevents further signals', () => {
    const signals: WatchdogSignal[] = [];
    const wd = new Watchdog('agent-1', { intervalMs: 1000 });
    wd.onSignal((s) => signals.push(s));
    wd.start();

    vi.advanceTimersByTime(2000);
    expect(signals).toHaveLength(2);

    wd.stop();

    vi.advanceTimersByTime(3000);
    expect(signals).toHaveLength(2);
  });

  it('signal contains correct agentId, recent timestamp, and type watchdog', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const signals: WatchdogSignal[] = [];
    const wd = new Watchdog('agent-42', { intervalMs: 500 });
    wd.onSignal((s) => signals.push(s));
    wd.start();

    vi.advanceTimersByTime(500);
    expect(signals).toHaveLength(1);
    expect(signals[0].agentId).toBe('agent-42');
    expect(signals[0].type).toBe('watchdog');
    expect(signals[0].timestamp).toBe(new Date('2026-01-01T00:00:00.500Z').getTime());

    wd.stop();
  });

  it('start() is idempotent', () => {
    const signals: WatchdogSignal[] = [];
    const wd = new Watchdog('agent-1', { intervalMs: 1000 });
    wd.onSignal((s) => signals.push(s));
    wd.start();
    wd.start(); // second call should be no-op

    vi.advanceTimersByTime(1000);
    expect(signals).toHaveLength(1);

    wd.stop();
  });

  it('stop() is idempotent', () => {
    const wd = new Watchdog('agent-1');
    wd.stop(); // should not throw
    wd.stop(); // should not throw
  });
});
