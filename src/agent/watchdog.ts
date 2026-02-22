export type WatchdogConfig = {
  intervalMs: number;
};

export type WatchdogSignal = {
  agentId: string;
  timestamp: number;
  type: 'watchdog';
};

export class Watchdog {
  private readonly agentId: string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handler: ((signal: WatchdogSignal) => void) | null = null;

  constructor(agentId: string, config?: Partial<WatchdogConfig>) {
    this.agentId = agentId;
    this.intervalMs = config?.intervalMs ?? 30000;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.handler) {
        this.handler({
          agentId: this.agentId,
          timestamp: Date.now(),
          type: 'watchdog',
        });
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  onSignal(handler: (signal: WatchdogSignal) => void): void {
    this.handler = handler;
  }
}
