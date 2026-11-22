import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMeetingNotes,
  prepareRelationshipReviewItems,
} from "../src/analysis/claim-pipeline.mjs";

test("classifies independent claims in one note segment without candidate leakage", () => {
  const source = "🚀 Café onboarding is blocked. We discussed lunch plans.";
  const tasks = [{ task_id: "T-101", title: "Café onboarding checklist", status: "Blocked" }];

  const [segment] = classifyMeetingNotes({ source_text: source, tasks, source_id: "notes:test" });

  assert.equal(segment.claims.length, 2);
  const [blockedClaim, unrelatedClaim] = segment.claims;
  const blockedResult = blockedClaim.classification_result;
  const unrelatedResult = unrelatedClaim.classification_result;

  assert.equal(blockedResult.suggestions.length, 1);
  assert.equal(blockedResult.suggestions[0].task_id, "T-101");
  assert.equal(blockedResult.suggestions[0].relationship_type, "blocker");
  assert.equal(blockedResult.abstentions.length, 0);
  const suggestionSpan = blockedResult.suggestions[0].evidence_span;
  assert.equal(source.slice(suggestionSpan.start_offset, suggestionSpan.end_offset), suggestionSpan.text);
  assert.equal(suggestionSpan.text, blockedResult.candidate_result.evidence_span.text);

  assert.deepEqual(unrelatedResult.suggestions, []);
  assert.equal(unrelatedResult.abstentions.length, 1);
  assert.equal(unrelatedResult.abstentions[0].reason, "no_plausible_candidate");

  for (const { evidence_span: span } of [
    blockedResult.candidate_result,
    unrelatedResult.candidate_result,
  ]) {
    assert.equal(source.slice(span.start_offset, span.end_offset), span.text);
  }
  assert.equal(blockedResult.candidate_result.evidence_span.text, "🚀 Café onboarding is blocked");
  assert.equal(blockedResult.candidate_result.evidence_span.start_offset, source.indexOf("🚀"));
});

test("handles empty notes, no retrieved candidates, and ambiguous candidates", () => {
  const tasks = [
    { task_id: "T-101", title: "Supplier onboarding checklist" },
    { task_id: "T-102", title: "Supplier onboarding workflow" },
  ];

  assert.deepEqual(classifyMeetingNotes({ source_text: "\r\n ", tasks }), []);

  const [noCandidateSegment] = classifyMeetingNotes({
    source_text: "We discussed the lunch schedule.",
    tasks: [],
  });
  assert.deepEqual(noCandidateSegment.claims[0].classification_result.suggestions, []);
  assert.equal(noCandidateSegment.claims[0].classification_result.abstentions[0].reason, "no_plausible_candidate");

  const [ambiguousSegment] = classifyMeetingNotes({
    source_text: "Supplier onboarding is moving forward.",
    tasks,
  });
  const ambiguousResult = ambiguousSegment.claims[0].classification_result;
  assert.deepEqual(ambiguousResult.suggestions, []);
  assert.deepEqual(
    ambiguousResult.abstentions.map(({ reason }) => reason),
    ["ambiguous_candidates", "ambiguous_candidates"],
  );
});

test("abstains when task mentions on both sides of an ambiguous conjunction cannot be separated", () => {
  const source = "T-301 is blocked and T-302 is underway.";
  const result = classifyMeetingNotes({
    source_text: source,
    tasks: [
      { task_id: "T-301", title: "Configure the supplier workflow" },
      { task_id: "T-302", title: "Configure the inventory workflow" },
    ],
  });
  const classification = result[0].claims[0].classification_result;

  assert.deepEqual(classification.suggestions, []);
  assert.equal(classification.abstentions.length, 1);
  assert.equal(classification.abstentions[0].reason, "no_plausible_candidate");
  assert.equal(classification.candidate_result.candidates.length, 0);
});

test("is deterministic and does not mutate frozen inputs", () => {
  const source = "Supplier onboarding is blocked. We discussed lunch plans.";
  const tasks = Object.freeze([
    Object.freeze({ task_id: "T-201", title: "Supplier onboarding checklist", status: "Blocked" }),
  ]);
  const input = Object.freeze({
    source_text: source,
    source_id: "notes:stable",
    tasks,
  });
  const before = JSON.stringify(input);

  const first = classifyMeetingNotes(input);
  const second = classifyMeetingNotes(input);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
});

test("prepares fingerprinted review suggestions and separate abstention records", async () => {
  const source = "Supplier onboarding is blocked. We discussed lunch plans.";
  const tasks = [{
    task_id: "T-201",
    title: "Supplier onboarding checklist",
    status: "Blocked",
    owner: "PM",
  }];
  const classified = classifyMeetingNotes({ source_text: source, tasks });

  const prepared = await prepareRelationshipReviewItems(classified, tasks);

  assert.equal(prepared.suggestions.length, 1);
  assert.equal(prepared.suggestions[0].task.task_id, "T-201");
  assert.equal(prepared.suggestions[0].suggestion.relationship_type, "blocker");
  assert.match(prepared.suggestions[0].review_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(prepared.abstentions.length, 1);
  assert.equal(prepared.abstentions[0].reason, "no_plausible_candidate");
  assert.equal(prepared.abstentions[0].task, null);
});
