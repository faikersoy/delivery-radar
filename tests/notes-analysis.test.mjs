import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMeetingNotes, segmentMeetingNotes } from "../src/analysis/notes.mjs";

test("segments non-empty lines and preserves original offsets", () => {
  const notes = "Kickoff\r\n\r\n• API is blocked\n  Owner: unassigned  ";
  const segments = segmentMeetingNotes(notes);

  assert.deepEqual(segments.map(({ text }) => text), ["Kickoff", "• API is blocked", "Owner: unassigned"]);
  for (const segment of segments) {
    assert.equal(notes.slice(segment.start_offset, segment.end_offset), segment.text);
  }
});

test("returns no segments or signals for empty and non-text input", () => {
  assert.deepEqual(segmentMeetingNotes("\n \r\n"), []);
  assert.deepEqual(segmentMeetingNotes(null), []);
  assert.deepEqual(analyzeMeetingNotes(""), { segments: [], signals: [] });
});

test("detects all five supported signal types", () => {
  const result = analyzeMeetingNotes([
    "The API is blocked pending access.",
    "The launch was delayed.",
    "Release depends on legal approval.",
    "This work is unassigned.",
    "A decision is pending.",
  ].join("\n"));

  assert.deepEqual(
    result.signals.map(({ signal_type }) => signal_type),
    ["blocker", "delay", "dependency", "ownership_gap", "pending_decision"],
  );
});

test("detects multiple signal types in one segment", () => {
  const result = analyzeMeetingNotes("Release is blocked and delayed while waiting for legal approval.");

  assert.deepEqual(
    result.signals.map(({ signal_type }) => signal_type),
    ["blocker", "delay", "dependency", "pending_decision"],
  );
  assert.ok(result.signals.every(({ evidence }) => evidence === "Release is blocked and delayed while waiting for legal approval."));
});

test("preserves Unicode evidence and exact source offsets", () => {
  const notes = "🚀 Café launch is blocked by QA.";
  const result = analyzeMeetingNotes(notes);
  const blocker = result.signals.find(({ signal_type }) => signal_type === "blocker");

  assert.ok(blocker);
  assert.equal(blocker.evidence, notes.slice(blocker.start_offset, blocker.end_offset));
  assert.equal(blocker.evidence, notes);
  assert.equal(blocker.start_offset, 0);
  assert.equal(blocker.end_offset, notes.length);
  assert.deepEqual(blocker.source_ref, { source_id: "meeting_notes" });
  assert.deepEqual(blocker.extractor, { name: "delivery-radar-notes-rules", version: "1.0.0" });
});

test("stores normalized content separately from original evidence", () => {
  const notes = "  API BLOCKED  ";
  const [signal] = analyzeMeetingNotes(notes).signals;

  assert.equal(signal.evidence, "API BLOCKED");
  assert.equal(signal.normalized_content, "api blocked");
  assert.notEqual(signal.evidence, signal.normalized_content);
});

test("does not treat an obvious negated blocker as active", () => {
  const result = analyzeMeetingNotes("The API is not blocked.");

  assert.equal(result.signals.some(({ signal_type, state }) => signal_type === "blocker" && state === "active"), false);
});

test("marks explicit blocker and decision resolutions as resolved", () => {
  const result = analyzeMeetingNotes("The blocker is resolved. The decision has been made.");

  assert.deepEqual(
    result.signals.map(({ signal_type, state }) => [signal_type, state]),
    [["blocker", "resolved"], ["pending_decision", "resolved"]],
  );
});

test("detects approval still pending as an active pending decision with exact evidence", () => {
  const notes = "The supplier approval is still pending.";
  const result = analyzeMeetingNotes(notes);

  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].signal_type, "pending_decision");
  assert.equal(result.signals[0].state, "active");
  assert.equal(result.signals[0].evidence, notes);
});

test("does not classify granted or completed approvals as active pending decisions", () => {
  const result = analyzeMeetingNotes("Supplier approval granted. The decision is complete.");
  const pendingDecisions = result.signals.filter(({ signal_type }) => signal_type === "pending_decision");

  assert.deepEqual(pendingDecisions.map(({ state }) => state), ["resolved"]);
  assert.equal(pendingDecisions.some(({ state }) => state === "active"), false);
});

test("marks simultaneous resolved and ongoing blocker evidence as conflicting", () => {
  const result = analyzeMeetingNotes([
    "The blocker is resolved, but it is still blocking release.",
    "The decision is pending, but the decision has been made.",
    "This item is unassigned, but an owner is assigned.",
  ].join("\n"));
  const states = result.signals.map(({ signal_type, state }) => [signal_type, state]);

  assert.deepEqual(states, [
    ["blocker", "conflicting_evidence"],
    ["pending_decision", "conflicting_evidence"],
    ["ownership_gap", "conflicting_evidence"],
  ]);
});

test("marks hedged signals uncertain and leaves unrelated prose unclassified", () => {
  const uncertain = analyzeMeetingNotes("Maybe the integration is blocked.");
  const unrelated = analyzeMeetingNotes("The team had a productive check-in about next quarter.");

  assert.equal(uncertain.signals[0]?.state, "uncertain");
  assert.deepEqual(unrelated.signals, []);
  assert.equal("tasks" in analyzeMeetingNotes("The integration is blocked."), false);
});
