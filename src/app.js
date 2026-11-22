import { isCsvFile, parseTasksCsv } from "./ingestion/csv.mjs";
import { analyzeMeetingNotes } from "./analysis/notes.mjs";
import {
  classifyMeetingNotes,
  prepareRelationshipReviewItems,
} from "./analysis/claim-pipeline.mjs";
import { linkSignalsToTasks } from "./analysis/task-linking.mjs";
import { generateFindings } from "./analysis/findings.mjs";
import {
  getEvidenceItemKey,
  NOT_OBSERVED_MESSAGE,
  reconcileRelationshipSuggestionDecisions,
  reconcileDecisions,
  saveRelationshipSuggestionDecision,
  saveDecision,
} from "./review/decisions.mjs";

const status = document.querySelector("#app-status");
const fileInput = document.querySelector("#task-file");
const importSummary = document.querySelector("#import-summary");
const importErrors = document.querySelector("#import-errors");
const importErrorList = document.querySelector("#import-error-list");
const taskPreview = document.querySelector("#task-preview");
const taskPreviewRows = document.querySelector("#task-preview-rows");
const uploadZone = document.querySelector(".upload-zone");
const notesInput = document.querySelector("#meeting-notes");
const notesAnalysisSummary = document.querySelector("#notes-analysis-summary");
const notesSignalCount = document.querySelector("#notes-signal-count");
const notesSignalList = document.querySelector("#notes-signal-list");
const findingCount = document.querySelector("#finding-count");
const emptyReview = document.querySelector("#empty-review");
const findingList = document.querySelector("#finding-list");
const notObservedSection = document.querySelector("#not-observed-section");
const notObservedList = document.querySelector("#not-observed-list");
const relationshipReviewSummary = document.querySelector("#relationship-review-summary");
const relationshipSuggestionCount = document.querySelector("#relationship-suggestion-count");
const relationshipSuggestionList = document.querySelector("#relationship-suggestion-list");
const relationshipAbstentionsSection = document.querySelector("#relationship-abstentions-section");
const relationshipAbstentionList = document.querySelector("#relationship-abstention-list");
const relationshipNotObservedSection = document.querySelector("#relationship-not-observed-section");
const relationshipNotObservedList = document.querySelector("#relationship-not-observed-list");

let importedTasks = [];
let relationshipRenderToken = 0;
const projectId = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const decisions = new Map();

if (status) {
  status.textContent = "Meeting-note signals, relationship suggestions, and evidence-backed findings are ready. Risk scoring is not active.";
}

notesInput?.addEventListener("input", () => {
  renderNoteSignals(analyzeMeetingNotes(notesInput.value));
});

if (notesInput) {
  renderNoteSignals(analyzeMeetingNotes(notesInput.value));
}

fileInput?.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  void importCsvFile(file);
});

let dragDepth = 0;

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function preventFileDropNavigation(event) {
  if (isFileDrag(event)) event.preventDefault();
}

window.addEventListener("dragover", preventFileDropNavigation);
window.addEventListener("drop", preventFileDropNavigation);

uploadZone?.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  uploadZone.classList.add("is-drag-over");
});

uploadZone?.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});

uploadZone?.addEventListener("dragleave", (event) => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) uploadZone.classList.remove("is-drag-over");
});

uploadZone?.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  uploadZone.classList.remove("is-drag-over");

  const file = event.dataTransfer?.files?.[0];
  if (file) {
    void importCsvFile(file);
  } else {
    showImportErrors([{ row: 1, field: "file", message: "No file was found in the drop." }]);
    importSummary.textContent = "Import failed. 0 tasks imported.";
  }
});

async function importCsvFile(file) {
  importedTasks = [];
  renderTasks();
  renderNoteSignals();
  importErrors.hidden = true;
  importErrorList.replaceChildren();
  importSummary.textContent = `Reading ${file.name}…`;

  if (!isCsvFile(file)) {
    showImportErrors([{ row: 1, field: "file", message: "Unsupported file type. Choose a .csv file." }]);
    importSummary.textContent = `Import failed for ${file.name}. 0 tasks imported.`;
    return;
  }

  try {
    const csvText = await file.text();
    const result = parseTasksCsv(csvText);

    if (result.errors.length > 0) {
      showImportErrors(result.errors);
      importSummary.textContent = `Import failed for ${file.name}. 0 tasks imported.`;
      return;
    }

    importedTasks = result.tasks;
    importSummary.textContent = `${importedTasks.length} ${importedTasks.length === 1 ? "task" : "tasks"} imported from ${file.name}.`;
    renderTasks();
    renderNoteSignals();
  } catch {
    showImportErrors([{ row: 1, field: "file", message: "The selected file could not be read." }]);
    importSummary.textContent = `Import failed for ${file.name}. 0 tasks imported.`;
  }
}

