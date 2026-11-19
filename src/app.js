import { isCsvFile, parseTasksCsv } from "./ingestion/csv.mjs";
import { analyzeMeetingNotes } from "./analysis/notes.mjs";
import { linkSignalsToTasks } from "./analysis/task-linking.mjs";
import { generateFindings } from "./analysis/findings.mjs";

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

let importedTasks = [];

if (status) {
  status.textContent = "Meeting-note signal extraction and evidence-backed findings are ready. Risk scoring is not active.";
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

function renderFindings(findings) {
  findingList.replaceChildren();
  findingCount.replaceChildren();

  const countDot = document.createElement("span");
  countDot.className = "count-dot";
  countDot.setAttribute("aria-hidden", "true");
  findingCount.append(countDot, document.createTextNode(
    findings.length === 0
      ? " No qualifying findings"
      : ` ${findings.length} ${findings.length === 1 ? "finding" : "findings"}`,
  ));
  emptyReview.hidden = findings.length > 0;

  for (const finding of findings) {
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

    findingList.append(card);
  }
}
