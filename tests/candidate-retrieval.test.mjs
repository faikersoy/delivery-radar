import assert from "node:assert/strict";
import test from "node:test";
import { retrieveTaskCandidates } from "../src/analysis/candidate-retrieval.mjs";

function makeSegment(sourceText, claims, { sourceId = "meeting-notes-demo", segmentId = "segment:0" } = {}) {
  return {
    segment_id: segmentId,
    source_ref: { source_id: sourceId },
    start_offset: 0,
    end_offset: sourceText.length,
    text: sourceText,
    claims,
  };
}

function makeClaim(sourceText, evidenceText, claimId = "claim:1", contextSpans = []) {
  const start = sourceText.indexOf(evidenceText);
  assert.notEqual(start, -1, `test evidence must exist in source: ${evidenceText}`);
  return {
    claim_id: claimId,
    evidence_span: {
      text: evidenceText,
      start_offset: start,
      end_offset: start + evidenceText.length,
    },
    context_spans: contextSpans,
  };
}

function retrieve(sourceText, tasks, claims, options) {
  return retrieveTaskCandidates({
    source_text: sourceText,
    tasks,
    segments: [makeSegment(sourceText, claims, options)],
  }).flatMap(({ claims: claimResults }) => claimResults.map(({ candidate_result }) => candidate_result));
}

