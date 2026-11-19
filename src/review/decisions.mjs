export const NOT_OBSERVED_MESSAGE = "Not in latest data. Not confirmed resolved.";

const DECISION_STATUSES = new Set(["confirmed", "dismissed", "overridden"]);
const DISMISS_REASONS = new Set(["false_positive", "handled_externally"]);

/** Build an unambiguous decision key without relying on a finding's array position. */
export function getDecisionKey(projectId, findingFingerprint) {
  if (!nonEmpty(projectId) || !nonEmpty(findingFingerprint)) {
    throw new Error("A project ID and finding fingerprint are required.");
  }
  return JSON.stringify([projectId, findingFingerprint]);
}

/** Return a stable snapshot of task, signal, and dependency evidence for review. */
export function createEvidenceSnapshot(finding) {
  const items = [
    {
      kind: "task_status",
      source_ref: { source_id: "task_data" },
      task_id: finding.task.task_id,
      value: finding.task.status,
    },
  ];

  for (const evidence of finding.confirmed_evidence) {
    if (evidence.kind !== "meeting_signal") continue;
    items.push({
      kind: "meeting_signal",
      source_ref: normalizeSourceRef(evidence.source_ref),
      signal_id: evidence.signal_id,
      signal_type: evidence.signal_type,
      state: evidence.state,
      evidence: evidence.evidence,
      start_offset: evidence.start_offset,
      end_offset: evidence.end_offset,
    });
  }

  for (const dependency of finding.dependencies) {
    items.push({
      kind: "dependency",
      source_ref: { source_id: "task_data" },
      task_id: dependency.task_id,
      title: dependency.title,
      blocked_by_task_id: dependency.blocked_by_task_id,
    });
  }

  return items;
}

/** Serialize the semantically relevant parts of evidence in stable order. */
export function getEvidenceSignature(finding) {
  return JSON.stringify(
    createEvidenceSnapshot(finding)
      .map(getEvidenceItemKey)
      .sort(),
  );
}

/** Evidence identity excludes offsets, signal IDs, extractor versions, and object key order. */
export function getEvidenceItemKey(item) {
  const sourceRef = normalizeSourceRef(item.source_ref);
  switch (item.kind) {
    case "task_status":
      return JSON.stringify({ kind: item.kind, source_ref: sourceRef, task_id: item.task_id, value: item.value });
    case "meeting_signal":
      return JSON.stringify({
        kind: item.kind,
        source_ref: sourceRef,
        signal_type: item.signal_type,
        state: item.state,
        evidence: item.evidence,
      });
    case "dependency":
      return JSON.stringify({
        kind: item.kind,
        source_ref: sourceRef,
        task_id: item.task_id,
        title: item.title,
        blocked_by_task_id: item.blocked_by_task_id,
      });
    default:
      throw new Error(`Unsupported evidence item kind: ${item.kind}`);
  }
}

/** Record or replace the latest PM decision for a project and finding. */
export function saveDecision(decisions, input) {
  const {
    project_id: projectId,
    finding,
    status,
    reason = null,
    dismiss_reason_category = null,
    explanatory_note = null,
    revised_assessment = null,
    suggested_action = null,
    decided_at: decidedAt = new Date().toISOString(),
  } = input;

  if (!nonEmpty(projectId) || !finding || !nonEmpty(finding.finding_fingerprint)) {
    throw new Error("A project ID and generated finding are required.");
  }
  if (!DECISION_STATUSES.has(status)) {
    throw new Error("Choose Confirm, Dismiss, or Override.");
  }
  if (status === "dismissed") {
    if (!nonEmpty(reason)) throw new Error("Choose a dismissal reason.");
    if (!DISMISS_REASONS.has(dismiss_reason_category)) throw new Error("Choose False positive or Handled externally.");
  }
  if (status === "overridden") {
    if (!nonEmpty(reason)) throw new Error("An override reason is required.");
    if (!nonEmpty(revised_assessment) && !nonEmpty(suggested_action)) {
      throw new Error("Provide a revised assessment or suggested action.");
    }
  }

  const decision = {
    project_id: projectId,
    finding_fingerprint: finding.finding_fingerprint,
    status,
    reason: nonEmpty(reason) ? reason.trim() : null,
    dismiss_reason_category,
    explanatory_note: nonEmpty(explanatory_note) ? explanatory_note.trim() : null,
    revised_assessment: nonEmpty(revised_assessment) ? revised_assessment.trim() : null,
    suggested_action: nonEmpty(suggested_action) ? suggested_action.trim() : null,
    reviewed_evidence_signature: getEvidenceSignature(finding),
    evidence_snapshot: createEvidenceSnapshot(finding),
    finding_snapshot: snapshotFinding(finding),
    decided_at: decidedAt,
  };

  decisions.set(getDecisionKey(projectId, finding.finding_fingerprint), decision);
  return decision;
}