function showImportErrors(errors) {
  importErrors.hidden = false;
  importErrorList.replaceChildren();

  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = `Row ${error.row} · ${error.field}: ${error.message}`;
    importErrorList.append(item);
  }
}

function renderTasks() {
  taskPreviewRows.replaceChildren();
  taskPreview.hidden = importedTasks.length === 0;

  for (const task of importedTasks) {
    const row = document.createElement("tr");
    const values = [
      task.task_id,
      task.title,
      task.status,
      task.owner ?? "—",
      task.due_date ?? "—",
      task.blocked_by.length > 0 ? task.blocked_by.join("; ") : "—",
    ];

    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }

    taskPreviewRows.append(row);
  }
}

function renderNoteSignals(result = analyzeMeetingNotes(notesInput?.value ?? "")) {
  notesSignalList.replaceChildren();
  const linkedSignals = linkSignalsToTasks(importedTasks, result.signals);
  renderFindings(generateFindings(importedTasks, linkedSignals));
  refreshRelationshipReview();
  notesSignalCount.textContent = `${result.signals.length} ${result.signals.length === 1 ? "signal" : "signals"}`;

  if (result.segments.length === 0) {
    notesAnalysisSummary.textContent = "Paste meeting notes to check for explicit signal phrases.";
  } else if (result.signals.length === 0) {
    notesAnalysisSummary.textContent = `Checked ${result.segments.length} ${result.segments.length === 1 ? "segment" : "segments"}; no supported signal phrases detected.`;
  } else {
    notesAnalysisSummary.textContent = `Found ${result.signals.length} rule-based ${result.signals.length === 1 ? "signal" : "signals"} across ${result.segments.length} ${result.segments.length === 1 ? "segment" : "segments"}. These are signals for review, not delivery-risk assessments.`;
  }

  for (const { signal, tasks } of linkedSignals) {
    const item = document.createElement("li");
    item.className = "notes-signal-item";

    const heading = document.createElement("div");
    heading.className = "notes-signal-heading";

    const type = document.createElement("span");
    type.className = "notes-signal-type";
    type.textContent = signal.signal_type.replaceAll("_", " ");

    const state = document.createElement("span");
    state.className = `notes-signal-state state-${signal.state}`;
    state.textContent = signal.state.replaceAll("_", " ");

    heading.append(type, state);

    const evidence = document.createElement("blockquote");
    evidence.className = "notes-signal-evidence";
    evidence.textContent = signal.evidence;

    const reference = document.createElement("span");
    reference.className = "notes-signal-reference";
    reference.textContent = `Characters ${signal.start_offset}–${signal.end_offset}`;

    const taskLinks = document.createElement("div");
    taskLinks.className = `notes-signal-task-links ${tasks.length > 0 ? "is-linked" : "is-unlinked"}`;

    if (tasks.length > 0) {
      const label = document.createElement("span");
      label.textContent = tasks.length === 1 ? "Linked task" : "Linked tasks";
      taskLinks.append(label);

      for (const task of tasks) {
        const taskReference = document.createElement("span");
        taskReference.className = "notes-signal-task-reference";
        taskReference.textContent = `${task.task_id} · ${task.title}`;
        taskLinks.append(taskReference);
      }
    } else {
      taskLinks.textContent = importedTasks.length === 0
        ? "Unlinked · import tasks to match explicit task IDs"
        : "Unlinked · no imported task ID found in evidence";
    }

    item.append(heading, evidence, reference, taskLinks);
    notesSignalList.append(item);
  }
}

function refreshRelationshipReview() {
  const token = ++relationshipRenderToken;
  void renderRelationshipReview(token);
}

