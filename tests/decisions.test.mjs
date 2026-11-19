import assert from "node:assert/strict";
import test from "node:test";
import { generateFindings } from "../src/analysis/findings.mjs";
import {
  getDecisionKey,
  getEvidenceSignature,
  NOT_OBSERVED_MESSAGE,
  reconcileDecisions,
  saveDecision,
} from "../src/review/decisions.mjs";

const task = (task_id = "T-102", status = "Blocked", blocked_by = []) => ({
  task_id,
  title: task_id === "T-102" ? "Approve supplier" : `Task ${task_id}`,
  status,
  blocked_by,
});

const signal = (evidence = "The supplier approval is still pending.", overrides = {}) => ({
  signal_id: "signal:pending_decision:T-102:0",
  signal_type: "pending_decision",
  state: "active",
  source_ref: { source_id: "meeting_notes" },
  evidence,
  start_offset: 0,
  end_offset: evidence.length,
  extractor: { name: "rules", version: "1.0.0" },
  ...overrides,
});

const makeFinding = ({
  task: blockedTask = task(),
  signals = [signal()],
  dependencies = [],
} = {}) => generateFindings(
  [blockedTask, ...dependencies.map((dependency) => task(dependency.task_id, dependency.status ?? "Open", [blockedTask.task_id]))],
  signals.map((currentSignal) => ({ signal: currentSignal, tasks: [blockedTask] })),
)[0];

const save = (store, finding, status, values = {}) => saveDecision(store, {
  project_id: "project-a",
  finding,
  status,
  decided_at: "2026-11-20T10:00:00.000Z",
  ...values,
});

test("records Confirm and Dismiss decisions with reviewed evidence and timestamps", () => {
  const finding = makeFinding();
  const confirmedStore = new Map();
  const confirmed = save(confirmedStore, finding, "confirmed");
  const dismissedStore = new Map();
  const dismissed = save(dismissedStore, finding, "dismissed", {
    reason: "False positive",
    dismiss_reason_category: "false_positive",
    explanatory_note: "The vendor has already approved it outside the meeting.",
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.reviewed_evidence_signature, getEvidenceSignature(finding));
  assert.deepEqual(confirmed.evidence_snapshot[1].evidence, "The supplier approval is still pending.");
  assert.equal(confirmed.decided_at, "2026-11-20T10:00:00.000Z");
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.dismiss_reason_category, "false_positive");
});

test("requires a dismissal reason category", () => {
  assert.throws(
    () => save(new Map(), makeFinding(), "dismissed", { dismiss_reason_category: "false_positive" }),
    /dismissal reason/,
  );
  assert.throws(
    () => save(new Map(), makeFinding(), "dismissed", { reason: "False positive", dismiss_reason_category: "other" }),
    /Choose False positive or Handled externally/,
  );
});

test("requires an override reason and at least one revised field", () => {
  const finding = makeFinding();
  assert.throws(() => save(new Map(), finding, "overridden", { suggested_action: "Ask the vendor." }), /override reason/);
  assert.throws(() => save(new Map(), finding, "overridden", { reason: "Different assessment" }), /revised assessment or suggested action/);

  const decision = save(new Map(), finding, "overridden", {
    reason: "Supplier approval is tracked in procurement.",
    revised_assessment: "The project task remains blocked, but Procurement owns the next step.",
  });
  assert.equal(decision.status, "overridden");
  assert.ok(decision.revised_assessment);
});

test("updates the latest decision without adding a history record", () => {
  const finding = makeFinding();
  const store = new Map();
  save(store, finding, "confirmed");
  const updated = save(store, finding, "overridden", {
    reason: "Reassessed after review.",
    suggested_action: "Check the supplier approval with Procurement.",
  });

  assert.equal(store.size, 1);
  assert.equal(store.get(getDecisionKey("project-a", finding.finding_fingerprint)), updated);
  assert.equal(updated.status, "overridden");
});

test("decisions remain associated after findings are reordered", () => {
  const first = makeFinding();
  const secondTask = task("T-200", "Blocked");
  const second = makeFinding({ task: secondTask, signals: [signal("T-200 is blocked.")] });
  const store = new Map();
  save(store, first, "confirmed");

  const view = reconcileDecisions("project-a", [second, first], store);
  assert.equal(view.current[1].finding.finding_fingerprint, first.finding_fingerprint);
  assert.equal(view.current[1].decision.status, "confirmed");
});

test("isolates decisions by project ID", () => {
  const finding = makeFinding();
  const store = new Map();
  save(store, finding, "confirmed");

  const otherProject = reconcileDecisions("project-b", [finding], store);
  assert.equal(otherProject.current[0].decision, null);
  assert.equal(otherProject.current[0].review_state, "pending_review");
  assert.deepEqual(otherProject.not_observed, []);
  assert.notEqual(getDecisionKey("project-a", finding.finding_fingerprint), getDecisionKey("project-b", finding.finding_fingerprint));
});

test("finding fingerprint remains stable when supporting evidence changes", () => {
  const blockedTask = task();
  const first = makeFinding({ task: blockedTask, signals: [signal("The supplier approval is still pending.")] });
  const updated = makeFinding({ task: blockedTask, signals: [signal("Supplier approval remains pending.")] });

  assert.equal(first.finding_fingerprint, "blocked_task:T-102");
  assert.equal(first.finding_fingerprint, updated.finding_fingerprint);
});

