const RELATIONSHIP_TYPES = new Set(["progress", "completion", "blocker", "dependency"]);
const EVIDENCE_ASSESSMENTS = new Set(["strong", "weak", "uncertain"]);
const CANDIDATE_AMBIGUITIES = new Set(["unique", "multiple"]);
const DEPENDENCY_ROLES = new Set(["prerequisite", "gated_task"]);
const PROVENANCE_OPTIONAL_TEXT_FIELDS = ["provider", "model", "prompt_version", "extractor_version"];
const FINGERPRINT_VERSION = "delivery-radar-suggestion-review-v1";

/** Validate one source span using zero-based, end-exclusive JavaScript offsets. */
export function validateEvidenceSpan(sourceText, span) {
  const errors = [];
  if (typeof sourceText !== "string") {
    errors.push({ field: "sourceText", message: "Source text must be a string." });
  }
  if (!isObject(span)) {
    errors.push({ field: "span", message: "Evidence span must be an object." });
    return { valid: false, errors };
  }

  const { start_offset: start, end_offset: end, text } = span;
  if (!Number.isSafeInteger(start) || start < 0) {
    errors.push({ field: "start_offset", message: "Start offset must be a non-negative safe integer." });
  }
  if (!Number.isSafeInteger(end) || end < 0) {
    errors.push({ field: "end_offset", message: "End offset must be a non-negative safe integer." });
  }
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
    if (end <= start) {
      errors.push({ field: "end_offset", message: "End offset must be greater than start offset." });
    }
    if (typeof sourceText === "string" && end > sourceText.length) {
      errors.push({ field: "end_offset", message: "Evidence span extends beyond the source text." });
    }
  }
  if (typeof text !== "string" || text.length === 0) {
    errors.push({ field: "text", message: "Evidence text must be a non-empty string." });
  } else if (
    errors.length === 0
    && sourceText.slice(start, end) !== text
  ) {
    errors.push({ field: "text", message: "Evidence text must exactly match the source slice." });
  }

  return { valid: errors.length === 0, errors };
}

/** Validate required and relationship-specific fields; invalid contracts return errors and must not be accepted. */
export function validateSuggestionContract(suggestion) {
  const errors = [];
  if (!isObject(suggestion)) {
    return { valid: false, errors: [{ field: "suggestion", message: "Suggestion must be an object." }] };
  }

  for (const field of ["suggestion_id", "candidate_id", "claim_id", "segment_id", "task_id", "rationale"]) {
    if (!isNonEmptyString(suggestion[field])) {
      errors.push({ field, message: "Required field must be a non-empty string." });
    }
  }

  if (!RELATIONSHIP_TYPES.has(suggestion.relationship_type)) {
    errors.push({ field: "relationship_type", message: "Relationship type must be progress, completion, blocker, or dependency." });
  }
  if (!EVIDENCE_ASSESSMENTS.has(suggestion.evidence_assessment)) {
    errors.push({ field: "evidence_assessment", message: "Evidence assessment must be strong, weak, or uncertain." });
  }
  if (!CANDIDATE_AMBIGUITIES.has(suggestion.candidate_ambiguity)) {
    errors.push({ field: "candidate_ambiguity", message: "Candidate ambiguity must be unique or multiple." });
  }

  validateSpanShape(suggestion.evidence_span, "evidence_span", errors);
  validateSpanShape(suggestion.context_span, "context_span", errors);
  validateDependencyFields(suggestion, errors);
  validateProvenance(suggestion.provenance, errors);

  return { valid: errors.length === 0, errors };
}