async function renderRelationshipReview(token) {
  relationshipReviewSummary.textContent = "Analyzing meeting-note claims against imported tasks…";
  try {
    const classified = classifyMeetingNotes({
      source_text: notesInput?.value ?? "",
      tasks: importedTasks,
    });
    const prepared = await prepareRelationshipReviewItems(classified, importedTasks);
    if (token !== relationshipRenderToken) return;
    renderRelationshipSuggestions(prepared.suggestions);
    renderRelationshipAbstentions(prepared.abstentions);
    relationshipReviewSummary.textContent = importedTasks.length === 0
      ? "Import tasks to retrieve and review relationships from meeting-note claims."
      : prepared.suggestions.length > 0
        ? `${prepared.suggestions.length} relationship ${prepared.suggestions.length === 1 ? "suggestion" : "suggestions"} ready for PM review.`
        : prepared.abstentions.length > 0
          ? "No relationship suggestions; claims without enough evidence are listed separately as not classified."
          : "No relationship suggestions or unclassified claims.";
    if (status) {
      status.textContent = `${prepared.suggestions.length} relationship suggestions and ${prepared.abstentions.length} unclassified claims.`;
    }
  } catch (error) {
    if (token !== relationshipRenderToken) return;
    relationshipSuggestionList.replaceChildren();
    relationshipAbstentionList.replaceChildren();
    relationshipAbstentionsSection.hidden = true;
    relationshipReviewSummary.textContent = `Relationship analysis failed: ${error.message}`;
    if (status) status.textContent = relationshipReviewSummary.textContent;
  }
}

function renderRelationshipSuggestions(reviewItems) {
  relationshipSuggestionList.replaceChildren();
  relationshipSuggestionCount.textContent = `${reviewItems.length} ${reviewItems.length === 1 ? "suggestion" : "suggestions"}`;
  const review = reconcileRelationshipSuggestionDecisions(projectId, reviewItems, decisions);

  for (const current of review.current) {
    const { review_item: reviewItem } = current;
    const { suggestion, task, related_task: relatedTask } = reviewItem;
    const card = document.createElement("article");
    card.className = "relationship-suggestion-card";

    const title = document.createElement("h4");
    title.textContent = `${task.task_id} · ${task.title}`;
    card.append(title);

    const relationship = document.createElement("p");
    relationship.className = "relationship-suggestion-meta";
    relationship.textContent = `${capitalize(suggestion.relationship_type)}${suggestion.dependency_role ? ` · ${suggestion.dependency_role.replaceAll("_", " ")}` : ""} · ${suggestion.evidence_assessment} evidence`;
    card.append(relationship);

    const taskDetails = document.createElement("p");
    taskDetails.className = "relationship-suggestion-meta";
    taskDetails.textContent = `Imported status: ${task.status ?? "Not provided"}${task.owner ? ` · Owner: ${task.owner}` : ""}${task.due_date ? ` · Due: ${task.due_date}` : ""}`;
    card.append(taskDetails);

    if (relatedTask) {
      const related = document.createElement("p");
      related.className = "relationship-suggestion-meta";
      related.textContent = `Related task: ${relatedTask.task_id} · ${relatedTask.title} (imported status: ${relatedTask.status ?? "Not provided"})`;
      card.append(related);
    } else if (suggestion.relationship_type === "dependency") {
      const endpoint = document.createElement("p");
      endpoint.className = "relationship-suggestion-meta";
      endpoint.textContent = "Prerequisite is external or unspecified; no related imported task was inferred.";
      card.append(endpoint);
    }

    const evidence = document.createElement("blockquote");
    evidence.className = "relationship-suggestion-evidence";
    evidence.textContent = suggestion.evidence_span.text;
    card.append(evidence);

    const offset = document.createElement("p");
    offset.className = "relationship-suggestion-meta";
    offset.textContent = `Source characters ${suggestion.evidence_span.start_offset}–${suggestion.evidence_span.end_offset}`;
    card.append(offset);

    const rationale = document.createElement("p");
    rationale.className = "relationship-suggestion-meta";
    rationale.textContent = suggestion.rationale;
    card.append(rationale);

    appendRelationshipDecisionPanel(card, current);
    relationshipSuggestionList.append(card);
  }

  renderRelationshipNotObserved(review.not_observed);
}

