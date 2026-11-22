import { retrieveTaskCandidates } from "./candidate-retrieval.mjs";
import {
  classifyTaskRelationships,
  splitEvidenceClauseRanges,
} from "./relationship-classification.mjs";
import { segmentMeetingNotes } from "./notes.mjs";
import { createSuggestionReviewFingerprint } from "./suggestion-contracts.mjs";

export function classifyMeetingNotes({ source_text: sourceText, tasks, source_id: sourceId = "meeting_notes" } = {}) {
  return analyzeMeetingNotesClaims({ source_text: sourceText, tasks, source_id: sourceId }).classified_segments;
}

export function analyzeMeetingNotesClaims({ source_text: sourceText, tasks, source_id: sourceId = "meeting_notes" } = {}) {
  if (typeof sourceText !== "string") throw new TypeError("source_text must be a string.");
  if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
    throw new TypeError("source_id must be a non-empty string.");
  }

  const segments = segmentMeetingNotes(sourceText).map((segment) => ({
    ...segment,
    source_ref: { source_id: sourceId },
    claims: splitEvidenceClauseRanges(segment.text).map((clause) => {
      const start = segment.start_offset + clause.start_offset;
      const end = segment.start_offset + clause.end_offset;
      return {
        claim_id: `claim:${start}:${end}`,
        evidence_span: {
          text: sourceText.slice(start, end),
          start_offset: start,
          end_offset: end,
        },
        context_spans: [{
          text: segment.text,
          start_offset: segment.start_offset,
          end_offset: segment.end_offset,
        }],
      };
    }),
  }));

  const retrievedSegments = retrieveTaskCandidates({
    source_text: sourceText,
    tasks,
    segments,
  });
  const segmentResults = suppressAmbiguousCoordinatedCandidates(retrievedSegments);

  return {
    retrieved_segments: retrievedSegments,
    classified_segments: classifyTaskRelationships({
      segment_results: segmentResults,
      tasks,
      source_text: sourceText,
    }),
  };
}

export async function prepareRelationshipReviewItems(classifiedSegments, tasks) {
  if (!Array.isArray(classifiedSegments)) throw new TypeError("classifiedSegments must be an array.");
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array.");

  const tasksById = new Map(tasks.map((task) => [task.task_id, task]));
  const suggestions = [];
  const abstentions = [];

  for (const segment of classifiedSegments) {
    for (const claim of segment.claims) {
      const { classification_result: result } = claim;
      const candidateResult = result.candidate_result;

      for (const suggestion of result.suggestions) {
        const task = tasksById.get(suggestion.task_id);
        if (!task) throw new Error(`Suggestion references unknown task ${suggestion.task_id}.`);
        const relatedTask = suggestion.related_task_id
          ? tasksById.get(suggestion.related_task_id) ?? null
          : null;
        const sourceId = suggestion.provenance.source_ref.source_id;
        const reviewFingerprint = await createSuggestionReviewFingerprint({
          source_id: sourceId,
          task_id: task.task_id,
          relationship_type: suggestion.relationship_type,
          evidence_span: suggestion.evidence_span,
          relevant_task_fields: {
            title: task.title,
            status: task.status ?? null,
            owner: task.owner ?? null,
            due_date: task.due_date ?? null,
            blocked_by: task.blocked_by ?? [],
            dependency_role: suggestion.dependency_role,
            related_task_id: suggestion.related_task_id,
            related_task_title: relatedTask?.title ?? null,
            evidence_assessment: suggestion.evidence_assessment,
            candidate_ambiguity: suggestion.candidate_ambiguity,
          },
          provenance: suggestion.provenance,
        });
        suggestions.push({
          review_fingerprint: reviewFingerprint,
          suggestion,
          task,
          related_task: relatedTask,
        });
      }

      for (const abstention of result.abstentions) {
        const candidate = candidateResult.candidates.find((item) => item.candidate_id === abstention.candidate_id);
        const task = candidate ? tasksById.get(candidate.task_id) ?? null : null;
        abstentions.push({
          ...abstention,
          segment_id: candidateResult.segment_id,
          evidence_span: candidateResult.evidence_span,
          task,
        });
      }
    }
  }

  return { suggestions, abstentions };
}

function suppressAmbiguousCoordinatedCandidates(segmentResults) {
  return segmentResults.map((segment) => ({
    ...segment,
    claims: segment.claims.map((claim) => {
      const { candidate_result: candidateResult } = claim;
      if (!hasCandidateMentionsAcrossCoordination(candidateResult)) return claim;

      return {
        ...claim,
        candidate_result: { ...candidateResult, candidates: [] },
      };
    }),
  }));
}

function hasCandidateMentionsAcrossCoordination(candidateResult) {
  const { text } = candidateResult.evidence_span;
  const lowerText = text.toLowerCase();
  const candidates = candidateResult.candidates;

  for (const match of lowerText.matchAll(/\b(?:and|or)\b/gi)) {
    let hasCandidateBefore = false;
    let hasCandidateAfter = false;

    for (const candidate of candidates) {
      const index = getCandidateEvidenceIndex(candidate, lowerText);
      if (index >= 0 && index < match.index) hasCandidateBefore = true;
      if (index >= match.index + match[0].length) hasCandidateAfter = true;
    }

    if (hasCandidateBefore && hasCandidateAfter) return true;
  }

  return false;
}

function getCandidateEvidenceIndex(candidate, lowerText) {
  for (const term of candidate.matched_terms ?? []) {
    const index = lowerText.indexOf(term.toLowerCase());
    if (index !== -1) return index;
  }
  return lowerText.indexOf(candidate.task_id.toLowerCase());
}