test("retrieves a clear title match without an explicit task ID", () => {
  const source = "Supplier onboarding is moving forward.";
  const [result] = retrieve(source, [
    { task_id: "T-101", title: "Supplier onboarding checklist", status: "Open" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.source_ref, { source_id: "meeting-notes-demo" });
  assert.equal(result.segment_id, "segment:0");
  assert.equal(result.claim_id, "claim:1");
  assert.deepEqual(result.candidates.map(({ task_id }) => task_id), ["T-101"]);
  assert.ok(result.candidates[0].retrieval_methods.includes("title_phrase"));
  assert.ok(result.candidates[0].matched_terms.includes("supplier onboarding"));
  assert.equal("relationship_type" in result.candidates[0], false);
});

test("returns multiple plausible candidates for one claim without imposing a cap", () => {
  const source = "Supplier onboarding is moving forward.";
  const [result] = retrieve(source, [
    { task_id: "T-102", title: "Supplier onboarding workflow" },
    { task_id: "T-101", title: "Supplier onboarding checklist" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates.map(({ task_id }) => task_id), ["T-101", "T-102"]);
});

test("returns an empty candidate list when no plausible title or ID cue exists", () => {
  const source = "We discussed the quarterly lunch schedule.";
  const [result] = retrieve(source, [
    { task_id: "T-101", title: "Configure supplier payment gateway" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates, []);
  assert.equal("no_link_reason" in result, false);
});

test("recognizes an imported task ID as a deterministic retrieval cue", () => {
  const source = "T-101 was discussed during the update.";
  const [result] = retrieve(source, [
    { task_id: "T-101", title: "Configure supplier payment gateway" },
  ], [makeClaim(source, source)]);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].task_id, "T-101");
  assert.deepEqual(result.candidates[0].retrieval_methods, ["explicit_task_id"]);
});

test("does not promote a task ID found only in surrounding context", () => {
  const source = "T-101 was mentioned in unrelated lunch notes. We discussed the catering menu.";
  const evidence = "We discussed the catering menu.";
  const contextStart = 0;
  const claim = makeClaim(source, evidence, "claim:1", [{
    text: source,
    start_offset: contextStart,
    end_offset: source.length,
  }]);
  const [result] = retrieve(source, [
    { task_id: "T-101", title: "Configure supplier payment gateway" },
  ], [claim]);

  assert.deepEqual(result.candidates, []);
  assert.equal(result.context_spans[0].text, source);
});

test("generic shared project words alone do not create candidates", () => {
  const source = "The project status update review is complete.";
  const [result] = retrieve(source, [
    { task_id: "T-201", title: "Review project plan" },
    { task_id: "T-202", title: "Update project status" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates, []);
});

test("does not retrieve the supplier newsletter false-positive from one shared title term", () => {
  const source = "The supplier newsletter arrived this morning.";
  const [result] = retrieve(source, [
    { task_id: "T-201", title: "Approve supplier renewal" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates, []);
});

test("a single unique title term without a second adjacent match is insufficient", () => {
  const source = "Tokenization was briefly mentioned.";
  const [result] = retrieve(source, [
    { task_id: "T-202", title: "Prepare tokenization controls" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates, []);
});

test("matches two meaningful title terms adjacent in the original evidence", () => {
  const source = "Supplier onboarding is delayed.";
  const [result] = retrieve(source, [
    { task_id: "T-203", title: "supplier onboarding" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates.map(({ task_id }) => task_id), ["T-203"]);
  assert.deepEqual(result.candidates[0].matched_terms, ["supplier onboarding"]);
});

test("does not bridge a generic word between otherwise matching title terms", () => {
  const source = "Supplier and onboarding were discussed.";
  const [result] = retrieve(source, [
    { task_id: "T-204", title: "supplier onboarding" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates, []);
});

test("matches a multi-word title phrase in evidence", () => {
  const source = "The vendor onboarding process is moving.";
  const [result] = retrieve(source, [
    { task_id: "T-203", title: "Configure vendor onboarding workflow" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates.map(({ task_id }) => task_id), ["T-203"]);
  assert.ok(result.candidates[0].matched_terms.includes("vendor onboarding"));
});

test("preserves exact evidence text and end-exclusive source offsets", () => {
  const source = "🚚 Café supplier onboarding is moving forward. Later notes follow.";
  const evidence = "Café supplier onboarding is moving forward.";
  const [result] = retrieve(source, [
    { task_id: "T-204", title: "Café supplier onboarding" },
  ], [makeClaim(source, evidence)]);

  assert.equal(result.evidence_span.text, evidence);
  assert.equal(source.slice(result.evidence_span.start_offset, result.evidence_span.end_offset), evidence);
  assert.equal(result.evidence_span.start_offset, source.indexOf(evidence));
  assert.equal(result.evidence_span.end_offset, source.indexOf(evidence) + evidence.length);
});

test("copies context spans separately and does not use them to retrieve candidates", () => {
  const source = "T-205 belongs to another topic. We discussed the room booking.";
  const evidence = "We discussed the room booking.";
  const claim = makeClaim(source, evidence, "claim:1", [{
    text: "T-205 belongs to another topic.",
    start_offset: 0,
    end_offset: "T-205 belongs to another topic.".length,
  }]);
  const [result] = retrieve(source, [
    { task_id: "T-205", title: "Migrate supplier catalog" },
  ], [claim]);

  assert.deepEqual(result.evidence_span, claim.evidence_span);
  assert.deepEqual(result.context_spans, claim.context_spans);
  assert.deepEqual(result.candidates, []);
});

test("keeps separate claims in one segment and allows different candidate outcomes", () => {
  const source = "Supplier onboarding is underway. We discussed lunch plans.";
  const first = makeClaim(source, "Supplier onboarding is underway.", "claim:1");
  const second = makeClaim(source, "We discussed lunch plans.", "claim:2");
  const [group] = retrieveTaskCandidates({
    source_text: source,
    tasks: [{ task_id: "T-206", title: "Supplier onboarding checklist" }],
    segments: [makeSegment(source, [first, second])],
  });
  const results = group.claims.map(({ candidate_result }) => candidate_result);

  assert.equal(group.segment_id, "segment:0");
  assert.deepEqual(results.map(({ claim_id }) => claim_id), ["claim:1", "claim:2"]);
  assert.deepEqual(results.map(({ candidates }) => candidates.map(({ task_id }) => task_id)), [["T-206"], []]);
});

test("does not mutate tasks, notes, segments, or claims", () => {
  const source = "Supplier onboarding is blocked pending access.";
  const tasks = Object.freeze([Object.freeze({
    task_id: "T-207",
    title: "Supplier onboarding checklist",
    status: "Blocked",
    blocked_by: Object.freeze(["T-206"]),
  })]);
  const claim = Object.freeze(makeClaim(source, source));
  const segment = Object.freeze(makeSegment(source, Object.freeze([claim])));
  const input = Object.freeze({ source_text: source, tasks, segments: Object.freeze([segment]) });
  const before = JSON.stringify(input);

  const results = retrieveTaskCandidates(input);

  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(
    results[0].claims[0].candidate_result.candidates.map(({ task_id }) => task_id),
    ["T-207"],
  );
});

test("returns deterministic results for repeated runs", () => {
  const source = "Supplier onboarding is moving.";
  const input = {
    source_text: source,
    tasks: [
      { task_id: "T-209", title: "Supplier onboarding workflow" },
      { task_id: "T-208", title: "Supplier onboarding checklist" },
    ],
    segments: [makeSegment(source, [makeClaim(source, source)])],
  };

  assert.deepEqual(retrieveTaskCandidates(input), retrieveTaskCandidates(input));
});

test("handles empty tasks, empty claims, and empty segments", () => {
  const source = "Supplier onboarding is underway.";
  const claim = makeClaim(source, source);
  const noTasks = retrieve(source, [], [claim]);
  const noClaims = retrieveTaskCandidates({
    source_text: source,
    tasks: [{ task_id: "T-210", title: "Supplier onboarding" }],
    segments: [makeSegment(source, [])],
  });
  const noSegments = retrieveTaskCandidates({ source_text: source, tasks: [], segments: [] });

  assert.deepEqual(noTasks[0].candidates, []);
  assert.deepEqual(noClaims[0].claims, []);
  assert.deepEqual(noSegments, []);
});

test("rejects malformed segment and evidence source spans", () => {
  const source = "Supplier onboarding is underway.";
  const claim = makeClaim(source, source);
  const valid = makeSegment(source, [claim]);

  assert.throws(() => retrieveTaskCandidates({
    source_text: source,
    tasks: [],
    segments: [{ ...valid, end_offset: source.length + 1 }],
  }), /segments\[0\]\.text span is invalid/);
  assert.throws(() => retrieveTaskCandidates({
    source_text: source,
    tasks: [],
    segments: [makeSegment(source, [{ ...claim, evidence_span: { ...claim.evidence_span, text: "altered" } }])],
  }), /evidence_span is invalid/);
  assert.throws(() => retrieveTaskCandidates({
    source_text: source,
    tasks: [],
    segments: [{
      ...makeSegment(source, [claim]),
      start_offset: 1,
      text: source.slice(1),
    }],
  }), /evidence_span must be contained by its segment span/);
});

test("rejects duplicate task IDs according to the CSV input contract", () => {
  const source = "Supplier onboarding is underway.";
  assert.throws(() => retrieve(source, [
    { task_id: "T-211", title: "Supplier onboarding checklist" },
    { task_id: "T-211", title: "Supplier onboarding workflow" },
  ], [makeClaim(source, source)]), /duplicates T-211/);
});

test("returns candidate-only records without relationship or finding fields", () => {
  const source = "Supplier onboarding is moving.";
  const [result] = retrieve(source, [
    { task_id: "T-212", title: "Supplier onboarding checklist", status: "Blocked" },
  ], [makeClaim(source, source)]);
  const forbidden = [
    "relationship_type", "relationship", "suggestion", "suggestions", "evidence_assessment",
    "confidence", "no_link_reason", "abstention", "finding", "findings", "risk",
  ];

  assert.deepEqual(result.candidates.map(({ task_id }) => task_id), ["T-212"]);
  for (const field of forbidden) assert.equal(field in result, false, `unexpected result field: ${field}`);
  for (const candidate of result.candidates) {
    for (const field of forbidden) assert.equal(field in candidate, false, `unexpected candidate field: ${field}`);
  }
});

test("task ID matching requires an exact identifier boundary", () => {
  const source = "T-10 is in the unrelated agenda.";
  const [result] = retrieve(source, [
    { task_id: "T-1", title: "Prepare supplier onboarding" },
    { task_id: "T-10", title: "Configure warehouse routing" },
  ], [makeClaim(source, source)]);

  assert.deepEqual(result.candidates.map(({ task_id }) => task_id), ["T-10"]);
});
