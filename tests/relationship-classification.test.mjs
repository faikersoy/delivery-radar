import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCandidateResult,
  classifyTaskRelationships,
} from "../src/analysis/relationship-classification.mjs";
import {
  validateClassificationResult,
  validateRelationshipSuggestion,
} from "../src/analysis/suggestion-contracts.mjs";

function makeCandidateResult({
  sourceId = "meeting-notes-test",
  segmentId = "segment:0:100",
  claimId = "claim:1",
  evidenceText,
  sourceText,
  candidates = [],
  contextSpans = null,
} = {}) {
  const fullSource = sourceText ?? evidenceText;
  const start = fullSource.indexOf(evidenceText);
  assert.notEqual(start, -1, `evidence "${evidenceText}" must be in source "${fullSource}"`);
  const evidenceSpan = {
    text: evidenceText,
    start_offset: start,
    end_offset: start + evidenceText.length,
  };
  const resolvedContext = contextSpans ?? [{
    text: fullSource,
    start_offset: 0,
    end_offset: fullSource.length,
  }];

  return {
    source_ref: { source_id: sourceId },
    segment_id: segmentId,
    claim_id: claimId,
    evidence_span: evidenceSpan,
    context_spans: resolvedContext,
    candidates,
  };
}

const sampleTasks = [
  { task_id: "T-201", title: "Finalize chart of accounts and multi-entity ledger structure", status: "Done" },
  { task_id: "T-202", title: "Cleanse and deduplicate legacy customer master records", status: "Done" },
  { task_id: "T-203", title: "Import customer master records and credit limits into staging", status: "Done" },
  { task_id: "T-204", title: "Complete vendor tax ID and banking compliance verification", status: "Blocked" },
  { task_id: "T-205", title: "Migrate approved supplier catalogs and payment terms", status: "Not Started" },
  { task_id: "T-211", title: "Map real-time stock allocation endpoints to warehouse WMS", status: "In Progress" },
  { task_id: "T-212", title: "Obtain payment gateway production merchant keys and TLS certs", status: "Blocked" },
  { task_id: "T-213", title: "Configure PCI-DSS tokenization and settlement reconciliation feed", status: "Not Started" },
  { task_id: "T-222", title: "Publish standard operating procedures and quick-reference job aids", status: "Done" },
];

test("classifies active progress when evidence indicates ongoing work", () => {
  const source = "I am currently wiring the inventory reservation API calls.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:1",
      task_id: "T-211",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["stock allocation"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.abstentions.length, 0);
  const suggestion = result.suggestions[0];
  assert.equal(suggestion.task_id, "T-211");
  assert.equal(suggestion.relationship_type, "progress");
  assert.equal(suggestion.evidence_assessment, "strong");
  assert.equal(suggestion.candidate_ambiguity, "unique");
  assert.equal(suggestion.dependency_role, null);
  assert.equal(suggestion.related_task_id, null);

  const validation = validateRelationshipSuggestion(suggestion, source);
  assert.equal(validation.valid, true);
});

test("classifies completion when evidence states final sign-off or delivery", () => {
  const source = "The standard operating procedures have been published and signed off.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:2",
      task_id: "T-222",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["standard operating procedures"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.abstentions.length, 0);
  const suggestion = result.suggestions[0];
  assert.equal(suggestion.task_id, "T-222");
  assert.equal(suggestion.relationship_type, "completion");
  assert.equal(suggestion.evidence_assessment, "strong");
  assert.equal(suggestion.dependency_role, null);
  assert.equal(suggestion.related_task_id, null);
});

test("classifies blocker when evidence describes an active impediment halting progress", () => {
  const source = "Missing production credentials prevent the team from starting settlement testing.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:3",
      task_id: "T-212",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["production credentials"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.abstentions.length, 0);
  const suggestion = result.suggestions[0];
  assert.equal(suggestion.task_id, "T-212");
  assert.equal(suggestion.relationship_type, "blocker");
  assert.equal(suggestion.evidence_assessment, "strong");
  assert.equal(suggestion.dependency_role, null);
  assert.equal(suggestion.related_task_id, null);
});

