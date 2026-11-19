import assert from "node:assert/strict";
import test from "node:test";
import { linkSignalsToTasks } from "../src/analysis/task-linking.mjs";

const task = (task_id, title = `Task ${task_id}`) => ({ task_id, title, status: "Open" });
const signal = (evidence, signal_id = evidence) => ({ signal_id, evidence, signal_type: "blocker", state: "active" });

test("links a signal when its evidence explicitly contains a valid task ID", () => {
  const importedTask = task("DR-101");
  const extractedSignal = signal("DR-101 is blocked by vendor access.");
  const [link] = linkSignalsToTasks([importedTask], [extractedSignal]);

  assert.strictEqual(link.signal, extractedSignal);
  assert.deepEqual(link.tasks, [importedTask]);
});

test("does not link an unknown task ID", () => {
  const [link] = linkSignalsToTasks([task("DR-101")], [signal("DR-999 is delayed.")]);

  assert.deepEqual(link.tasks, []);
});

test("leaves a signal without an explicit task ID unlinked", () => {
  const [link] = linkSignalsToTasks([task("DR-101")], [signal("The API is blocked pending access.")]);

  assert.deepEqual(link.tasks, []);
});

test("links multiple signals to their explicitly referenced tasks without altering source data", () => {
  const tasks = [task("DR-101"), task("DR-202")];
  const signals = [signal("DR-101 is blocked."), signal("Approval for DR-202 is pending.")];
  const links = linkSignalsToTasks(tasks, signals);

  assert.deepEqual(links.map(({ tasks: matches }) => matches.map(({ task_id }) => task_id)), [["DR-101"], ["DR-202"]]);
  assert.strictEqual(tasks[0].task_id, "DR-101");
  assert.strictEqual(signals[0].evidence, "DR-101 is blocked.");
});

test("leaves all signals unlinked when no tasks have been imported", () => {
  const links = linkSignalsToTasks([], [signal("DR-101 is blocked."), signal("Decision pending.")]);

  assert.deepEqual(links.map(({ tasks }) => tasks), [[], []]);
});

test("does not link a task ID that appears only as part of a larger identifier", () => {
  const [link] = linkSignalsToTasks([task("DR-1")], [signal("DR-10 is blocked.")]);

  assert.deepEqual(link.tasks, []);
});
