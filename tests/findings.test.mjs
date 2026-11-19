import assert from "node:assert/strict";
import test from "node:test";
import { generateFindings } from "../src/analysis/findings.mjs";

const task = (task_id, status = "Open", blocked_by = []) => ({
  task_id,
  title: `Task ${task_id}`,
  status,
  blocked_by,
});

const signal = (task_id, signal_type = "blocker", state = "active", evidence = `${task_id} is blocked.`) => ({
  signal_id: `signal:${signal_type}:${task_id}:${evidence}`,
  signal_type,
  state,
  evidence,
  start_offset: 0,
  end_offset: evidence.length,
});

const findingsFor = (tasks, signals, linkedTask = tasks[0]) => generateFindings(
  tasks,
  signals.map((signal) => ({ signal, tasks: linkedTask ? [linkedTask] : [] })),
);

test("creates exactly one T-102 finding from its active pending approval signal", () => {
  const blockedTask = { ...task("T-102", "Blocked"), title: "Approve supplier" };
  const evidence = "The supplier approval is still pending.";
  const pendingSignal = signal("T-102", "pending_decision", "active", evidence);
  const findings = findingsFor([blockedTask], [pendingSignal]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].task.task_id, "T-102");
  assert.equal(findings[0].task.title, "Approve supplier");
  assert.match(findings[0].relationship, /marked Blocked/);
  assert.match(findings[0].relationship, /pending_decision|pending decision/);
  assert.deepEqual(findings[0].confirmed_evidence[0], { kind: "task_status", value: "Blocked" });
  assert.deepEqual(findings[0].confirmed_evidence[1], {
    kind: "meeting_signal",
    signal_id: pendingSignal.signal_id,
    source_ref: { source_id: "meeting_notes" },
    signal_type: "pending_decision",
    state: "active",
    evidence,
    start_offset: 0,
    end_offset: evidence.length,
  });
  assert.equal(findings[0].finding_fingerprint, "blocked_task:T-102");
});

test("qualifies trimmed case-insensitive blocked status and active blocker or pending-decision signals", () => {
  const blockedTask = task("T-1", " bLoCkEd ");
  const findings = findingsFor([blockedTask], [
    signal("T-1", "blocker"),
    signal("T-1", "pending_decision"),
  ]);

  assert.equal(findings.length, 1);
  assert.deepEqual(
    findings[0].confirmed_evidence.filter(({ kind }) => kind === "meeting_signal").map(({ signal_type }) => signal_type),
    ["blocker", "pending_decision"],
  );
});

test("does not qualify delay signals", () => {
  assert.deepEqual(findingsFor([task("T-1", "Blocked")], [signal("T-1", "delay")]), []);
});

test("does not qualify a task whose status is not blocked", () => {
  assert.deepEqual(findingsFor([task("T-1", "In Progress")], [signal("T-1")]), []);
});

test("does not qualify non-active blocker or pending-decision signals", () => {
  const blockedTask = task("T-1", "Blocked");
  const signals = ["resolved", "uncertain", "conflicting_evidence"].flatMap((state) => [
    signal("T-1", "blocker", state),
    signal("T-1", "pending_decision", state),
  ]);

  assert.deepEqual(findingsFor([blockedTask], signals), []);
});

test("includes dependency evidence and labels downstream impact only as a possibility", () => {
  const blockedTask = task("T-1", "Blocked");
  const dependentTask = task("T-2", "In Progress", ["T-1"]);
  const [finding] = findingsFor([blockedTask, dependentTask], [signal("T-1")]);

  assert.deepEqual(finding.dependencies, [{ task_id: "T-2", title: "Task T-2", blocked_by_task_id: "T-1" }]);
  assert.equal(finding.possible_implications.length, 1);
  assert.match(finding.possible_implications[0], /could be affected/);
  assert.match(finding.possible_implications[0], /does not establish an actual delay or delivery impact/);
});

test("creates the corroborated finding without asserting implications when no task depends on it", () => {
  const [finding] = findingsFor([task("T-1", "Blocked")], [signal("T-1")]);

  assert.ok(finding);
  assert.deepEqual(finding.dependencies, []);
  assert.deepEqual(finding.possible_implications, []);
});

test("groups multiple qualifying signals for one task into a single finding", () => {
  const findings = findingsFor([task("T-1", "Blocked")], [
    signal("T-1", "blocker", "active", "T-1 is blocked."),
    signal("T-1", "pending_decision", "active", "T-1 approval is pending."),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].confirmed_evidence.filter(({ kind }) => kind === "meeting_signal").length, 2);
});

test("does not create a finding when an active signal has no explicit link to the blocked task", () => {
  const blockedTask = task("T-1", "Blocked");
  const unlinkedSignal = signal("T-99", "blocker");

  assert.deepEqual(generateFindings([blockedTask], [{ signal: unlinkedSignal, tasks: [] }]), []);
});

test("returns no findings for empty inputs", () => {
  assert.deepEqual(generateFindings([], []), []);
});

test("does not mutate source tasks or signals", () => {
  const blockedTask = task("T-1", "Blocked");
  const dependentTask = task("T-2", "Open", ["T-1"]);
  const blockerSignal = signal("T-1");
  const originalTask = structuredClone(blockedTask);
  const originalDependent = structuredClone(dependentTask);
  const originalSignal = structuredClone(blockerSignal);

  findingsFor([blockedTask, dependentTask], [blockerSignal]);

  assert.deepEqual(blockedTask, originalTask);
  assert.deepEqual(dependentTask, originalDependent);
  assert.deepEqual(blockerSignal, originalSignal);
});