test("classifies dependency with prerequisite role when primary task unblocks a related task", () => {
  const source = "Once Finance locked the entity tree, that unblocks customer master records.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [
      {
        candidate_id: "candidate:T201",
        task_id: "T-201",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["entity tree"],
        retrieval_basis: ["Matched prerequisite"],
      },
      {
        candidate_id: "candidate:T202",
        task_id: "T-202",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["customer master records"],
        retrieval_basis: ["Matched gated work"],
      },
    ],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 2);
  const t201Suggestion = result.suggestions.find((s) => s.task_id === "T-201");
  const t202Suggestion = result.suggestions.find((s) => s.task_id === "T-202");

  assert.ok(t201Suggestion);
  assert.equal(t201Suggestion.relationship_type, "dependency");
  assert.equal(t201Suggestion.dependency_role, "prerequisite");
  assert.equal(t201Suggestion.related_task_id, "T-202");

  assert.ok(t202Suggestion);
  assert.equal(t202Suggestion.relationship_type, "dependency");
  assert.equal(t202Suggestion.dependency_role, "gated_task");
  assert.equal(t202Suggestion.related_task_id, "T-201");
});

test("classifies dependency with gated_task role when prerequisite is external", () => {
  const source = "Settlement testing can start only after external regulatory approval arrives.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:4",
      task_id: "T-213",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["settlement testing"],
      retrieval_basis: ["Matched gated task"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 1);
  const suggestion = result.suggestions[0];
  assert.equal(suggestion.task_id, "T-213");
  assert.equal(suggestion.relationship_type, "dependency");
  assert.equal(suggestion.dependency_role, "gated_task");
  assert.equal(suggestion.related_task_id, null);
});

test("does not pair dependency candidates mentioned in separate clauses", () => {
  const source = "Chart of accounts unblocks customer import. Vendor tax ID depends on external approval.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [
      {
        candidate_id: "candidate:T201",
        task_id: "T-201",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["chart of accounts"],
        retrieval_basis: ["Matched task mention"],
      },
      {
        candidate_id: "candidate:T204",
        task_id: "T-204",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["vendor tax ID"],
        retrieval_basis: ["Matched task mention"],
      },
    ],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(
    result.suggestions.filter((suggestion) => suggestion.related_task_id !== null).length,
    0,
  );
  const externalDependency = result.suggestions.find((suggestion) => suggestion.task_id === "T-204");
  assert.ok(externalDependency);
  assert.equal(externalDependency.relationship_type, "dependency");
  assert.equal(externalDependency.dependency_role, "gated_task");
  assert.equal(externalDependency.related_task_id, null);
});

test("does not pair task candidates when dependency evidence is only shared by the segment", () => {
  const source = "T-204 and T-205 are both awaiting approval.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [
      {
        candidate_id: "candidate:T204",
        task_id: "T-204",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["tax ID"],
        retrieval_basis: ["Matched task mention"],
      },
      {
        candidate_id: "candidate:T205",
        task_id: "T-205",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier catalogs"],
        retrieval_basis: ["Matched task mention"],
      },
    ],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 2);
  assert.deepEqual(
    result.abstentions.map((abstention) => abstention.reason),
    ["insufficient_evidence", "insufficient_evidence"],
  );
});

test("does not infer a task-to-task endpoint from evidence supporting only one external dependency", () => {
  const source = "T-204 depends on external approval, while T-205 remains in the backlog.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [
      {
        candidate_id: "candidate:T204",
        task_id: "T-204",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["tax ID"],
        retrieval_basis: ["Matched task mention"],
      },
      {
        candidate_id: "candidate:T205",
        task_id: "T-205",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier catalogs"],
        retrieval_basis: ["Matched task mention"],
      },
    ],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].task_id, "T-204");
  assert.equal(result.suggestions[0].relationship_type, "dependency");
  assert.equal(result.suggestions[0].dependency_role, "gated_task");
  assert.equal(result.suggestions[0].related_task_id, null);

  assert.equal(result.abstentions.length, 1);
  assert.equal(result.abstentions[0].candidate_id, "candidate:T205");
  assert.equal(result.abstentions[0].reason, "insufficient_evidence");
});

