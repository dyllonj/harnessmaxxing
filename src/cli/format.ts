import type { LifecycleState } from '../types/lifecycle.js';
import type { HealthStatus } from '../types/heartbeat.js';

export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

export function colorize(text: string, ...codes: string[]): string {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${codes.join('')}${text}${ansi.reset}`;
}

export function healthColor(status: HealthStatus): string {
  const colors: Record<HealthStatus, string> = {
    healthy: ansi.green,
    degraded: ansi.yellow,
    critical: ansi.red,
  };
  return colorize(status, colors[status]);
}

export function stateColor(state: LifecycleState): string {
  const colors: Record<LifecycleState, string[]> = {
    UNBORN: [ansi.dim],
    INITIALIZING: [ansi.cyan],
    RUNNING: [ansi.green],
    SLEEPING: [ansi.blue],
    ERROR: [ansi.red],
    CHECKPOINTED: [ansi.cyan],
    RECOVERING: [ansi.yellow],
    DEAD: [ansi.bold, ansi.red],
    ARCHIVED: [ansi.dim],
  };
  return colorize(state, ...(colors[state] ?? [ansi.dim]));
}

export function progressBar(ratio: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  let color: string = ansi.green;
  if (clamped >= 0.9) {
    color = ansi.red;
  } else if (clamped >= 0.7) {
    color = ansi.yellow;
  }

  return colorize(bar, color);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) {
    return `$${usd.toFixed(6)}`;
  }
  if (usd < 1) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}
