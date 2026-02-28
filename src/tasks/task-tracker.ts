import { v7 as uuidv7 } from 'uuid';
import type { Task } from '../types/checkpoint.js';

export type TaskTracker = {
  add(description: string, opts?: {
    dependsOn?: string[];
    assignedTo?: string | null;
    priority?: number;
    metadata?: Record<string, unknown>;
  }): Task;
  start(taskId: string): void;
  complete(taskId: string): void;
  fail(taskId: string, reason?: string): void;
  get(taskId: string): Task | undefined;
  list(): Task[];
  listPending(): Task[];
  listReady(): Task[];
  listBlocked(): Task[];
  listInProgress(): Task[];
  update(taskId: string, updates: Partial<Pick<Task, 'description' | 'priority' | 'assignedTo' | 'metadata'>>): void;
  getCompleted(): Task[];
  getFailed(): Task[];
  snapshot(): { pending: Task[]; completed: Task[] };
};

export function createTaskTracker(initialTasks?: Task[]): TaskTracker {
  const tasks = new Map<string, Task>();

  if (initialTasks) {
    for (const task of initialTasks) {
      tasks.set(task.id, { ...task });
    }
  }

  function getOrThrow(taskId: string): Task {
    const task = tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: "${taskId}"`);
    }
    return task;
  }

  function isCompleted(taskId: string): boolean {
    const task = tasks.get(taskId);
    return task !== undefined && task.status === 'completed';
  }

  return {
    add(description, opts) {
      const task: Task = {
        id: uuidv7(),
        description,
        status: 'pending',
        createdAt: Date.now(),
        dependsOn: opts?.dependsOn ?? [],
        assignedTo: opts?.assignedTo ?? null,
        priority: opts?.priority ?? 0,
        metadata: opts?.metadata,
      };
      tasks.set(task.id, task);
      return task;
    },

    start(taskId) {
      const task = getOrThrow(taskId);
      if (task.status !== 'pending') {
        throw new Error(`Cannot start task "${taskId}": status is "${task.status}", expected "pending"`);
      }
      task.status = 'in_progress';
    },

    complete(taskId) {
      const task = getOrThrow(taskId);
      if (task.status !== 'in_progress') {
        throw new Error(`Cannot complete task "${taskId}": status is "${task.status}", expected "in_progress"`);
      }
      task.status = 'completed';
      task.completedAt = Date.now();
    },

    fail(taskId, reason) {
      const task = getOrThrow(taskId);
      if (task.status !== 'in_progress') {
        throw new Error(`Cannot fail task "${taskId}": status is "${task.status}", expected "in_progress"`);
      }
      task.status = 'failed';
      task.completedAt = Date.now();
      if (reason) {
        task.metadata = { ...task.metadata, failureReason: reason };
      }
    },

    get(taskId) {
      const task = tasks.get(taskId);
      return task ? { ...task } : undefined;
    },

    list() {
      return Array.from(tasks.values()).map((t) => ({ ...t }));
    },

    listPending() {
      return Array.from(tasks.values())
        .filter((t) => t.status === 'pending')
        .map((t) => ({ ...t }));
    },

    listReady() {
      return Array.from(tasks.values())
        .filter((t) => t.status === 'pending' && t.dependsOn.every(isCompleted))
        .map((t) => ({ ...t }));
    },

    listBlocked() {
      return Array.from(tasks.values())
        .filter((t) => t.status === 'pending' && !t.dependsOn.every(isCompleted))
        .map((t) => ({ ...t }));
    },

    listInProgress() {
      return Array.from(tasks.values())
        .filter((t) => t.status === 'in_progress')
        .map((t) => ({ ...t }));
    },

    update(taskId, updates) {
      const task = getOrThrow(taskId);
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.priority !== undefined) task.priority = updates.priority;
      if (updates.assignedTo !== undefined) task.assignedTo = updates.assignedTo;
      if (updates.metadata !== undefined) task.metadata = { ...task.metadata, ...updates.metadata };
    },

    getCompleted() {
      return Array.from(tasks.values())
        .filter((t) => t.status === 'completed')
        .map((t) => ({ ...t }));
    },

    getFailed() {
      return Array.from(tasks.values())
        .filter((t) => t.status === 'failed')
        .map((t) => ({ ...t }));
    },

    snapshot() {
      const all = Array.from(tasks.values());
      return {
        pending: all.filter((t) => t.status !== 'completed').map((t) => ({ ...t })),
        completed: all.filter((t) => t.status === 'completed').map((t) => ({ ...t })),
      };
    },
  };
}
