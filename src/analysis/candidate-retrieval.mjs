import { validateEvidenceSpan } from "./suggestion-contracts.mjs";

const GENERIC_TERMS = new Set([
  "a", "about", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been",
  "before", "being", "between", "both", "but", "by", "can", "could", "did", "do", "does", "during", "each",
  "either", "for", "from", "had", "has", "have", "he", "her", "here", "hers", "him", "his", "how", "i",
  "if", "in", "into", "is", "it", "its", "just", "may", "me", "might", "more", "most", "my", "no", "nor",
  "not", "of", "on", "once", "one", "only", "or", "other", "our", "out", "over", "same", "she", "should",
  "so", "some", "such", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "those", "through", "to", "too", "under", "until", "up", "us", "very", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "will", "with", "would", "you", "your",
  "action", "check", "complete", "delivery", "ensure", "issue", "item", "manage", "meeting", "phase", "plan",
  "process", "project", "review", "status", "support", "system", "task", "team", "update", "work",
]);

/**
 * Retrieve plausible task candidates for caller-identified claims.
 *
 * Input is { source_text, tasks, segments }. Each segment must include its
 * caller-supplied source_ref.source_id and claims; each claim supplies its own
 * claim_id and exact evidence_span. No claim segmentation, source IDs, or
 * offsets are inferred here. Context spans are validated and copied but are
 * deliberately not used for retrieval, so surrounding text cannot promote an
 * unrelated task ID or title match into a candidate.
 *
 * Matching rules are intentionally transparent and have no score, ranking
 * cutoff, or candidate cap:
 * - A standalone imported task ID in the claim's evidence is a retrieval cue.
 * - At least two adjacent, non-generic task-title terms in the original
 *   evidence token sequence are a phrase cue.
 *
 * These cues identify retrieval candidates only; they do not establish a
 * relationship. Inputs are read without mutation and source text is normalized
 * only in temporary matching tokens. Returned source spans remain exact.
 */
export function retrieveTaskCandidates({ source_text: sourceText, tasks, segments } = {}) {
  if (typeof sourceText !== "string") throw new TypeError("source_text must be a string.");
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array.");
  if (!Array.isArray(segments)) throw new TypeError("segments must be an array.");

  validateTasks(tasks);
  const seenSegmentIds = new Set();
  const segmentResults = [];

  for (const [segmentIndex, segment] of segments.entries()) {
    validateSegment(segment, sourceText, segmentIndex);
    if (seenSegmentIds.has(segment.segment_id)) {
      throw new TypeError(`segments[${segmentIndex}].segment_id must be unique.`);
    }
    seenSegmentIds.add(segment.segment_id);

    const seenClaimIds = new Set();
    const claimResults = [];
    for (const [claimIndex, claim] of segment.claims.entries()) {
      const claimPath = `segments[${segmentIndex}].claims[${claimIndex}]`;
      validateClaim(claim, segment, sourceText, claimPath);
      if (seenClaimIds.has(claim.claim_id)) {
        throw new TypeError(`${claimPath}.claim_id must be unique within its segment.`);
      }
      seenClaimIds.add(claim.claim_id);

      claimResults.push({
        claim_id: claim.claim_id,
        candidate_result: makeCandidateResult({ segment, claim, tasks }),
      });
    }
    segmentResults.push({
      source_ref: { source_id: segment.source_ref.source_id },
      segment_id: segment.segment_id,
      claims: claimResults,
    });
  }

  return segmentResults;
}

function validateTasks(tasks) {
  const tasksById = new Map();
  for (const [index, task] of tasks.entries()) {
    if (!isRecord(task) || !isNonEmptyString(task.task_id) || !isNonEmptyString(task.title)) {
      throw new TypeError(`tasks[${index}] must have non-empty task_id and title strings.`);
    }
    if (tasksById.has(task.task_id)) {
      // The existing CSV input contract rejects duplicate task IDs, so direct
      // callers receive the same fail-fast behavior rather than merged records.
      throw new TypeError(`tasks[${index}].task_id duplicates ${task.task_id}.`);
    }
    tasksById.set(task.task_id, task);
  }
  return tasksById;
}

function validateSegment(segment, sourceText, index) {
  const path = `segments[${index}]`;
  if (!isRecord(segment)) throw new TypeError(`${path} must be an object.`);
  if (!isNonEmptyString(segment.segment_id)) throw new TypeError(`${path}.segment_id must be a non-empty string.`);
  if (!isRecord(segment.source_ref) || !isNonEmptyString(segment.source_ref.source_id)) {
    throw new TypeError(`${path}.source_ref.source_id must be supplied as a non-empty string.`);
  }
  const segmentSpan = {
    text: segment.text,
    start_offset: segment.start_offset,
    end_offset: segment.end_offset,
  };
  assertValidSpan(sourceText, segmentSpan, `${path}.text span`);
  if (!Array.isArray(segment.claims)) throw new TypeError(`${path}.claims must be an array.`);
  for (const [claimIndex, claim] of segment.claims.entries()) {
    if (claim === null || typeof claim !== "object") {
      throw new TypeError(`${path}.claims[${claimIndex}] must be an object.`);
    }
  }
}

