import { isCsvFile, parseTasksCsv } from "./ingestion/csv.mjs";
import { analyzeMeetingNotes } from "./analysis/notes.mjs";

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

let importedTasks = [];

if (status) {
  status.textContent = "Meeting-note signal extraction is ready. Task linking and risk scoring are not active.";
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

function renderNoteSignals(result) {
  notesSignalList.replaceChildren();
  notesSignalCount.textContent = `${result.signals.length} ${result.signals.length === 1 ? "signal" : "signals"}`;

  if (result.segments.length === 0) {
    notesAnalysisSummary.textContent = "Paste meeting notes to check for explicit signal phrases.";
  } else if (result.signals.length === 0) {
    notesAnalysisSummary.textContent = `Checked ${result.segments.length} ${result.segments.length === 1 ? "segment" : "segments"}; no supported signal phrases detected.`;
  } else {
    notesAnalysisSummary.textContent = `Found ${result.signals.length} rule-based ${result.signals.length === 1 ? "signal" : "signals"} across ${result.segments.length} ${result.segments.length === 1 ? "segment" : "segments"}. These are signals for review, not delivery-risk assessments.`;
  }

  for (const signal of result.signals) {
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

    item.append(heading, evidence, reference);
    notesSignalList.append(item);
  }
}
