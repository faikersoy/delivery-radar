import assert from "node:assert/strict";
import test from "node:test";
import {
  createSuggestionReviewFingerprint,
  validateEvidenceSpan,
  validateRelationshipSuggestion,
  validateSuggestionContract,
} from "../src/analysis/suggestion-contracts.mjs";

const sourceText = "The inventory API work is underway.";
const evidenceText = "inventory API work is underway";
const evidenceStart = sourceText.indexOf(evidenceText);

function makeSuggestion(overrides = {}) {
  return {
    suggestion_id: "suggestion:1",
    candidate_id: "candidate:1",
    claim_id: "claim:1",
    segment_id: "segment:0:36",
    task_id: "T-211",
    relationship_type: "progress",
    evidence_assessment: "strong",
    candidate_ambiguity: "unique",
    evidence_span: {
      text: evidenceText,
      start_offset: evidenceStart,
      end_offset: evidenceStart + evidenceText.length,
    },
    context_span: { text: sourceText, start_offset: 0, end_offset: sourceText.length },
    rationale: "The source says this work is underway.",
    related_task_id: null,
    dependency_role: null,
    provenance: {
      method: "deterministic_rules",
      provider: null,
      model: null,
      prompt_version: null,
      extractor_version: "implicit-linking-v1",
      source_ref: { source_id: "meeting-notes-a" },
    },
    ...overrides,
  };
}

function makeFingerprintInput(overrides = {}) {
  return {
    source_id: "meeting-notes-a",
    task_id: "T-211",
    relationship_type: "progress",
    evidence_span: {
      text: evidenceText,
      start_offset: evidenceStart,
      end_offset: evidenceStart + evidenceText.length,
    },
    context_spans: [{
      text: sourceText,
      start_offset: 0,
      end_offset: sourceText.length,
      consumed_by_classification: true,
    }],
    relevant_task_fields: { title: "Map inventory API endpoints", blocked_by: ["T-206"] },
    provenance: {
      provider: null,
      model: null,
      extractor_version: "v1",
      source_ref: { source_id: "meeting-notes-a" },
    },
    line_number: 4,
    ...overrides,
  };
}

function hasFieldError(result, field) {
  return result.errors.some((error) => error.field === field);
}

test("accepts a complete valid relationship suggestion with exact source spans", () => {
  const result = validateRelationshipSuggestion(makeSuggestion(), sourceText);

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects an unsupported relationship type", () => {
  const result = validateSuggestionContract(makeSuggestion({ relationship_type: "conflict" }));

  assert.equal(result.valid, false);
  assert.ok(hasFieldError(result, "relationship_type"));
});

test("rejects missing required suggestion and provenance fields", () => {
  const suggestion = makeSuggestion();
  delete suggestion.rationale;
  delete suggestion.provenance.method;
  const result = validateSuggestionContract(suggestion);

  assert.equal(result.valid, false);
  assert.ok(hasFieldError(result, "rationale"));
  assert.ok(hasFieldError(result, "provenance.method"));
});

test("a prerequisite primary task points to the related gated task", () => {
  const missingRole = validateSuggestionContract(makeSuggestion({ relationship_type: "dependency" }));
  const missingEndpoint = validateSuggestionContract(makeSuggestion({
    relationship_type: "dependency",
    dependency_role: "prerequisite",
  }));
  const supported = makeSuggestion({
    task_id: "T-212",
    related_task_id: "T-213",
    relationship_type: "dependency",
    dependency_role: "prerequisite",
  });
  const valid = validateSuggestionContract(supported);

  assert.ok(hasFieldError(missingRole, "dependency_role"));
  assert.ok(hasFieldError(missingEndpoint, "related_task_id"));
  assert.equal(valid.valid, true);
  assert.equal(supported.task_id, "T-212");
  assert.equal(supported.related_task_id, "T-213");
});

test("a primary gated task points to its related prerequisite", () => {
  const suggestion = makeSuggestion({
    task_id: "T-213",
    related_task_id: "T-212",
    relationship_type: "dependency",
    dependency_role: "gated_task",
  });
  const result = validateSuggestionContract(suggestion);

  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(suggestion.task_id, "T-213");
  assert.equal(suggestion.related_task_id, "T-212");
});