function renderRelationshipAbstentions(abstentions) {
  relationshipAbstentionList.replaceChildren();
  relationshipAbstentionsSection.hidden = abstentions.length === 0;
  for (const abstention of abstentions) {
    const row = document.createElement("li");
    const taskDescription = abstention.task
      ? `${abstention.task.task_id} · ${abstention.task.title}: `
      : "";
    row.textContent = `${taskDescription}${abstention.reason.replaceAll("_", " ")}. Evidence: “${abstention.evidence_span.text}”`;
    relationshipAbstentionList.append(row);
  }
}

function renderFindings(findings) {
  findingList.replaceChildren();
  findingCount.replaceChildren();
  const review = reconcileDecisions(projectId, findings, decisions);

  const countDot = document.createElement("span");
  countDot.className = "count-dot";
  countDot.setAttribute("aria-hidden", "true");
  findingCount.append(countDot, document.createTextNode(
    findings.length === 0
      ? " No qualifying findings"
      : ` ${findings.length} ${findings.length === 1 ? "finding" : "findings"}`,
  ));
  emptyReview.hidden = review.current.length > 0;

  for (const current of review.current) {
    const { finding } = current;
    const addedEvidenceKeys = new Set(current.evidence_changes.added.map(getEvidenceItemKey));
    const card = document.createElement("article");
    card.className = "finding-card";

    const heading = document.createElement("div");
    heading.className = "finding-card-heading";

    const title = document.createElement("h3");
    title.textContent = `${finding.task.task_id} · ${finding.task.title}`;

    const statusLabel = document.createElement("span");
    statusLabel.className = "finding-status";
    statusLabel.textContent = "Blocked task";
    heading.append(title, statusLabel);
    card.append(heading);

    const relationship = document.createElement("p");
    relationship.className = "finding-relationship";
    relationship.textContent = finding.relationship;
    card.append(relationship);

    const systemAction = document.createElement("section");
    systemAction.className = "finding-detail system-suggested-action";
    const systemActionTitle = document.createElement("h4");
    systemActionTitle.textContent = "System-suggested action";
    const systemActionText = document.createElement("p");
    systemActionText.textContent = finding.suggested_action;
    systemAction.append(systemActionTitle, systemActionText);
    card.append(systemAction);

    const evidenceSection = document.createElement("section");
    evidenceSection.className = "finding-detail";
    const evidenceTitle = document.createElement("h4");
    evidenceTitle.textContent = "Confirmed evidence";
    const evidenceList = document.createElement("ul");
    evidenceList.className = "finding-evidence-list";

    for (const evidence of finding.confirmed_evidence) {
      const row = document.createElement("li");
      if (evidence.kind === "task_status") {
        row.textContent = `CSV task status: ${evidence.value}`;
        markAddedEvidence(row, addedEvidenceKeys.has(getEvidenceItemKey({
          kind: "task_status",
          source_ref: { source_id: "task_data" },
          task_id: finding.task.task_id,
          value: evidence.value,
        })));
      } else {
        const signalLabel = document.createElement("span");
        signalLabel.className = "finding-evidence-label";
        signalLabel.textContent = `${evidence.signal_type.replaceAll("_", " ")} · ${evidence.state}`;
        const quote = document.createElement("blockquote");
        quote.className = "finding-quote";
        quote.textContent = evidence.evidence;
        const offset = document.createElement("span");
        offset.className = "finding-offset";
        offset.textContent = `Characters ${evidence.start_offset}–${evidence.end_offset}`;
        row.append(signalLabel, quote, offset);
        markAddedEvidence(row, addedEvidenceKeys.has(getEvidenceItemKey({
          kind: "meeting_signal",
          source_ref: evidence.source_ref ?? { source_id: "meeting_notes" },
          signal_type: evidence.signal_type,
          state: evidence.state,
          evidence: evidence.evidence,
        })));
      }
      evidenceList.append(row);
    }
    evidenceSection.append(evidenceTitle, evidenceList);
    card.append(evidenceSection);

    const dependenciesSection = document.createElement("section");
    dependenciesSection.className = "finding-detail";
    const dependenciesTitle = document.createElement("h4");
    dependenciesTitle.textContent = "Dependent tasks · from CSV";
    dependenciesSection.append(dependenciesTitle);
    if (finding.dependencies.length > 0) {
      const dependenciesList = document.createElement("ul");
      for (const dependency of finding.dependencies) {
        const row = document.createElement("li");
        row.textContent = `${dependency.task_id} · ${dependency.title} lists ${dependency.blocked_by_task_id} in blocked_by.`;
        markAddedEvidence(row, addedEvidenceKeys.has(getEvidenceItemKey({
          kind: "dependency",
          source_ref: { source_id: "task_data" },
          task_id: dependency.task_id,
          title: dependency.title,
          blocked_by_task_id: dependency.blocked_by_task_id,
        })));
        dependenciesList.append(row);
      }
      dependenciesSection.append(dependenciesList);
    } else {
      const none = document.createElement("p");
      none.className = "finding-muted";
      none.textContent = "No imported tasks list this task as a prerequisite.";
      dependenciesSection.append(none);
    }
    card.append(dependenciesSection);

    const implicationsSection = document.createElement("section");
    implicationsSection.className = "finding-implication";
    const implicationsTitle = document.createElement("h4");
    implicationsTitle.textContent = "Possible implication";
    const implicationText = document.createElement("p");
    implicationText.textContent = finding.possible_implications[0]
      ?? "No downstream implication is identified from the imported dependency data.";
    implicationsSection.append(implicationsTitle, implicationText);
    card.append(implicationsSection);
    appendDecisionPanel(card, current);

    findingList.append(card);
  }

  renderNotObserved(review.not_observed);
}

