const QUALIFYING_SIGNAL_TYPES = new Set(["blocker", "pending_decision"]);

/** Build one evidence-backed finding per blocked task with a qualifying linked signal. */
export function generateFindings(tasks, linkedSignals) {
  const findingsByTask = new Map();
  const signalReferencesByTask = new Map();
  const importedTasks = new Set(tasks);

  for (const { signal, tasks: linkedTasks } of linkedSignals) {
    if (signal?.state !== "active" || !QUALIFYING_SIGNAL_TYPES.has(signal.signal_type)) continue;

    for (const linkedTask of linkedTasks) {
      if (!importedTasks.has(linkedTask) || !isBlocked(linkedTask.status)) continue;

      let finding = findingsByTask.get(linkedTask);
      if (!finding) {
        finding = {
          finding_fingerprint: `blocked_task:${linkedTask.task_id}`,
          finding_type: "blocked_task",
          task: linkedTask,
          suggested_action: "Review the blocked task and its linked active signal.",
          confirmed_evidence: [
            { kind: "task_status", value: linkedTask.status },
          ],
          dependencies: tasks
            .filter((task) => task !== linkedTask && Array.isArray(task.blocked_by) && task.blocked_by.includes(linkedTask.task_id))
            .map((task) => ({
              task_id: task.task_id,
              title: task.title,
              blocked_by_task_id: linkedTask.task_id,
            })),
          possible_implications: [],
        };

        if (finding.dependencies.length > 0) {
          finding.possible_implications.push(
            `These tasks list ${linkedTask.task_id} as a prerequisite. Their progress could be affected; the available evidence does not establish an actual delay or delivery impact.`,
          );
        }

        findingsByTask.set(linkedTask, finding);
        signalReferencesByTask.set(linkedTask, new Set());
      }

      const seenSignals = signalReferencesByTask.get(linkedTask);
      if (seenSignals.has(signal)) continue;
      seenSignals.add(signal);

      finding.confirmed_evidence.push({
        kind: "meeting_signal",
        signal_id: signal.signal_id,
        source_ref: signal.source_ref ?? { source_id: "meeting_notes" },
        signal_type: signal.signal_type,
        state: signal.state,
        evidence: signal.evidence,
        start_offset: signal.start_offset,
        end_offset: signal.end_offset,
      });
    }
  }

  return [...findingsByTask.values()].map((finding) => {
    const signalTypes = [...new Set(
      finding.confirmed_evidence
        .filter((evidence) => evidence.kind === "meeting_signal")
        .map((evidence) => evidence.signal_type.replaceAll("_", " ")),
    )];
    const signalDescription = signalTypes.join(" and ");

    return {
      ...finding,
      relationship: `The task is marked Blocked in the imported data and has an explicitly linked active ${signalDescription} signal${signalTypes.length === 1 ? "" : "s"}.`,
    };
  });
}

function isBlocked(status) {
  return typeof status === "string" && status.trim().toLowerCase() === "blocked";
}