test("evidence signature is independent of evidence array ordering", () => {
  const first = makeFinding({
    signals: [signal("T-102 approval pending."), signal("T-102 supplier decision pending.", { signal_id: "signal:2" })],
    dependencies: [{ task_id: "T-103" }, { task_id: "T-104" }],
  });
  const reordered = {
    ...first,
    confirmed_evidence: [...first.confirmed_evidence].reverse(),
    dependencies: [...first.dependencies].reverse(),
  };

  assert.equal(getEvidenceSignature(first), getEvidenceSignature(reordered));
});

test("extractor-version-only changes do not invalidate a decision", () => {
  const original = makeFinding();
  const store = new Map();
  save(store, original, "confirmed");
  const updated = {
    ...original,
    confirmed_evidence: original.confirmed_evidence.map((evidence) => evidence.kind === "meeting_signal"
      ? { ...evidence, extractor: { name: "rules", version: "2.0.0" } }
      : evidence),
  };

  const [review] = reconcileDecisions("project-a", [updated], store).current;
  assert.equal(review.review_state, "decided");
  assert.equal(review.decision.status, "confirmed");
});

test("changed evidence requires review for Confirm, Dismiss, and Override decisions", () => {
  for (const status of ["confirmed", "dismissed", "overridden"]) {
    const original = makeFinding();
    const store = new Map();
    const values = status === "dismissed"
      ? { reason: "Handled externally", dismiss_reason_category: "handled_externally" }
      : status === "overridden"
        ? { reason: "Assessment changed", revised_assessment: "Procurement owns the next step." }
        : {};
    const previousDecision = save(store, original, status, values);
    const changed = makeFinding({ signals: [signal("The updated supplier approval remains pending.")] });
    const [review] = reconcileDecisions("project-a", [changed], store).current;

    assert.equal(review.review_state, "review_needed", status);
    assert.equal(review.decision, previousDecision);
    assert.equal(review.decision.status, status);
  }
});

test("identifies added and removed evidence items", () => {
  const original = makeFinding({
    signals: [signal("T-102 approval pending.")],
    dependencies: [{ task_id: "T-103" }],
  });
  const store = new Map();
  save(store, original, "confirmed");
  const updated = makeFinding({
    signals: [signal("Updated: T-102 approval pending.")],
    dependencies: [{ task_id: "T-104" }],
  });
  const [review] = reconcileDecisions("project-a", [updated], store).current;

  assert.equal(review.evidence_changes.added.some((item) => item.kind === "meeting_signal" && item.evidence === "Updated: T-102 approval pending."), true);
  assert.equal(review.evidence_changes.added.some((item) => item.kind === "dependency" && item.task_id === "T-104"), true);
  assert.equal(review.evidence_changes.removed.some((item) => item.kind === "meeting_signal" && item.evidence === "T-102 approval pending."), true);
  assert.equal(review.evidence_changes.removed.some((item) => item.kind === "dependency" && item.task_id === "T-103"), true);
});

test("missing findings are Not observed and are not marked resolved", () => {
  const finding = makeFinding();
  const store = new Map();
  const decision = save(store, finding, "dismissed", {
    reason: "False positive",
    dismiss_reason_category: "false_positive",
  });

  const view = reconcileDecisions("project-a", [], store);
  assert.equal(view.not_observed.length, 1);
  assert.equal(view.not_observed[0].decision, decision);
  assert.equal(view.not_observed[0].observation_state, "not_observed");
  assert.equal(view.not_observed[0].message, NOT_OBSERVED_MESSAGE);
  assert.match(view.not_observed[0].message, /Not in latest data\. Not confirmed resolved\./);
  assert.equal("resolved" in view.not_observed[0], false);
});

test("reappearing finding with unchanged evidence restores its previous decision", () => {
  const finding = makeFinding();
  const store = new Map();
  save(store, finding, "confirmed");
  reconcileDecisions("project-a", [], store);

  const [review] = reconcileDecisions("project-a", [finding], store).current;
  assert.equal(review.review_state, "decided");
  assert.equal(review.decision.status, "confirmed");
});

test("reappearing finding with changed evidence requires review", () => {
  const finding = makeFinding();
  const store = new Map();
  save(store, finding, "confirmed");
  reconcileDecisions("project-a", [], store);

  const changed = makeFinding({ signals: [signal("Updated supplier approval is still pending.")] });
  const [review] = reconcileDecisions("project-a", [changed], store).current;
  assert.equal(review.review_state, "review_needed");
  assert.equal(review.decision.status, "confirmed");
});

test("keeps generated findings and reviewed evidence snapshots unchanged", () => {
  const finding = makeFinding({ dependencies: [{ task_id: "T-103" }] });
  const originalFinding = structuredClone(finding);
  const store = new Map();
  save(store, finding, "overridden", {
    reason: "I assess it differently.",
    suggested_action: "Confirm the approval owner with Procurement.",
  });

  assert.deepEqual(finding, originalFinding);
  const decision = store.get(getDecisionKey("project-a", finding.finding_fingerprint));
  assert.deepEqual(decision.finding_snapshot.confirmed_evidence, originalFinding.confirmed_evidence);
  assert.deepEqual(decision.evidence_snapshot, reconcileDecisions("project-a", [finding], store).current[0].decision.evidence_snapshot);
});