/** Validate the complete contract and verify both spans against the source. */
export function validateRelationshipSuggestion(suggestion, sourceText) {
  const contract = validateSuggestionContract(suggestion);
  const errors = [...contract.errors];
  for (const field of ["evidence_span", "context_span"]) {
    const result = validateEvidenceSpan(sourceText, suggestion?.[field]);
    for (const error of result.errors) errors.push({ ...error, field: `${field}.${error.field}` });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Create the review-relevant semantic SHA-256 fingerprint.
 * Context spans participate only when explicitly marked as consumed by classification.
 * Context offsets establish source order but are not included in the hashed payload.
 * Other provenance metadata is intentionally excluded.
 */
export async function createSuggestionReviewFingerprint(input) {
  if (!isObject(input)) throw new TypeError("Fingerprint input must be an object.");
  for (const field of ["source_id", "task_id"]) {
    if (!isNonEmptyString(input[field])) throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (!RELATIONSHIP_TYPES.has(input.relationship_type)) {
    throw new TypeError("relationship_type must be progress, completion, blocker, or dependency.");
  }
  if (!isObject(input.evidence_span) || !isNonEmptyString(input.evidence_span.text)) {
    throw new TypeError("evidence_span.text must be a non-empty string.");
  }
  if (!isObject(input.relevant_task_fields)) {
    throw new TypeError("relevant_task_fields must be an object.");
  }
  const provenanceSourceId = input.provenance?.source_ref?.source_id;
  if (!isNonEmptyString(provenanceSourceId) || provenanceSourceId !== input.source_id) {
    throw new TypeError("provenance.source_ref.source_id must match source_id.");
  }
  const contextSpans = input.context_spans ?? [];
  if (!Array.isArray(contextSpans)) throw new TypeError("context_spans must be an array.");

  const orderedContext = contextSpans.map((span, index) => {
    if (!isObject(span) || typeof span.consumed_by_classification !== "boolean") {
      throw new TypeError(`context_spans[${index}] must identify whether classification consumed it.`);
    }
    if (!span.consumed_by_classification) return null;
    if (!isNonEmptyString(span.text)) {
      throw new TypeError(`context_spans[${index}].text must be a non-empty string when consumed.`);
    }
    if (!Number.isSafeInteger(span.start_offset) || span.start_offset < 0
      || !Number.isSafeInteger(span.end_offset) || span.end_offset <= span.start_offset) {
      throw new TypeError(`context_spans[${index}] must have valid source offsets when consumed.`);
    }
    return {
      start_offset: span.start_offset,
      end_offset: span.end_offset,
      text: normalizeSemanticText(span.text),
    };
  }).filter((span) => span !== null)
    .sort((left, right) => left.start_offset - right.start_offset
      || left.end_offset - right.end_offset);
  for (let index = 1; index < orderedContext.length; index += 1) {
    const previous = orderedContext[index - 1];
    const current = orderedContext[index];
    if (previous.start_offset === current.start_offset
      && previous.end_offset === current.end_offset
      && previous.text !== current.text) {
      throw new TypeError("Consumed context spans with identical offsets must have identical text.");
    }
  }
  const consumedContext = orderedContext.map(({ text }) => text);

  const semanticInput = {
    fingerprint_version: FINGERPRINT_VERSION,
    source_id: input.source_id,
    evidence: normalizeSemanticText(input.evidence_span.text),
    consumed_context: consumedContext,
    task_id: input.task_id,
    relevant_task_fields: canonicalize(input.relevant_task_fields),
    relationship_type: input.relationship_type,
  };

  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle?.digest) {
    throw new Error("Web Crypto SHA-256 is unavailable in this environment.");
  }
  const encoded = new TextEncoder().encode(JSON.stringify(semanticInput));
  const digest = await cryptoApi.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateSpanShape(span, field, errors) {
  if (!isObject(span)) {
    errors.push({ field, message: "Span must be an object." });
    return;
  }
  if (!isNonEmptyString(span.text)) errors.push({ field: `${field}.text`, message: "Span text must be a non-empty string." });
  if (!Number.isSafeInteger(span.start_offset) || span.start_offset < 0) {
    errors.push({ field: `${field}.start_offset`, message: "Start offset must be a non-negative safe integer." });
  }
  if (!Number.isSafeInteger(span.end_offset) || span.end_offset <= span.start_offset) {
    errors.push({ field: `${field}.end_offset`, message: "End offset must be a safe integer greater than start offset." });
  }
}

function validateDependencyFields(suggestion, errors) {
  const relatedTaskId = suggestion.related_task_id;
  const dependencyRole = suggestion.dependency_role;
  if (relatedTaskId !== undefined && relatedTaskId !== null) {
    if (!isNonEmptyString(relatedTaskId)) {
      errors.push({ field: "related_task_id", message: "Related task ID must be null or a non-empty string." });
    } else if (relatedTaskId === suggestion.task_id) {
      errors.push({ field: "related_task_id", message: "Related task ID must differ from the primary task ID." });
    }
  }

  if (suggestion.relationship_type === "dependency") {
    if (!DEPENDENCY_ROLES.has(dependencyRole)) {
      errors.push({ field: "dependency_role", message: "Dependency relationship requires prerequisite or gated_task role." });
    }
    if (dependencyRole === "prerequisite" && !isNonEmptyString(relatedTaskId)) {
      errors.push({ field: "related_task_id", message: "A prerequisite role requires the related dependent task ID." });
    }
  } else if ((dependencyRole !== undefined && dependencyRole !== null) || (relatedTaskId !== undefined && relatedTaskId !== null)) {
    errors.push({ field: "dependency_role", message: "Dependency role and related task ID are only valid for dependency relationships." });
  }
}

function validateProvenance(provenance, errors) {
  if (!isObject(provenance)) {
    errors.push({ field: "provenance", message: "Provenance must be an object." });
    return;
  }
  if (!isNonEmptyString(provenance.method)) {
    errors.push({ field: "provenance.method", message: "Provenance method is required." });
  }
  for (const field of PROVENANCE_OPTIONAL_TEXT_FIELDS) {
    if (!(field in provenance) || (provenance[field] !== null && !isNonEmptyString(provenance[field]))) {
      errors.push({ field: `provenance.${field}`, message: "Field must be present and either null or a non-empty string." });
    }
  }
  if (!isObject(provenance.source_ref) || !isNonEmptyString(provenance.source_ref.source_id)) {
    errors.push({ field: "provenance.source_ref.source_id", message: "A non-empty source ID is required." });
  }
}

function canonicalize(value, ancestors = new Set()) {
  if (typeof value === "string") return normalizeSemanticText(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Fingerprint task fields must contain only JSON-compatible values.");
  }

  if (ancestors.has(value)) throw new TypeError("Fingerprint task fields cannot contain circular references.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("Fingerprint task arrays must be plain arrays.");
      }
      return canonicalizeArray(value, ancestors);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Fingerprint task fields must contain only plain objects.");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Fingerprint task fields cannot contain symbol keys.");
    }
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Fingerprint task fields must contain enumerable data properties only.");
      }
      return [key, descriptor.value];
    });
    entries.sort(([left], [right]) => compareCodeUnits(left, right));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item, ancestors)]));
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeArray(value, ancestors) {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === "symbol") throw new TypeError("Fingerprint task arrays cannot contain symbol keys.");
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      throw new TypeError("Fingerprint task arrays cannot contain custom properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Fingerprint task arrays must contain enumerable data values only.");
    }
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError("Fingerprint task arrays cannot contain sparse entries.");
    result.push(canonicalize(value[index], ancestors));
  }
  return result;
}

function normalizeSemanticText(value) {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim().replace(/\s+/gu, " ");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
