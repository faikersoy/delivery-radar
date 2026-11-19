const REQUIRED_COLUMNS = ["task_id", "title", "status"];
const OPTIONAL_COLUMNS = ["owner", "due_date", "blocked_by"];

export function isCsvFile(file) {
  return typeof file?.name === "string" && file.name.trim().toLowerCase().endsWith(".csv");
}

/** Parse a strict, comma-delimited CSV document into records with logical row numbers. */
export function parseCsvRecords(input) {
  if (typeof input !== "string" || input.trim() === "") {
    return {
      records: [],
      error: { row: 1, field: "CSV structure", message: "The CSV file is empty." },
    };
  }

  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records = [];
  let rowNumber = 1;
  let fields = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;

  const finishField = () => {
    fields.push(field);
    field = "";
    afterQuote = false;
  };

  const finishRecord = () => {
    finishField();
    records.push({ row: rowNumber, values: fields });
    fields = [];
    rowNumber += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (character === "\r" || character === "\n") {
        const newline = character === "\r" && text[index + 1] === "\n" ? "\r\n" : character;
        field += newline;
        if (newline.length === 2) index += 1;
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === ",") {
        finishField();
      } else if (character === "\r" || character === "\n") {
        finishRecord();
        if (character === "\r" && text[index + 1] === "\n") index += 1;
      } else {
        return {
          records: [],
          error: {
            row: rowNumber,
            field: "CSV structure",
            message: "Unexpected characters after a closing quote.",
          },
        };
      }
      continue;
    }

    if (character === '"') {
      if (field.length !== 0) {
        return {
          records: [],
          error: {
            row: rowNumber,
            field: "CSV structure",
            message: "A quote may only begin at the start of a field.",
          },
        };
      }
      inQuotes = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    return {
      records: [],
      error: {
        row: rowNumber,
        field: "CSV structure",
        message: "A quoted field was not closed.",
      },
    };
  }

  const endsWithNewline = text.endsWith("\n") || text.endsWith("\r");
  if (fields.length > 0 || field.length > 0 || afterQuote || !endsWithNewline) {
    finishRecord();
  }

  return { records, error: null };
}

/** Validate the canonical task columns and return tasks only when the whole file is valid. */
export function parseTasksCsv(input) {
  const parsed = parseCsvRecords(input);
  if (parsed.error) return { tasks: [], errors: [parsed.error] };

  const records = parsed.records;
  const header = records[0];
  if (!header) {
    return {
      tasks: [],
      errors: [{ row: 1, field: "CSV structure", message: "The CSV file has no header row." }],
    };
  }

  const headers = header.values.map((value) => value.trim());
  const errors = [];
  const columnIndexes = new Map();

  headers.forEach((name, index) => {
    if (!name) {
      errors.push({
        row: header.row,
        field: `column ${index + 1}`,
        message: "Header name cannot be empty.",
      });
    } else if (columnIndexes.has(name)) {
      errors.push({ row: header.row, field: name, message: "Header appears more than once." });
    } else {
      columnIndexes.set(name, index);
    }
  });

  for (const name of REQUIRED_COLUMNS) {
    if (!columnIndexes.has(name)) {
      errors.push({
        row: header.row,
        field: name,
        message: "Required column is missing from the header.",
      });
    }
  }

  if (errors.length > 0) return { tasks: [], errors };

  const dataRecords = records.slice(1).filter(({ values }) => {
    return !(values.length === 1 && values[0].trim() === "");
  });

  if (dataRecords.length === 0) {
    return {
      tasks: [],
      errors: [{ row: header.row, field: "CSV structure", message: "No task rows were found." }],
    };
  }

  const tasks = [];
  const seenTaskIds = new Map();

  for (const record of dataRecords) {
    if (record.values.length !== headers.length) {
      errors.push({
        row: record.row,
        field: "CSV structure",
        message: `Expected ${headers.length} fields from the header, but found ${record.values.length}.`,
      });
      continue;
    }

    const valueFor = (column) => {
      const index = columnIndexes.get(column);
      return index === undefined ? "" : record.values[index].trim();
    };
    const rawTask = Object.fromEntries(
      [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].map((column) => [column, valueFor(column)]),
    );
    const task = {
      ...rawTask,
      owner: rawTask.owner || null,
      due_date: rawTask.due_date || null,
      blocked_by: rawTask.blocked_by
        .split(";")
        .map((taskId) => taskId.trim())
        .filter(Boolean),
    };
    let rowIsValid = true;

    for (const column of REQUIRED_COLUMNS) {
      if (!task[column]) {
        errors.push({ row: record.row, field: column, message: "Required value cannot be empty." });
        rowIsValid = false;
      }
    }

    if (task.task_id) {
      const firstSeenRow = seenTaskIds.get(task.task_id);
      if (firstSeenRow !== undefined) {
        errors.push({
          row: record.row,
          field: "task_id",
          message: `Duplicate task_id; it first appeared on row ${firstSeenRow}.`,
        });
        rowIsValid = false;
      } else {
        seenTaskIds.set(task.task_id, record.row);
      }
    }

    if (task.due_date && !isValidIsoDate(task.due_date)) {
      errors.push({
        row: record.row,
        field: "due_date",
        message: "Expected YYYY-MM-DD and a valid calendar date.",
      });
      rowIsValid = false;
    }

    if (rowIsValid) tasks.push(task);
  }

  return errors.length > 0 ? { tasks: [], errors } : { tasks, errors: [] };
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}