/** Associate current findings with decisions and retain absent findings as not observed. */
export function reconcileDecisions(projectId, findings, decisions) {
  const currentKeys = new Set();
  const current = findings.map((finding) => {
    const key = getDecisionKey(projectId, finding.finding_fingerprint);
    currentKeys.add(key);
    const decision = decisions.get(key) ?? null;
    const evidenceSnapshot = createEvidenceSnapshot(finding);

    if (!decision) {
      return { finding, decision: null, review_state: "pending_review", evidence_changes: { added: [], removed: [] } };
    }

    const changed = decision.reviewed_evidence_signature !== getEvidenceSignature(finding);
    return {
      finding,
      decision,
      review_state: changed ? "review_needed" : "decided",
      evidence_changes: changed
        ? compareEvidence(decision.evidence_snapshot, evidenceSnapshot)
        : { added: [], removed: [] },
    };
  });

  const notObserved = [...decisions.entries()]
    .filter(([key, decision]) => decision.project_id === projectId && !currentKeys.has(key))
    .map(([, decision]) => ({
      decision,
      finding: decision.finding_snapshot,
      observation_state: "not_observed",
      message: NOT_OBSERVED_MESSAGE,
    }));

  return { current, not_observed: notObserved };
}

function compareEvidence(previousItems, currentItems) {
  const previous = countEvidence(previousItems);
  const current = countEvidence(currentItems);
  const added = [];
  const removed = [];

  for (const item of currentItems) {
    const key = getEvidenceItemKey(item);
    const count = previous.get(key) ?? 0;
    if (count > 0) previous.set(key, count - 1);
    else added.push(item);
  }

  for (const item of previousItems) {
    const key = getEvidenceItemKey(item);
    const count = current.get(key) ?? 0;
    if (count > 0) current.set(key, count - 1);
    else removed.push(item);
  }

  return { added, removed };
}

function countEvidence(items) {
  const counts = new Map();
  for (const item of items) {
    const key = getEvidenceItemKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function snapshotFinding(finding) {
  return {
    finding_fingerprint: finding.finding_fingerprint,
    finding_type: finding.finding_type,
    task: { task_id: finding.task.task_id, title: finding.task.title, status: finding.task.status },
    relationship: finding.relationship,
    suggested_action: finding.suggested_action,
    confirmed_evidence: finding.confirmed_evidence.map((evidence) => ({
      ...evidence,
      ...(evidence.source_ref ? { source_ref: normalizeSourceRef(evidence.source_ref) } : {}),
      ...(evidence.extractor ? { extractor: { ...evidence.extractor } } : {}),
    })),
    dependencies: finding.dependencies.map((dependency) => ({ ...dependency })),
    possible_implications: [...finding.possible_implications],
  };
}

function normalizeSourceRef(sourceRef) {
  const source = sourceRef && typeof sourceRef === "object" ? sourceRef : { source_id: "unknown" };
  return Object.fromEntries(Object.entries(source).sort(([left], [right]) => left.localeCompare(right)));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
