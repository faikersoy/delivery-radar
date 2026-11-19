import { isCsvFile, parseTasksCsv } from "./ingestion/csv.mjs";

const status = document.querySelector("#app-status");
const fileInput = document.querySelector("#task-file");
const importSummary = document.querySelector("#import-summary");
const importErrors = document.querySelector("#import-errors");
const importErrorList = document.querySelector("#import-error-list");
const taskPreview = document.querySelector("#task-preview");
const taskPreviewRows = document.querySelector("#task-preview-rows");
const uploadZone = document.querySelector(".upload-zone");

let importedTasks = [];

if (status) {
  status.textContent = "Delivery Radar prototype shell ready. Analysis is not active yet.";
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
