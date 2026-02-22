import type { Logger } from 'pino';
import type { HookName, HookHandler, HookRegistry } from '../types/hooks.js';
import { ALL_HOOK_NAMES } from '../types/hooks.js';

export function createHookRegistry(logger: Logger): HookRegistry {
  const handlers: Record<HookName, HookHandler<unknown>[]> = {} as Record<HookName, HookHandler<unknown>[]>;

  for (const name of ALL_HOOK_NAMES) {
    handlers[name] = [];
  }

  return {
    on(hook: HookName, handler: HookHandler<unknown>): void {
      handlers[hook].push(handler);
    },

    off(hook: HookName, handler: HookHandler<unknown>): void {
      const list = handlers[hook];
      const idx = list.indexOf(handler);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    },

    async fire(hook: HookName, event: unknown): Promise<void> {
      for (const handler of handlers[hook]) {
        try {
          await handler(event);
        } catch (err) {
          logger.error({ hook, err }, 'hook handler threw');
        }
      }
    },
  };
}