test("returns no_plausible_candidate abstention when candidate list is empty", () => {
  const source = "We had a productive check-in yesterday.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 1);
  assert.equal(result.abstentions[0].reason, "no_plausible_candidate");
  assert.equal(result.abstentions[0].candidate_id, null);
});

test("returns insufficient_evidence abstention when a candidate is mentioned without relationship evidence", () => {
  const source = "Procurement mentioned the supplier catalog migration.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:5",
      task_id: "T-205",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["supplier catalog"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 1);
  assert.equal(result.abstentions[0].reason, "insufficient_evidence");
  assert.equal(result.abstentions[0].candidate_id, "candidate:5");
});

test("abstains with ambiguous_candidates when multiple candidates cannot be distinguished", () => {
  const source = "The supplier onboarding items are moving forward.";
  const tasks = [
    { task_id: "T-101", title: "Supplier onboarding checklist" },
    { task_id: "T-102", title: "Supplier onboarding workflow" },
  ];
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [
      {
        candidate_id: "candidate:101",
        task_id: "T-101",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier onboarding"],
        retrieval_basis: ["Matched title phrase"],
      },
      {
        candidate_id: "candidate:102",
        task_id: "T-102",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier onboarding"],
        retrieval_basis: ["Matched title phrase"],
      },
    ],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 2);
  assert.equal(result.abstentions[0].reason, "ambiguous_candidates");
  assert.equal(result.abstentions[1].reason, "ambiguous_candidates");
});

test("discriminates between candidates when evidence contains a discriminating title term", () => {
  const source = "The supplier onboarding checklist is currently underway.";
  const tasks = [
    { task_id: "T-101", title: "Supplier onboarding checklist" },
    { task_id: "T-102", title: "Supplier onboarding workflow" },
  ];
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [
      {
        candidate_id: "candidate:101",
        task_id: "T-101",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier onboarding"],
        retrieval_basis: ["Matched title phrase"],
      },
      {
        candidate_id: "candidate:102",
        task_id: "T-102",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier onboarding"],
        retrieval_basis: ["Matched title phrase"],
      },
    ],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].task_id, "T-101");
  assert.equal(result.suggestions[0].relationship_type, "progress");

  assert.equal(result.abstentions.length, 1);
  assert.equal(result.abstentions[0].candidate_id, "candidate:102");
  assert.equal(result.abstentions[0].reason, "insufficient_evidence");
});

test("does not discriminate using a title token found only in unrelated text", () => {
  const source = "Supplier onboarding is currently underway. The workflow dashboard is configured.";
  const tasks = [
    { task_id: "T-101", title: "Supplier onboarding checklist" },
    { task_id: "T-102", title: "Supplier onboarding workflow" },
  ];
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [
      {
        candidate_id: "candidate:101",
        task_id: "T-101",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier onboarding"],
        retrieval_basis: ["Matched title phrase"],
      },
      {
        candidate_id: "candidate:102",
        task_id: "T-102",
        retrieval_methods: ["title_phrase"],
        matched_terms: ["supplier onboarding"],
        retrieval_basis: ["Matched title phrase"],
      },
    ],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 2);
  assert.deepEqual(
    result.abstentions.map((abstention) => abstention.reason),
    ["ambiguous_candidates", "ambiguous_candidates"],
  );
});

test("negative contrast: staging is not completion", () => {
  const source = "The standard operating procedures are in staging for review.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:222",
      task_id: "T-222",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["standard operating procedures"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 1);
  assert.equal(result.abstentions[0].reason, "insufficient_evidence");
});

test("negative contrast: future requirement is not an active blocker", () => {
  const source = "Production credentials will be needed before the next phase.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:212",
      task_id: "T-212",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["production credentials"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 1);
  assert.equal(result.abstentions[0].reason, "insufficient_evidence");
});