function appendDecisionPanel(card, review) {
  const panel = document.createElement("section");
  panel.className = "pm-decision-panel";
  const heading = document.createElement("h4");
  heading.textContent = "PM decision";
  panel.append(heading);

  const state = document.createElement("p");
  state.className = `pm-decision-state ${review.review_state === "review_needed" ? "needs-review" : ""}`;
  state.textContent = review.review_state === "pending_review"
    ? "Pending review"
    : review.review_state === "review_needed"
      ? `Review needed — previously ${capitalize(review.decision.status)}`
      : capitalize(review.decision.status);
  panel.append(state);

  if (review.decision) appendDecisionDetails(panel, review.decision);
  if (review.review_state === "review_needed") appendEvidenceChanges(panel, review.evidence_changes);

  const actions = document.createElement("div");
  actions.className = "pm-decision-actions";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "decision-button";
  confirm.textContent = "Confirm";
  confirm.setAttribute("aria-label", `Confirm finding ${review.finding.task.task_id}`);
  confirm.addEventListener("click", () => {
    saveDecision(decisions, { project_id: projectId, finding: review.finding, status: "confirmed" });
    renderNoteSignals();
  });
  actions.append(confirm);
  actions.append(createDismissForm(review.finding), createOverrideForm(review.finding));
  panel.append(actions);
  card.append(panel);
}

function appendRelationshipDecisionPanel(card, review) {
  const { review_item: reviewItem } = review;
  const panel = document.createElement("section");
  panel.className = "pm-decision-panel";
  const heading = document.createElement("h4");
  heading.textContent = "PM decision";
  panel.append(heading);

  const state = document.createElement("p");
  state.className = `pm-decision-state ${review.review_state === "review_needed" ? "needs-review" : ""}`;
  state.textContent = review.review_state === "pending_review"
    ? "Pending review"
    : review.review_state === "review_needed"
      ? `Review needed — previously ${capitalize(review.decision.status)}`
      : capitalize(review.decision.status);
  panel.append(state);

  if (review.decision) appendDecisionDetails(panel, review.decision);
  if (review.review_state === "review_needed") appendEvidenceChanges(panel, review.evidence_changes);

  const actions = document.createElement("div");
  actions.className = "pm-decision-actions";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "decision-button";
  confirm.textContent = "Confirm";
  confirm.setAttribute("aria-label", `Confirm relationship suggestion for ${reviewItem.task.task_id}`);
  confirm.addEventListener("click", () => {
    saveRelationshipSuggestionDecision(decisions, {
      project_id: projectId,
      review_item: reviewItem,
      status: "confirmed",
    });
    renderNoteSignals();
  });
  actions.append(confirm);
  actions.append(
    createDismissForm(reviewItem, saveRelationshipSuggestionDecision, renderNoteSignals, "review_item"),
    createOverrideForm(reviewItem, saveRelationshipSuggestionDecision, renderNoteSignals, "review_item"),
  );
  panel.append(actions);
  card.append(panel);
}

