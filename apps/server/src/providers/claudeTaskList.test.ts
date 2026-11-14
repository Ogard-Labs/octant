import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readClaudeStoredTaskList } from "./claudeTaskList";

const session = "8c3f0a52-6a7e-4d0f-9b1e-3f2a5c7d9e10";
const folders: string[] = [];

async function configDirectory(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "octant-claude-tasks-"));
  folders.push(folder);
  return folder;
}

function task(id: string, subject: string, status = "pending", extra: object = {}) {
  return JSON.stringify({
    id,
    subject,
    description: `About ${subject}`,
    status,
    blocks: [],
    blockedBy: [],
    ...extra,
  });
}

async function storeTasks(config: string, sessionId: string, files: Record<string, string>) {
  const folder = join(config, "tasks", sessionId);
  await mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
  return folder;
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("readClaudeStoredTaskList", () => {
  it("reads the session's whole stored list in Claude's order", async () => {
    const config = await configDirectory();
    await storeTasks(config, session, {
      "10.json": task("10", "Ship it"),
      "2.json": task("2", "Write the test", "in_progress"),
      "1.json": task("1", "Read the spec", "completed"),
      "3.json": task("3", "Hidden bookkeeping", "pending", { metadata: { _internal: true } }),
      ".lock": "",
      ".highwatermark": "10",
    });
    // Another session's list stays unread.
    await storeTasks(config, "another-session", { "1.json": task("1", "Not this session") });

    await expect(readClaudeStoredTaskList(config, session)).resolves.toEqual({
      status: "read",
      tasks: [
        { id: "1", subject: "Read the spec", status: "completed" },
        { id: "2", subject: "Write the test", status: "in_progress" },
        { id: "10", subject: "Ship it", status: "pending" },
      ],
    });
  });

  it("reads a session that stored no list as an empty list", async () => {
    const config = await configDirectory();

    await expect(readClaudeStoredTaskList(config, session)).resolves.toEqual({
      status: "read",
      tasks: [],
    });
  });

  it.each([
    ["a file that is not JSON", "{ not json", "task file is not JSON"],
    [
      "a task without Claude's fields",
      JSON.stringify({ id: "1", subject: "Read" }),
      "task file does not match Claude's schema",
    ],
    [
      "a task with a status Claude does not write",
      task("1", "Read", "bogus"),
      "task file does not match Claude's schema",
    ],
    [
      "a task whose id differs from its file",
      task("7", "Read"),
      "task file does not match Claude's schema",
    ],
    ["an oversized task file", task("1", "x".repeat(70_000)), "task file too large"],
  ])("refuses the whole list for %s", async (_name, text, reason) => {
    const config = await configDirectory();
    await storeTasks(config, session, { "1.json": text, "2.json": task("2", "Fine") });

    await expect(readClaudeStoredTaskList(config, session)).resolves.toEqual({
      status: "refused",
      reason,
    });
  });

  it("refuses a list with more tasks than a panel shows", async () => {
    const config = await configDirectory();
    const files: Record<string, string> = {};
    for (let id = 1; id <= 257; id += 1) files[`${id}.json`] = task(String(id), `Task ${id}`);
    await storeTasks(config, session, files);

    await expect(readClaudeStoredTaskList(config, session)).resolves.toEqual({
      status: "refused",
      reason: "too many tasks",
    });
  });

  it("follows no symlink out of the configuration directory", async () => {
    const config = await configDirectory();
    const outside = await configDirectory();
    const elsewhere = await storeTasks(outside, session, { "1.json": task("1", "Outside") });
    await mkdir(join(config, "tasks"), { recursive: true });
    await symlink(elsewhere, join(config, "tasks", session));

    await expect(readClaudeStoredTaskList(config, session)).resolves.toEqual({
      status: "refused",
      reason: "not a plain folder",
    });

    const linkedFile = await configDirectory();
    const folder = await storeTasks(linkedFile, session, {});
    await symlink(join(elsewhere, "1.json"), join(folder, "1.json"));

    await expect(readClaudeStoredTaskList(linkedFile, session)).resolves.toEqual({
      status: "refused",
      reason: "unreadable task file",
    });
  });
});
