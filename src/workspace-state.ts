import type { TaskUpdate, Workspace } from './types';

export function mergeWorkspace(
  previous: Workspace,
  incoming: Workspace,
  updates: ReadonlyMap<string, TaskUpdate>,
): Workspace {
  const previousById = new Map(previous.tasks.map((task) => [task.id, task]));
  return {
    ...incoming,
    tasks: incoming.tasks.map((task) => {
      const old = previousById.get(task.id);
      const current = old && (old.revision || 0) > (task.revision || 0) ? old : task;
      const update = updates.get(task.id);
      return update && (update.revision || 0) > (current.revision || 0)
        ? { ...current, ...update }
        : current;
    }),
  };
}

export function applyTaskUpdate(workspace: Workspace, update: TaskUpdate): Workspace {
  let changed = false;
  const tasks = workspace.tasks.map((task) => {
    if (task.id !== update.id || (update.revision || 0) <= (task.revision || 0)) return task;
    changed = true;
    return { ...task, ...update };
  });
  return changed ? { ...workspace, tasks } : workspace;
}
