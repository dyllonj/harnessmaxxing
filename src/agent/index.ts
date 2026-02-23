export { Agent } from './agent.js';
export { Watchdog } from './watchdog.js';
export { createTickLoop } from './tick-loop.js';

export type { TickContext, InboxMessage, InboxDrain } from './tick-context.js';
export type { TickLoopConfig, TickLoopDeps, AgentLike, TickLoop } from './tick-loop.js';
export type { WatchdogConfig, WatchdogSignal } from './watchdog.js';