function validateClaim(claim, segment, sourceText, path) {
  if (!isRecord(claim)) throw new TypeError(`${path} must be an object.`);
  if (!isNonEmptyString(claim.claim_id)) throw new TypeError(`${path}.claim_id must be a non-empty string.`);
  assertValidSpan(sourceText, claim.evidence_span, `${path}.evidence_span`);
  if (claim.evidence_span.start_offset < segment.start_offset
    || claim.evidence_span.end_offset > segment.end_offset) {
    throw new TypeError(`${path}.evidence_span must be contained by its segment span.`);
  }
  const contexts = claim.context_spans ?? [];
  if (!Array.isArray(contexts)) throw new TypeError(`${path}.context_spans must be an array.`);
  for (const [index, span] of contexts.entries()) {
    assertValidSpan(sourceText, span, `${path}.context_spans[${index}]`);
    if (span.start_offset < segment.start_offset || span.end_offset > segment.end_offset) {
      throw new TypeError(`${path}.context_spans[${index}] must be contained by its segment span.`);
    }
  }
}

function assertValidSpan(sourceText, span, field) {
  const result = validateEvidenceSpan(sourceText, span);
  if (!result.valid) {
    const details = result.errors.map(({ field: name, message }) => `${name}: ${message}`).join("; ");
    throw new TypeError(`${field} is invalid (${details}).`);
  }
}

function makeCandidateResult({ segment, claim, tasks }) {
  const evidence = claim.evidence_span.text;
  const evidenceTaskIds = findExplicitTaskIds(evidence, tasks);
  const evidenceTokens = tokenize(evidence);
  const candidates = [];

  // Preserve deterministic candidate ordering independent of task CSV order.
  for (const task of [...tasks].sort((left, right) => compareText(left.task_id, right.task_id))) {
    const methods = [];
    const matchedTerms = new Set();
    const retrievalBasis = [];

    if (evidenceTaskIds.has(task.task_id)) {
      methods.push("explicit_task_id");
      retrievalBasis.push(`Standalone task ID ${task.task_id} occurs in the claim evidence.`);
    }

    const titleTerms = meaningfulTitleTokens(task.title);
    const phraseMatches = matchingTitlePairs(titleTerms, evidenceTokens);
    if (phraseMatches.length > 0) {
      methods.push("title_phrase");
      for (const phrase of phraseMatches) matchedTerms.add(phrase);
      retrievalBasis.push("Adjacent non-generic task-title terms occur adjacent in the original claim-evidence token sequence.");
    }

    if (methods.length === 0) continue;
    candidates.push({
      candidate_id: candidateId(segment.segment_id, claim.claim_id, task.task_id),
      task_id: task.task_id,
      retrieval_methods: methods,
      matched_terms: [...matchedTerms].sort(compareText),
      retrieval_basis: retrievalBasis,
    });
  }

  return {
    source_ref: { source_id: segment.source_ref.source_id },
    segment_id: segment.segment_id,
    claim_id: claim.claim_id,
    evidence_span: copySpan(claim.evidence_span),
    context_spans: (claim.context_spans ?? []).map(copySpan),
    candidates,
  };
}

function findExplicitTaskIds(evidence, tasks) {
  const matches = new Set();
  for (const { task_id: taskId } of tasks) {
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, "u");
    if (pattern.test(evidence)) matches.add(taskId);
  }
  return matches;
}

function matchingTitlePairs(titleTerms, evidenceTerms) {
  const matches = new Set();
  for (let index = 0; index < titleTerms.length - 1; index += 1) {
    const left = titleTerms[index];
    const right = titleTerms[index + 1];
    for (let evidenceIndex = 0; evidenceIndex < evidenceTerms.length - 1; evidenceIndex += 1) {
      if (evidenceTerms[evidenceIndex] === left && evidenceTerms[evidenceIndex + 1] === right) {
        matches.add(`${left} ${right}`);
      }
    }
  }
  return [...matches].sort(compareText);
}

function meaningfulTitleTokens(text) {
  return tokenize(text).filter((term) => !GENERIC_TERMS.has(term));
}

function tokenize(text) {
  return text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function candidateId(segmentId, claimId, taskId) {
  return `candidate:${JSON.stringify([segmentId, claimId, taskId])}`;
}

function copySpan(span) {
  return {
    text: span.text,
    start_offset: span.start_offset,
    end_offset: span.end_offset,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
