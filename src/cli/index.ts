#!/usr/bin/env node
import { Command } from 'commander';
import { registerSpawnCommand } from './spawn.js';
import { registerListCommand } from './list.js';
import { registerInspectCommand } from './inspect.js';
import { registerKillCommand } from './kill.js';
import { registerLogsCommand } from './logs.js';
import { registerBudgetCommand } from './budget.js';

const program = new Command();

program
  .name('harnessmaxxing')
  .description('Agent harness platform for persistent, long-running AI agents')
  .version('0.0.1');

registerSpawnCommand(program);
registerListCommand(program);
registerInspectCommand(program);
registerKillCommand(program);
registerLogsCommand(program);
registerBudgetCommand(program);

program.parse();