test("accepts a gated imported task with an external prerequisite and no related task ID", () => {
  const result = validateSuggestionContract(makeSuggestion({
    relationship_type: "dependency",
    dependency_role: "gated_task",
    related_task_id: null,
  }));

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("accepts a supported two-task dependency and rejects dependency fields on other types", () => {
  const dependency = validateSuggestionContract(makeSuggestion({
    relationship_type: "dependency",
    dependency_role: "prerequisite",
    related_task_id: "T-213",
  }));
  const irrelevantFields = validateSuggestionContract(makeSuggestion({
    related_task_id: "T-213",
    dependency_role: "gated_task",
  }));
  const sameEndpoint = validateSuggestionContract(makeSuggestion({
    relationship_type: "dependency",
    dependency_role: "gated_task",
    related_task_id: "T-211",
  }));

  assert.equal(dependency.valid, true);
  assert.ok(hasFieldError(irrelevantFields, "dependency_role"));
  assert.ok(hasFieldError(sameEndpoint, "related_task_id"));
});

test("accepts an exact end-exclusive source span", () => {
  assert.deepEqual(validateEvidenceSpan(sourceText, makeSuggestion().evidence_span), { valid: true, errors: [] });
});

test("rejects evidence text that differs from the exact source slice", () => {
  const result = validateEvidenceSpan(sourceText, { ...makeSuggestion().evidence_span, text: "inventory endpoints are underway" });

  assert.equal(result.valid, false);
  assert.ok(hasFieldError(result, "text"));
});

test("rejects negative, reversed, and out-of-bounds offsets", () => {
  const span = makeSuggestion().evidence_span;
  const negative = validateEvidenceSpan(sourceText, { ...span, start_offset: -1 });
  const reversed = validateEvidenceSpan(sourceText, { ...span, start_offset: 10, end_offset: 9 });
  const outOfBounds = validateEvidenceSpan(sourceText, { ...span, end_offset: sourceText.length + 1 });

  assert.equal(negative.valid, false);
  assert.ok(hasFieldError(negative, "start_offset"));
  assert.equal(reversed.valid, false);
  assert.ok(hasFieldError(reversed, "end_offset"));
  assert.equal(outOfBounds.valid, false);
  assert.ok(hasFieldError(outOfBounds, "end_offset"));
});

test("rejects missing source text and zero-length spans", () => {
  assert.equal(validateEvidenceSpan(null, makeSuggestion().evidence_span).valid, false);
  assert.equal(validateEvidenceSpan(sourceText, { text: "", start_offset: 0, end_offset: 0 }).valid, false);
});

test("uses Web Crypto SHA-256 and returns a deterministic hexadecimal fingerprint", async () => {
  const first = await createSuggestionReviewFingerprint(makeFingerprintInput());
  const second = await createSuggestionReviewFingerprint(makeFingerprintInput());

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("requires the fingerprint source ID to match its provenance source reference", async () => {
  const matching = await createSuggestionReviewFingerprint(makeFingerprintInput());
  assert.match(matching, /^[0-9a-f]{64}$/);

  await assert.rejects(
    createSuggestionReviewFingerprint(makeFingerprintInput({
      provenance: { source_ref: { source_id: "different-source" } },
    })),
    /provenance\.source_ref\.source_id must match source_id/,
  );
});

test("source identity remains separate from suggestion IDs", async () => {
  const first = makeFingerprintInput({ suggestion_id: "suggestion-a" });
  const second = makeFingerprintInput({ suggestion_id: "suggestion-b" });

  assert.equal(
    await createSuggestionReviewFingerprint(first),
    await createSuggestionReviewFingerprint(second),
  );
});

test("fingerprint is independent of object property order", async () => {
  const firstInput = makeFingerprintInput({ relevant_task_fields: { title: "API delivery", blocked_by: ["T-206"] } });
  const secondInput = makeFingerprintInput({ relevant_task_fields: { blocked_by: ["T-206"], title: "API delivery" } });

  assert.equal(
    await createSuggestionReviewFingerprint(firstInput),
    await createSuggestionReviewFingerprint(secondInput),
  );
});

test("changing offsets alone does not change the fingerprint", async () => {
  const changedOffsets = makeFingerprintInput({
    evidence_span: { text: evidenceText, start_offset: 900, end_offset: 900 + evidenceText.length },
    context_spans: [{
      text: sourceText,
      start_offset: 800,
      end_offset: 800 + sourceText.length,
      consumed_by_classification: true,
    }],
  });

  assert.equal(
    await createSuggestionReviewFingerprint(makeFingerprintInput()),
    await createSuggestionReviewFingerprint(changedOffsets),
  );
});

test("offset, line number, and formatting-only changes do not change the fingerprint", async () => {
  const formatted = makeFingerprintInput({
    evidence_span: { text: "  inventory API work\n is underway  ", start_offset: 500, end_offset: 530 },
    context_spans: [{ text: "	The inventory API work is underway.  ", start_offset: 500, end_offset: 540, consumed_by_classification: true }],
    relevant_task_fields: { title: " Map inventory API endpoints ", blocked_by: ["T-206"] },
    line_number: 99,
  });

  assert.equal(
    await createSuggestionReviewFingerprint(makeFingerprintInput()),
    await createSuggestionReviewFingerprint(formatted),
  );
});

test("provider, model, prompt, and extractor version changes do not change the fingerprint", async () => {
  const changedProvenance = makeFingerprintInput({
    provenance: {
      provider: "future-provider",
      model: "future-model",
      prompt_version: "p9",
      extractor_version: "v8",
      source_ref: { source_id: "meeting-notes-a" },
    },
  });

  assert.equal(
    await createSuggestionReviewFingerprint(makeFingerprintInput()),
    await createSuggestionReviewFingerprint(changedProvenance),
  );
});

test("semantic evidence changes the fingerprint", async () => {
  const changed = makeFingerprintInput({ evidence_span: { text: "inventory API work is complete" } });

  assert.notEqual(
    await createSuggestionReviewFingerprint(makeFingerprintInput()),
    await createSuggestionReviewFingerprint(changed),
  );
});

test("consumed context changes the fingerprint, but unused context is excluded", async () => {
  const base = makeFingerprintInput({ context_spans: [
    { text: "Context A", start_offset: 50, end_offset: 59, consumed_by_classification: true },
    { text: "unused A", consumed_by_classification: false },
  ] });
  const changedConsumed = makeFingerprintInput({ context_spans: [
    { text: "Context B", start_offset: 50, end_offset: 59, consumed_by_classification: true },
    { text: "unused A", consumed_by_classification: false },
  ] });
  const changedUnused = makeFingerprintInput({ context_spans: [
    { text: "Context A", start_offset: 50, end_offset: 59, consumed_by_classification: true },
    { text: "unused B", consumed_by_classification: false },
  ] });
  const baseFingerprint = await createSuggestionReviewFingerprint(base);

  assert.notEqual(baseFingerprint, await createSuggestionReviewFingerprint(changedConsumed));
  assert.equal(baseFingerprint, await createSuggestionReviewFingerprint(changedUnused));
});

test("context presentation order does not change the fingerprint, but source order does", async () => {
  const first = makeFingerprintInput({ context_spans: [
    { text: "Earlier claim", start_offset: 0, end_offset: 13, consumed_by_classification: true },
    { text: "Later claim", start_offset: 20, end_offset: 31, consumed_by_classification: true },
  ] });
  const presentationReordered = makeFingerprintInput({ context_spans: [
    { text: "Later claim", start_offset: 20, end_offset: 31, consumed_by_classification: true },
    { text: "Earlier claim", start_offset: 0, end_offset: 13, consumed_by_classification: true },
  ] });
  const sourceReordered = makeFingerprintInput({ context_spans: [
    { text: "Earlier claim", start_offset: 20, end_offset: 33, consumed_by_classification: true },
    { text: "Later claim", start_offset: 0, end_offset: 11, consumed_by_classification: true },
  ] });

  const fingerprint = await createSuggestionReviewFingerprint(first);
  assert.equal(fingerprint, await createSuggestionReviewFingerprint(presentationReordered));
  assert.notEqual(fingerprint, await createSuggestionReviewFingerprint(sourceReordered));
});

test("a relevant task field changes the fingerprint", async () => {
  const changed = makeFingerprintInput({ relevant_task_fields: { title: "Configure warehouse API", blocked_by: ["T-206"] } });

  assert.notEqual(
    await createSuggestionReviewFingerprint(makeFingerprintInput()),
    await createSuggestionReviewFingerprint(changed),
  );
});

test("relationship type changes the review fingerprint", async () => {
  const changed = makeFingerprintInput({ relationship_type: "completion" });

  assert.notEqual(
    await createSuggestionReviewFingerprint(makeFingerprintInput()),
    await createSuggestionReviewFingerprint(changed),
  );
});

test("rejects unsupported semantic fingerprint inputs", async () => {
  await assert.rejects(
    createSuggestionReviewFingerprint(makeFingerprintInput({ context_spans: [{ text: "Unspecified" }] })),
    /must identify whether classification consumed it/,
  );
  await assert.rejects(
    createSuggestionReviewFingerprint(makeFingerprintInput({ relevant_task_fields: { bad: undefined } })),
    /JSON-compatible/,
  );
});

test("rejects non-plain objects and unsupported JSON values during canonicalization", async () => {
  class TaskFields {
    constructor() { this.title = "API work"; }
  }
  class TaskFieldList extends Array {}
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse[1] = "gap";
  const symbolKeyed = { title: "API work", [Symbol("hidden")]: "value" };
  const accessor = Object.defineProperty({}, "title", { enumerable: true, get: () => "API work" });
  const unsupported = [
    new Date(),
    new Map([ ["title", "API work"] ]),
    new Set(["API work"]),
    new TaskFields(),
    undefined,
    () => "API work",
    Symbol("API work"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1n,
    /api/i,
    new Uint8Array([1, 2]),
    new TaskFieldList("API work"),
    cyclic,
    sparse,
    symbolKeyed,
    accessor,
    Object.defineProperty({ title: "API work" }, "hidden", { value: "value", enumerable: false }),
  ];

  for (const value of unsupported) {
    await assert.rejects(
      createSuggestionReviewFingerprint(makeFingerprintInput({ relevant_task_fields: { value } })),
      { name: "TypeError" },
    );
  }
});
