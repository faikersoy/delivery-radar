import assert from "node:assert/strict";
import test from "node:test";
import { isCsvFile, parseTasksCsv } from "../src/ingestion/csv.mjs";

test("accepts CSV file names and rejects unsupported extensions", () => {
  assert.equal(isCsvFile({ name: "tasks.csv" }), true);
  assert.equal(isCsvFile({ name: "TASKS.CSV" }), true);
  assert.equal(isCsvFile({ name: "tasks.xlsx" }), false);
  assert.equal(isCsvFile(undefined), false);
});

test("imports multiple valid tasks and normalizes optional fields", () => {
  const result = parseTasksCsv(
    "task_id,title,status,owner,due_date,blocked_by\n" +
      "T-1,Prepare release,In Progress,Sam,2026-11-30,\n" +
      "T-2,Review release,Open,,2026-12-01,T-1; T-3\n",
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks[1], {
    task_id: "T-2",
    title: "Review release",
    status: "Open",
    owner: null,
    due_date: "2026-12-01",
    blocked_by: ["T-1", "T-3"],
  });
});

test("reports missing required columns with header row and field", () => {
  const result = parseTasksCsv("task_id,title\nT-1,Prepare release\n");

  assert.deepEqual(result.tasks, []);
  assert.ok(result.errors.some((error) => error.row === 1 && error.field === "status"));
});

test("reports empty required values with row and field", () => {
  const result = parseTasksCsv("task_id,title,status\nT-1,,Open\n");

  assert.deepEqual(result.tasks, []);
  assert.ok(result.errors.some((error) => error.row === 2 && error.field === "title"));
});

test("reports duplicate task IDs", () => {
  const result = parseTasksCsv("task_id,title,status\nT-1,First,Open\nT-1,Second,Open\n");

  assert.deepEqual(result.tasks, []);
  assert.ok(result.errors.some((error) => error.row === 3 && error.field === "task_id"));
});

test("rejects invalid calendar dates", () => {
  const result = parseTasksCsv("task_id,title,status,due_date\nT-1,Leap day,Open,2026-02-29\n");

  assert.deepEqual(result.tasks, []);
  assert.ok(result.errors.some((error) => error.row === 2 && error.field === "due_date"));
});

test("preserves commas inside quoted fields", () => {
  const result = parseTasksCsv('task_id,title,status\nT-1,"Prepare, review, and ship",Open\n');

  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks[0].title, "Prepare, review, and ship");
});

test("rejects an unclosed quoted field as malformed CSV", () => {
  const result = parseTasksCsv('task_id,title,status\nT-1,"Prepare release,Open\n');

  assert.deepEqual(result.tasks, []);
  assert.ok(result.errors.some((error) => error.row === 2 && error.field === "CSV structure"));
});

test("rejects rows whose field count does not match the header", () => {
  const result = parseTasksCsv("task_id,title,status\nT-1,Prepare release\n");

  assert.deepEqual(result.tasks, []);
  assert.ok(result.errors.some((error) => error.row === 2 && error.field === "CSV structure"));
});
