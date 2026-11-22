import {
  validateRelationshipSuggestion,
  validateSuggestionContract,
  validateAbstention,
  validateClassificationResult,
} from "./suggestion-contracts.mjs";

const GENERIC_STOPWORDS = new Set([
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

const UNCERTAINTY_PATTERN = /\b(?:maybe|possibly|perhaps|might be|could be|unclear whether|not sure (?:if|whether)|tentative|tentatively)\b/i;

const BLOCKER_ACTIVE = /\b(?:blocked|blocker|blocking|can't proceed|cannot proceed|unable to proceed|completely stuck|stuck|hit a wall|halted|failing|frictions?|preventing .{1,80} from starting|prevent(?:s)? .{1,80} from|holding off on .{1,80} until|cannot sign off|can't sign off)\b/i;
const BLOCKER_RESOLVED_OR_NEGATED = /\b(?:no longer blocked|unblocked|not blocked|isn't blocked|wasn't blocked|not a blocker|no blockers?|without a blocker|blocker (?:is |was |has been )?(?:resolved|cleared)|blocking issue (?:is |was )?(?:resolved|cleared))\b/i;
const FUTURE_REQUIREMENT_ONLY = /\b(?:needed before|will need|will require|required for (?:the )?next phase|to be required)\b/i;

const COMPLETION_ACTIVE = /\b(?:completed|complete|signed off|sign-off|signed-off|finalized|locked in|published|deployed|launched|delivered|closed out|imported cleanly|ready for prod|ready in prod|fully mapped|done)\b/i;
const COMPLETION_FINISHED_VERB = /\b(?:finished (?:scrubbing|cleansing|mapping|drafting|building|loading|configuring|testing|publishing|deploying))\b/i;
const COMPLETION_NEGATED = /\b(?:not completed|not finished|not signed off|not ready|hasn't finished|haven't finished|cannot sign off|can't sign off)\b/i;
const STAGING_OR_PARTIAL = /\b(?:in staging for review|draft ready for review|staging tenant|drafting|in progress|underway)\b/i;

const DEPENDENCY_PATTERN = /\b(?:depends on|dependent on|waiting (?:on|for)|awaiting|gated on|gated by|can start only after|start only after|start only once|contingent on|contingent upon|requires? .{1,60} before|unblocks|once .{1,60} (?:locked|signed off|finished|completed|arrives?|released)|until .{1,60} (?:finishes|arrives|releases|completes)|prerequisite)\b/i;
const PREREQUISITE_CUE = /\b(?:unblocks|once .{1,60} (?:locked|signed off|finished|completed)|is (?:the )?prerequisite|prerequisite for)\b/i;
const GATED_CUE = /\b(?:depends on|dependent on|waiting (?:on|for)|awaiting|gated on|gated by|can start only after|start only after|holding off on .{1,60} until|cannot start .{1,60} until|cannot proceed until)\b/i;

const PROGRESS_ACTIVE = /\b(?:currently (?:wiring|configuring|working on|building|mapping|testing|developing|drafting|loading|reviewing)|underway|in progress|moving forward|actively (?:working|developing)|started (?:drafting|building|mapping|wiring|loading)|pulling .{1,50} tonight to help|working on|next step (?:for us )?is loading)\b/i;
const CASUAL_OR_PLANNING_ONLY = /\b(?:discussed|mention(?:ed)?|briefly discussed|someone asked|agenda|check-in|lunch|meeting|calendar|timesheets?|plan to discuss|will discuss|meeting to plan)\b/i;

/**
 * Classify delivery relationships for one claim's candidate result.
 *
 * Consumes:
 * - candidate_result: output of candidate retrieval for one claim
 * - tasks: read-only array of imported tasks
 * - source_text: optional full source document string for span validation
 *
 * Returns a classification_result:
 * {
 *   candidate_result,
 *   suggestions: [...],
 *   abstentions: [...]
 * }
 */
export function classifyCandidateResult({ candidate_result: candidateResult, tasks, source_text: sourceText = null } = {}) {
  if (!isObject(candidateResult)) throw new TypeError("candidate_result must be an object.");
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array.");
  if (!Array.isArray(candidateResult.candidates)) throw new TypeError("candidate_result.candidates must be an array.");
  if (!isObject(candidateResult.evidence_span)) throw new TypeError("candidate_result.evidence_span must be an object.");
  if (!isNonEmptyString(candidateResult.claim_id)) throw new TypeError("candidate_result.claim_id must be a non-empty string.");
  if (!isNonEmptyString(candidateResult.segment_id)) throw new TypeError("candidate_result.segment_id must be a non-empty string.");

  const claimId = candidateResult.claim_id;
  const segmentId = candidateResult.segment_id;
  const sourceId = candidateResult.source_ref?.source_id ?? "meeting_notes";
  const evidenceText = candidateResult.evidence_span.text;
  const contextSpan = resolveContextSpan(candidateResult);

  // 1. No candidates retrieved -> claim-scoped abstention
  if (candidateResult.candidates.length === 0) {
    const result = {
      candidate_result: candidateResult,
      suggestions: [],
      abstentions: [
        {
          claim_id: claimId,
          candidate_id: null,
          reason: "no_plausible_candidate",
        },
      ],
    };
    return validateAndReturn(result, sourceText);
  }

  const tasksById = new Map();
  for (const task of tasks) {
    if (task && typeof task.task_id === "string") tasksById.set(task.task_id, task);
  }

  // 2. Resolve candidate competition and ambiguity
  const candidates = candidateResult.candidates;
  const candidateStatus = resolveCandidateClusters(candidates, evidenceText, tasksById);

  // 3. Classify each candidate
  const suggestions = [];
  const abstentions = [];

  for (const candidate of candidates) {
    const status = candidateStatus.get(candidate.candidate_id);

    if (status.outcome === "ambiguous") {
      abstentions.push({
        claim_id: claimId,
        candidate_id: candidate.candidate_id,
        reason: "ambiguous_candidates",
      });
      continue;
    }

    if (status.outcome === "eliminated") {
      abstentions.push({
        claim_id: claimId,
        candidate_id: candidate.candidate_id,
        reason: "insufficient_evidence",
      });
      continue;
    }

    const task = tasksById.get(candidate.task_id);
    const classification = evaluateCandidateRelationship({
      candidate,
      candidateResult,
      task,
      tasksById,
      allCandidates: candidates,
      evidenceText,
    });

    if (classification.type === "suggestion") {
      suggestions.push({
        suggestion_id: `suggestion:${JSON.stringify([segmentId, claimId, candidate.task_id])}`,
        candidate_id: candidate.candidate_id,
        claim_id: claimId,
        segment_id: segmentId,
        task_id: candidate.task_id,
        relationship_type: classification.relationship_type,
        evidence_assessment: classification.evidence_assessment,
        candidate_ambiguity: status.ambiguity,
        evidence_span: {
          text: candidateResult.evidence_span.text,
          start_offset: candidateResult.evidence_span.start_offset,
          end_offset: candidateResult.evidence_span.end_offset,
        },
        context_span: contextSpan,
        rationale: classification.rationale,
        related_task_id: classification.related_task_id,
        dependency_role: classification.dependency_role,
        provenance: {
          method: "deterministic_rules",
          provider: null,
          model: null,
          prompt_version: null,
          extractor_version: "implicit-linking-v1",
          source_ref: { source_id: sourceId },
        },
      });
    } else {
      abstentions.push({
        claim_id: claimId,
        candidate_id: candidate.candidate_id,
        reason: classification.reason ?? "insufficient_evidence",
      });
    }
  }

  const result = {
    candidate_result: candidateResult,
    suggestions,
    abstentions,
  };

  return validateAndReturn(result, sourceText);
}

/**
 * Classify all claims across retrieved segment results.
 * Preserves claim isolation and segment grouping.
 */
export function classifyTaskRelationships({ segment_results: segmentResults, tasks, source_text: sourceText = null } = {}) {
  if (!Array.isArray(segmentResults)) throw new TypeError("segment_results must be an array.");
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array.");

  const results = [];
  for (const segment of segmentResults) {
    if (!isObject(segment) || !Array.isArray(segment.claims)) {
      throw new TypeError("Each segment must be an object with a claims array.");
    }
    const claimResults = [];
    for (const claim of segment.claims) {
      if (!isObject(claim) || !isObject(claim.candidate_result)) {
        throw new TypeError("Each claim must contain a candidate_result object.");
      }
      claimResults.push({
        claim_id: claim.claim_id,
        classification_result: classifyCandidateResult({
          candidate_result: claim.candidate_result,
          tasks,
          source_text: sourceText,
        }),
      });
    }
    results.push({
      source_ref: { source_id: segment.source_ref?.source_id ?? "meeting_notes" },
      segment_id: segment.segment_id,
      claims: claimResults,
    });
  }
  return results;
}

function evaluateCandidateRelationship({ candidate, candidateResult, task, tasksById, allCandidates, evidenceText }) {
  const isHedged = UNCERTAINTY_PATTERN.test(evidenceText);
  const isNegatedBlocker = BLOCKER_RESOLVED_OR_NEGATED.test(evidenceText);
  const isFutureRequirement = FUTURE_REQUIREMENT_ONLY.test(evidenceText);
  const isCasualOrPlanning = CASUAL_OR_PLANNING_ONLY.test(evidenceText);
  const isStagingOrPartial = STAGING_OR_PARTIAL.test(evidenceText);
  const isNegatedCompletion = COMPLETION_NEGATED.test(evidenceText);

  // Check for conflicting evidence within the span (e.g. completion and blocker mentioned together)
  const hasBlockerCues = BLOCKER_ACTIVE.test(evidenceText) && !isNegatedBlocker && !isFutureRequirement;
  const hasCompletionCues = (COMPLETION_ACTIVE.test(evidenceText) || COMPLETION_FINISHED_VERB.test(evidenceText))
    && !isNegatedCompletion && !isStagingOrPartial;

  if (hasBlockerCues && hasCompletionCues) {
    // Conflict is out of scope for v1: mark uncertain or abstain
    return { type: "abstention", reason: "insufficient_evidence" };
  }

  // 1. Dependency
  if (DEPENDENCY_PATTERN.test(evidenceText)) {
    const taskPair = resolveTaskDependencyPair(candidate, allCandidates, evidenceText);

    if (!taskPair) {
      const externalCandidateEvidence = allCandidates.length === 1
        || canBeExternallyGatedTask(candidate, allCandidates, evidenceText);
      const canBeExternallyGated = candidateIsExplicitlySupported(candidate, evidenceText)
        && externalCandidateEvidence;

      if (!canBeExternallyGated) {
        return { type: "abstention", reason: "insufficient_evidence" };
      }

      return {
        type: "suggestion",
        relationship_type: "dependency",
        dependency_role: "gated_task",
        related_task_id: null,
        evidence_assessment: isHedged ? "uncertain" : "strong",
        rationale: `The evidence indicates task ${candidate.task_id} is gated by a prerequisite condition.`,
      };
    }

    return {
      type: "suggestion",
      relationship_type: "dependency",
      dependency_role: taskPair.dependencyRole,
      related_task_id: taskPair.relatedTaskId,
      evidence_assessment: isHedged ? "uncertain" : "strong",
      rationale: taskPair.dependencyRole === "prerequisite"
        ? `The evidence indicates task ${candidate.task_id} is a prerequisite unblocking task ${taskPair.relatedTaskId}.`
        : `The evidence indicates task ${candidate.task_id} is gated by prerequisite task ${taskPair.relatedTaskId}.`,
    };
  }

  // 2. Blocker
  if (hasBlockerCues) {
    return {
      type: "suggestion",
      relationship_type: "blocker",
      dependency_role: null,
      related_task_id: null,
      evidence_assessment: isHedged ? "uncertain" : "strong",
      rationale: `The evidence describes an active impediment or blocker presently halting task ${candidate.task_id}.`,
    };
  }

  // 3. Completion
  if (hasCompletionCues) {
    return {
      type: "suggestion",
      relationship_type: "completion",
      dependency_role: null,
      related_task_id: null,
      evidence_assessment: isHedged ? "uncertain" : "strong",
      rationale: `The evidence indicates task ${candidate.task_id} has been signed off, completed, or delivered.`,
    };
  }

  // 4. Progress
  if (PROGRESS_ACTIVE.test(evidenceText) && !isCasualOrPlanning) {
    return {
      type: "suggestion",
      relationship_type: "progress",
      dependency_role: null,
      related_task_id: null,
      evidence_assessment: isHedged ? "uncertain" : "strong",
      rationale: `The evidence indicates work on task ${candidate.task_id} is currently underway.`,
    };
  }

  // Mention or lexical overlap without delivery relation
  return { type: "abstention", reason: "insufficient_evidence" };
}

function canBeExternallyGatedTask(candidate, allCandidates, evidenceText) {
  for (const clause of splitEvidenceClauses(evidenceText)) {
    const lowerClause = clause.toLowerCase();
    const candidateIndex = getCandidateMatchIndex(candidate, lowerClause);
    if (candidateIndex === -1) continue;

    const gatedMatch = lowerClause.match(/\b(?:depends on|dependent on|waiting (?:on|for)|gated on|gated by|can start only after|start only after|holding off on|until)\b/i);
    if (!gatedMatch) continue;

    const cueIndex = gatedMatch.index;
    if (candidateIndex >= cueIndex) continue;

    const clauseLimit = lowerClause.length;
    const hasOtherCandidateEndpoint = allCandidates.some((item) => {
      if (item.task_id === candidate.task_id) return false;
      const itemIndex = getCandidateMatchIndex(item, lowerClause);
      return itemIndex > cueIndex && itemIndex < clauseLimit;
    });
    if (!hasOtherCandidateEndpoint) return true;
  }

  return false;
}

function resolveTaskDependencyPair(candidate, allCandidates, evidenceText) {
  if (allCandidates.length !== 2) return null;

  const otherCandidate = allCandidates.find((item) => item.task_id !== candidate.task_id);
  if (!otherCandidate) return null;

  for (const clause of splitEvidenceClauses(evidenceText)) {
    const lowerClause = clause.toLowerCase();
    const candidateIndex = getCandidateMatchIndex(candidate, lowerClause);
    const otherIndex = getCandidateMatchIndex(otherCandidate, lowerClause);
    if (candidateIndex === -1 || otherIndex === -1) continue;

    const prerequisiteMatch = lowerClause.match(/\bunblocks\b|\bis (?:the )?prerequisite\b|\bprerequisite for\b/i);
    if (prerequisiteMatch) {
      const cueIndex = prerequisiteMatch.index;
      if (candidateIndex < cueIndex && cueIndex < otherIndex) {
        return { dependencyRole: "prerequisite", relatedTaskId: otherCandidate.task_id };
      }
      if (otherIndex < cueIndex && cueIndex < candidateIndex) {
        return { dependencyRole: "gated_task", relatedTaskId: otherCandidate.task_id };
      }
    }

    const gatedMatch = lowerClause.match(/\b(?:depends on|dependent on|waiting (?:on|for)|gated on|gated by|can start only after|start only after|holding off on|until)\b/i);
    if (gatedMatch) {
      const cueIndex = gatedMatch.index;
      const directEndpointText = lowerClause.slice(
        cueIndex + gatedMatch[0].length,
        Math.max(candidateIndex, otherIndex),
      );
      if (/[,;]/.test(directEndpointText)) continue;

      if (candidateIndex < cueIndex && cueIndex < otherIndex) {
        return { dependencyRole: "gated_task", relatedTaskId: otherCandidate.task_id };
      }
      if (otherIndex < cueIndex && cueIndex < candidateIndex) {
        return { dependencyRole: "prerequisite", relatedTaskId: otherCandidate.task_id };
      }
    }
  }

  return null;
}

function splitEvidenceClauses(evidenceText) {
  return evidenceText.split(/[.!?;]+|,(?!\s*that\s+(?:unblocks|is (?:the )?prerequisite|prerequisite for)\b)|\b(?:while|whereas|but|however|although|though)\b/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function getCandidateLocalEvidence(candidate, clauses) {
  const matchedTerms = (candidate.matched_terms ?? []).map((term) => term.toLowerCase());
  const matchedTermClauses = clauses.filter((clause) => {
    const lowerClause = clause.toLowerCase();
    return matchedTerms.some((term) => lowerClause.includes(term));
  });
  if (matchedTermClauses.length > 0) return matchedTermClauses.join(" ");

  const escapedId = candidate.task_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idPattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapedId}(?![\\p{L}\\p{N}_-])`, "u");
  return clauses.filter((clause) => idPattern.test(clause)).join(" ");
}

function candidateIsExplicitlySupported(candidate, evidenceText) {
  return getCandidateMatchIndex(candidate, evidenceText.toLowerCase()) !== -1;
}

function getCandidateMatchIndex(candidate, lowerEvidence) {
  if (Array.isArray(candidate.matched_terms) && candidate.matched_terms.length > 0) {
    for (const term of candidate.matched_terms) {
      const idx = lowerEvidence.indexOf(term.toLowerCase());
      if (idx !== -1) return idx;
    }
  }
  const idIdx = lowerEvidence.indexOf(candidate.task_id.toLowerCase());
  return idIdx !== -1 ? idIdx : -1;
}

function resolveCandidateClusters(candidates, evidenceText, tasksById) {
  const result = new Map();
  if (candidates.length <= 1) {
    if (candidates.length === 1) {
      result.set(candidates[0].candidate_id, { outcome: "evaluate", ambiguity: "unique" });
    }
    return result;
  }

  const clauses = splitEvidenceClauses(evidenceText);

  // Group candidates into clusters based on shared matched_terms
  const clusters = [];
  for (const candidate of candidates) {
    const candidateTerms = new Set(candidate.matched_terms ?? []);
    let placed = false;
    for (const cluster of clusters) {
      const sharesTerm = cluster.some((other) => {
        const otherTerms = new Set(other.matched_terms ?? []);
        return [...candidateTerms].some((term) => otherTerms.has(term));
      });
      if (sharesTerm) {
        cluster.push(candidate);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([candidate]);
    }
  }

  for (const cluster of clusters) {
    if (cluster.length === 1) {
      result.set(cluster[0].candidate_id, { outcome: "evaluate", ambiguity: "unique" });
      continue;
    }

    // Multiple candidates sharing matched terms -> competing cluster
    const scores = [];
    for (const candidate of cluster) {
      const task = tasksById.get(candidate.task_id);
      if (!task) {
        scores.push({ candidate, score: 0 });
        continue;
      }

      const localEvidence = getCandidateLocalEvidence(candidate, clauses);
      const normalizedLocalEvidence = localEvidence.normalize("NFC").toLowerCase();

      // Explicit ID in evidence
      const escapedId = candidate.task_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const idPattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapedId}(?![\\p{L}\\p{N}_-])`, "u");
      if (idPattern.test(localEvidence)) {
        scores.push({ candidate, score: 10 });
        continue;
      }

      // Discriminating non-generic title tokens
      const titleTokens = tokenize(task.title).filter((term) => !GENERIC_STOPWORDS.has(term));
      const matchedTokens = new Set((candidate.matched_terms ?? []).flatMap(tokenize));
      const discriminating = titleTokens.filter((term) => !matchedTokens.has(term));

      let score = 0;
      for (const token of discriminating) {
        if (normalizedLocalEvidence.includes(token)) score += 1;
      }
      scores.push({ candidate, score });
    }

    const maxScore = Math.max(...scores.map((s) => s.score));
    const winners = scores.filter((s) => s.score === maxScore && s.score > 0);

    if (winners.length === 1) {
      const winnerId = winners[0].candidate.candidate_id;
      for (const item of cluster) {
        if (item.candidate_id === winnerId) {
          result.set(item.candidate_id, { outcome: "evaluate", ambiguity: "unique" });
        } else {
          result.set(item.candidate_id, { outcome: "eliminated", ambiguity: "unique" });
        }
      }
    } else {
      for (const item of cluster) {
        result.set(item.candidate_id, { outcome: "ambiguous", ambiguity: "multiple" });
      }
    }
  }

  return result;
}

function resolveContextSpan(candidateResult) {
  if (Array.isArray(candidateResult.context_spans) && candidateResult.context_spans.length > 0) {
    const span = candidateResult.context_spans[0];
    return {
      text: span.text,
      start_offset: span.start_offset,
      end_offset: span.end_offset,
    };
  }
  return {
    text: candidateResult.evidence_span.text,
    start_offset: candidateResult.evidence_span.start_offset,
    end_offset: candidateResult.evidence_span.end_offset,
  };
}

function tokenize(text) {
  return text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function validateAndReturn(result, sourceText) {
  const validation = validateClassificationResult(result, sourceText);
  if (!validation.valid) {
    const details = validation.errors.map((error) => `${error.field}: ${error.message}`).join("; ");
    throw new TypeError(`Classification result contract validation failed: ${details}`);
  }
  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}