function renderRelationshipNotObserved(entries) {
  relationshipNotObservedList.replaceChildren();
  relationshipNotObservedSection.hidden = entries.length === 0;
  for (const entry of entries) {
    const card = document.createElement("article");
    card.className = "not-observed-card";
    const title = document.createElement("h4");
    title.textContent = `${entry.review_item.task.task_id} · ${entry.review_item.task.title}`;
    card.append(title);
    const message = document.createElement("p");
    message.textContent = NOT_OBSERVED_MESSAGE;
    card.append(message);
    appendLabeledText(card, "Previously reviewed relationship", entry.review_item.suggestion.relationship_type);
    const evidence = document.createElement("blockquote");
    evidence.textContent = entry.review_item.suggestion.evidence_span.text;
    card.append(evidence);
    appendDecisionDetails(card, entry.decision);
    relationshipNotObservedList.append(card);
  }
}

function appendDecisionDetails(container, decision) {
  if (decision.reason) appendLabeledText(container, "Reason", decision.reason);
  if (decision.explanatory_note) appendLabeledText(container, "PM note", decision.explanatory_note);
  if (decision.revised_assessment) appendLabeledText(container, "PM revised assessment", decision.revised_assessment);
  if (decision.suggested_action) appendLabeledText(container, "PM suggested action", decision.suggested_action);

  const timestamp = document.createElement("p");
  timestamp.className = "decision-timestamp";
  timestamp.textContent = `Recorded ${new Date(decision.decided_at).toLocaleString()}`;
  container.append(timestamp);
}

function appendEvidenceChanges(container, changes) {
  const section = document.createElement("div");
  section.className = "evidence-changes";
  const title = document.createElement("h5");
  title.textContent = "Evidence changed since review";
  section.append(title);

  for (const [label, items, className] of [
    ["Added evidence", changes.added, "evidence-added"],
    ["Removed evidence", changes.removed, "evidence-removed"],
  ]) {
    const group = document.createElement("div");
    const groupTitle = document.createElement("strong");
    groupTitle.textContent = label;
    group.append(groupTitle);
    if (items.length === 0) {
      const none = document.createElement("p");
      none.textContent = "None";
      group.append(none);
    } else {
      const list = document.createElement("ul");
      for (const item of items) {
        const row = document.createElement("li");
        row.className = className;
        row.textContent = formatEvidenceItem(item);
        list.append(row);
      }
      group.append(list);
    }
    section.append(group);
  }
  container.append(section);
}

function renderNotObserved(entries) {
  notObservedList.replaceChildren();
  notObservedSection.hidden = entries.length === 0;

  for (const entry of entries) {
    const card = document.createElement("article");
    card.className = "not-observed-card";
    const title = document.createElement("h4");
    title.textContent = `${entry.finding.task.task_id} · ${entry.finding.task.title}`;
    card.append(title);

    const message = document.createElement("p");
    message.className = "not-observed-message";
    message.textContent = NOT_OBSERVED_MESSAGE;
    card.append(message);

    const previousFinding = document.createElement("p");
    previousFinding.textContent = entry.finding.relationship;
    card.append(previousFinding);
    appendLabeledText(card, "Previous system-suggested action", entry.finding.suggested_action);
    appendDecisionDetails(card, entry.decision);

    const evidenceTitle = document.createElement("strong");
    evidenceTitle.textContent = "Previously reviewed evidence";
    card.append(evidenceTitle);
    const evidenceList = document.createElement("ul");
    for (const item of entry.finding.confirmed_evidence) {
      const row = document.createElement("li");
      if (item.kind === "task_status") {
        row.textContent = `CSV task status: ${item.value}`;
      } else {
        const label = document.createElement("span");
        label.textContent = `${item.signal_type.replaceAll("_", " ")} · ${item.state}`;
        const quote = document.createElement("blockquote");
        quote.textContent = item.evidence;
        row.append(label, quote);
      }
      evidenceList.append(row);
    }
    card.append(evidenceList);

    if (entry.finding.dependencies.length > 0) {
      const dependencyTitle = document.createElement("strong");
      dependencyTitle.textContent = "Previously observed dependencies";
      const dependencyList = document.createElement("ul");
      for (const dependency of entry.finding.dependencies) {
        const row = document.createElement("li");
        row.textContent = `${dependency.task_id} · ${dependency.title} lists ${dependency.blocked_by_task_id} in blocked_by.`;
        dependencyList.append(row);
      }
      card.append(dependencyTitle, dependencyList);
    }

    if (entry.finding.possible_implications.length > 0) {
      appendLabeledText(card, "Previous possible implication", entry.finding.possible_implications.join(" "));
    }
    notObservedList.append(card);
  }
}

