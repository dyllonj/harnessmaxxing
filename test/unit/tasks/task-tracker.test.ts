import { describe, it, expect } from 'vitest';
import { createTaskTracker } from '@/tasks/task-tracker';

describe('createTaskTracker', () => {
  it('adds a task with default values', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Build feature');

    expect(task.description).toBe('Build feature');
    expect(task.status).toBe('pending');
    expect(task.dependsOn).toEqual([]);
    expect(task.assignedTo).toBeNull();
    expect(task.priority).toBe(0);
    expect(task.id).toBeTruthy();
    expect(task.createdAt).toBeGreaterThan(0);
  });

  it('adds a task with options', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Deploy', {
      priority: 5,
      assignedTo: 'agent-1',
      dependsOn: ['dep-1'],
      metadata: { env: 'prod' },
    });

    expect(task.priority).toBe(5);
    expect(task.assignedTo).toBe('agent-1');
    expect(task.dependsOn).toEqual(['dep-1']);
    expect(task.metadata).toEqual({ env: 'prod' });
  });

  it('starts a pending task', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Test');
    tracker.start(task.id);

    const updated = tracker.get(task.id);
    expect(updated?.status).toBe('in_progress');
  });

  it('completes an in-progress task', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Test');
    tracker.start(task.id);
    tracker.complete(task.id);

    const updated = tracker.get(task.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).toBeGreaterThan(0);
  });

  it('fails an in-progress task', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Test');
    tracker.start(task.id);
    tracker.fail(task.id, 'timeout');

    const updated = tracker.get(task.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.metadata?.failureReason).toBe('timeout');
  });

  it('throws when starting non-pending task', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Test');
    tracker.start(task.id);

    expect(() => tracker.start(task.id)).toThrow('expected "pending"');
  });

  it('throws when completing non-in_progress task', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Test');

    expect(() => tracker.complete(task.id)).toThrow('expected "in_progress"');
  });

  it('throws when failing non-in_progress task', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Test');

    expect(() => tracker.fail(task.id)).toThrow('expected "in_progress"');
  });

  it('throws on unknown task ID', () => {
    const tracker = createTaskTracker();
    expect(() => tracker.start('nonexistent')).toThrow('not found');
  });

  it('lists all tasks', () => {
    const tracker = createTaskTracker();
    tracker.add('A');
    tracker.add('B');
    tracker.add('C');

    expect(tracker.list()).toHaveLength(3);
  });

  it('lists pending tasks', () => {
    const tracker = createTaskTracker();
    const a = tracker.add('A');
    tracker.add('B');
    tracker.start(a.id);

    expect(tracker.listPending()).toHaveLength(1);
    expect(tracker.listPending()[0].description).toBe('B');
  });

  it('lists in-progress tasks', () => {
    const tracker = createTaskTracker();
    const a = tracker.add('A');
    tracker.add('B');
    tracker.start(a.id);

    expect(tracker.listInProgress()).toHaveLength(1);
    expect(tracker.listInProgress()[0].description).toBe('A');
  });

  it('listReady returns pending tasks with all deps completed', () => {
    const tracker = createTaskTracker();
    const dep = tracker.add('Dep');
    const task = tracker.add('Main', { dependsOn: [dep.id] });
    tracker.add('Independent');

    // Before dep is completed: Dep and Independent are ready, Main is blocked
    expect(tracker.listReady()).toHaveLength(2); // 'Dep' and 'Independent'
    expect(tracker.listBlocked()).toHaveLength(1); // 'Main'

    // Complete the dependency
    tracker.start(dep.id);
    tracker.complete(dep.id);

    // Now Main is ready too (Dep is completed so no longer pending/ready)
    expect(tracker.listReady()).toHaveLength(2); // 'Main' and 'Independent'
    expect(tracker.listBlocked()).toHaveLength(0);
  });

  it('listBlocked returns tasks with incomplete deps', () => {
    const tracker = createTaskTracker();
    const dep = tracker.add('Dep');
    tracker.add('Blocked', { dependsOn: [dep.id] });

    expect(tracker.listBlocked()).toHaveLength(1);
    expect(tracker.listBlocked()[0].description).toBe('Blocked');
  });

  it('updates task fields', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Original');
    tracker.update(task.id, { description: 'Updated', priority: 10, assignedTo: 'agent-2' });

    const updated = tracker.get(task.id);
    expect(updated?.description).toBe('Updated');
    expect(updated?.priority).toBe(10);
    expect(updated?.assignedTo).toBe('agent-2');
  });

  it('getCompleted returns only completed tasks', () => {
    const tracker = createTaskTracker();
    const a = tracker.add('A');
    tracker.add('B');
    tracker.start(a.id);
    tracker.complete(a.id);

    expect(tracker.getCompleted()).toHaveLength(1);
    expect(tracker.getCompleted()[0].description).toBe('A');
  });

  it('getFailed returns only failed tasks', () => {
    const tracker = createTaskTracker();
    const a = tracker.add('A');
    tracker.start(a.id);
    tracker.fail(a.id);

    expect(tracker.getFailed()).toHaveLength(1);
  });

  it('snapshot returns pending and completed buckets', () => {
    const tracker = createTaskTracker();
    const a = tracker.add('A');
    tracker.add('B');
    tracker.start(a.id);
    tracker.complete(a.id);

    const snap = tracker.snapshot();
    expect(snap.completed).toHaveLength(1);
    expect(snap.pending).toHaveLength(1);
    expect(snap.pending[0].description).toBe('B');
  });

  it('restores from initial tasks', () => {
    const tracker = createTaskTracker([
      {
        id: 'restored-1',
        description: 'Restored task',
        status: 'pending',
        createdAt: 1000,
        dependsOn: [],
        assignedTo: null,
        priority: 0,
      },
    ]);

    expect(tracker.list()).toHaveLength(1);
    expect(tracker.get('restored-1')?.description).toBe('Restored task');
  });

  it('returns copies from get, not references', () => {
    const tracker = createTaskTracker();
    const task = tracker.add('Mutable?');
    const copy = tracker.get(task.id);
    if (copy) {
      copy.description = 'mutated';
    }

    expect(tracker.get(task.id)?.description).toBe('Mutable?');
  });
});