test("negative contrast: negated blocker is not active blocker", () => {
  const source = "The team is no longer blocked on production credentials.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:212",
      task_id: "T-212",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["production credentials"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(result.suggestions.length, 0);
  assert.equal(result.abstentions.length, 1);
});

test("hedged evidence yields uncertain assessment and does not emit conflict", () => {
  const source = "It might be that inventory reservation wiring is underway, but not sure if complete.";
  const candidateResult = makeCandidateResult({
    evidenceText: source,
    candidates: [{
      candidate_id: "candidate:211",
      task_id: "T-211",
      retrieval_methods: ["title_phrase"],
      matched_terms: ["inventory reservation"],
      retrieval_basis: ["Matched title phrase"],
    }],
  });

  const result = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: sampleTasks,
    source_text: source,
  });

  for (const suggestion of result.suggestions) {
    assert.notEqual(suggestion.relationship_type, "conflict");
    assert.equal(suggestion.evidence_assessment, "uncertain");
  }
});

test("multiple independent claims in one segment preserve claim isolation", () => {
  const source = "Inventory API work is underway. We discussed lunch plans.";
  const claim1Text = "Inventory API work is underway.";
  const claim2Text = "We discussed lunch plans.";

  const segResults = [
    {
      source_ref: { source_id: "meeting-notes-test" },
      segment_id: "segment:0",
      claims: [
        {
          claim_id: "claim:1",
          candidate_result: makeCandidateResult({
            claimId: "claim:1",
            evidenceText: claim1Text,
            sourceText: source,
            candidates: [{
              candidate_id: "candidate:211",
              task_id: "T-211",
              retrieval_methods: ["title_phrase"],
              matched_terms: ["inventory api"],
              retrieval_basis: ["Matched title phrase"],
            }],
          }),
        },
        {
          claim_id: "claim:2",
          candidate_result: makeCandidateResult({
            claimId: "claim:2",
            evidenceText: claim2Text,
            sourceText: source,
            candidates: [],
          }),
        },
      ],
    },
  ];

  const classified = classifyTaskRelationships({
    segment_results: segResults,
    tasks: sampleTasks,
    source_text: source,
  });

  assert.equal(classified.length, 1);
  const claims = classified[0].claims;
  assert.equal(claims.length, 2);

  // Claim 1 has progress suggestion
  assert.equal(claims[0].claim_id, "claim:1");
  assert.equal(claims[0].classification_result.suggestions.length, 1);
  assert.equal(claims[0].classification_result.suggestions[0].relationship_type, "progress");
  assert.equal(claims[0].classification_result.abstentions.length, 0);

  // Claim 2 has no_plausible_candidate abstention
  assert.equal(claims[1].claim_id, "claim:2");
  assert.equal(claims[1].classification_result.suggestions.length, 0);
  assert.equal(claims[1].classification_result.abstentions.length, 1);
  assert.equal(claims[1].classification_result.abstentions[0].reason, "no_plausible_candidate");
});

test("inputs are not mutated and classification is deterministic", () => {
  const source = "The inventory API work is underway.";
  const candidateResult = Object.freeze(makeCandidateResult({
    evidenceText: source,
    candidates: Object.freeze([Object.freeze({
      candidate_id: "candidate:211",
      task_id: "T-211",
      retrieval_methods: Object.freeze(["title_phrase"]),
      matched_terms: Object.freeze(["inventory api"]),
      retrieval_basis: Object.freeze(["Matched title phrase"]),
    })]),
  }));
  const frozenTasks = Object.freeze(sampleTasks.map((t) => Object.freeze({ ...t })));

  const firstRun = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: frozenTasks,
    source_text: source,
  });
  const secondRun = classifyCandidateResult({
    candidate_result: candidateResult,
    tasks: frozenTasks,
    source_text: source,
  });

  assert.deepEqual(firstRun, secondRun);
  const validation = validateClassificationResult(firstRun, source);
  assert.equal(validation.valid, true);
});