function createDismissForm(finding, save = saveDecision, rerender = renderNoteSignals, subjectField = "finding") {
  const details = document.createElement("details");
  details.className = "decision-editor";
  const summary = document.createElement("summary");
  summary.textContent = "Dismiss";
  details.append(summary);

  const form = document.createElement("form");
  const category = document.createElement("select");
  category.name = "dismiss_reason_category";
  category.required = true;
  category.setAttribute("aria-label", "Dismissal reason");
  category.append(new Option("Choose a reason", ""), new Option("False positive", "false_positive"), new Option("Handled externally", "handled_externally"));
  form.append(category);
  form.append(createTextAreaField("Optional note", "explanatory_note", false));
  const error = createFormError();
  form.append(error, createSubmitButton("Save dismissal"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = category.selectedOptions[0];
    submitDecision(form, error, {
      project_id: projectId,
      [subjectField]: finding,
      status: "dismissed",
      dismiss_reason_category: category.value,
      reason: selected?.textContent ?? "",
      explanatory_note: form.elements.namedItem("explanatory_note").value,
    }, save, rerender);
  });
  details.append(form);
  return details;
}

function createOverrideForm(finding, save = saveDecision, rerender = renderNoteSignals, subjectField = "finding") {
  const details = document.createElement("details");
  details.className = "decision-editor";
  const summary = document.createElement("summary");
  summary.textContent = "Override";
  details.append(summary);

  const form = document.createElement("form");
  form.append(createTextAreaField("Reason (required)", "reason", true));
  form.append(createTextAreaField("Revised assessment", "revised_assessment", false));
  form.append(createTextAreaField("Suggested action", "suggested_action", false));
  const error = createFormError();
  form.append(error, createSubmitButton("Save override"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitDecision(form, error, {
      project_id: projectId,
      [subjectField]: finding,
      status: "overridden",
      reason: form.elements.namedItem("reason").value,
      revised_assessment: form.elements.namedItem("revised_assessment").value,
      suggested_action: form.elements.namedItem("suggested_action").value,
    }, save, rerender);
  });
  details.append(form);
  return details;
}

function submitDecision(form, error, input, save = saveDecision, rerender = renderNoteSignals) {
  error.textContent = "";
  try {
    save(decisions, input);
    rerender();
  } catch (cause) {
    error.textContent = cause.message;
  }
}

function createTextAreaField(labelText, name, required) {
  const label = document.createElement("label");
  label.className = "decision-field";
  label.append(document.createTextNode(labelText));
  const textarea = document.createElement("textarea");
  textarea.name = name;
  textarea.rows = 2;
  textarea.required = required;
  label.append(textarea);
  return label;
}

function createFormError() {
  const error = document.createElement("p");
  error.className = "decision-form-error";
  error.setAttribute("role", "alert");
  return error;
}

function createSubmitButton(text) {
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "decision-button secondary";
  button.textContent = text;
  return button;
}

function appendLabeledText(container, labelText, value) {
  if (!value) return;
  const item = document.createElement("p");
  const label = document.createElement("strong");
  label.textContent = `${labelText}: `;
  item.append(label, document.createTextNode(value));
  container.append(item);
}

function markAddedEvidence(element, added) {
  if (!added) return;
  element.classList.add("evidence-added");
  const badge = document.createElement("span");
  badge.className = "evidence-added-badge";
  badge.textContent = "Added since review";
  element.append(badge);
}

function formatEvidenceItem(item) {
  if (item.kind === "task_status") return `CSV status: ${item.value}`;
  if (item.kind === "dependency") return `${item.task_id} lists ${item.blocked_by_task_id} in blocked_by.`;
  if (item.kind === "relationship_suggestion") {
    return `${item.relationship_type} suggestion for ${item.task_id}: ${item.evidence}`;
  }
  if (item.kind === "review_task") return `${item.task_id} task details changed (${item.title}; ${item.status}).`;
  return `${item.signal_type.replaceAll("_", " ")} · ${item.evidence}`;
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "Pending review";
}
