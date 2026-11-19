/** Link note signals only when their evidence explicitly contains an imported task ID. */
export function linkSignalsToTasks(tasks, signals) {
  return signals.map((signal) => ({
    signal,
    tasks: tasks.filter((task) => containsTaskId(signal.evidence, task.task_id)),
  }));
}

function containsTaskId(evidence, taskId) {
  if (typeof evidence !== "string" || typeof taskId !== "string" || taskId.length === 0) return false;

  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const taskIdPattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapedTaskId}(?![\\p{L}\\p{N}_-])`, "u");
  return taskIdPattern.test(evidence);
}
