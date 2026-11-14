import { Schema } from "effect";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import type { ClaudeJsonValue } from "./claudeAgentSdkPort";

/**
 * Claude Code's task tools, which replace its `TodoWrite` checklist by
 * default. Each reads or writes only the session's own task list under the
 * account's configuration directory (`<config>/tasks/<session id>/<id>.json`,
 * read from the bundled 2.1.211 binary, 2026-11-14): no Project file, shell,
 * network, or person is involved.
 */
export const CLAUDE_TASK_TOOLS = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
const CLAUDE_TASK_TOOL_NAMES: ReadonlySet<string> = new Set(CLAUDE_TASK_TOOLS);

export function isClaudeTaskTool(toolName: string): boolean {
  return CLAUDE_TASK_TOOL_NAMES.has(toolName);
}

export type ClaudeTaskStatus = "pending" | "in_progress" | "completed";

export interface ClaudeTask {
  readonly id: string;
  readonly subject: string;
  readonly status: ClaudeTaskStatus;
}

/**
 * A task tool's structured result (`tool_use_result`), in the shapes Claude
 * Code 2.1.211 declares: `TaskCreate` and `TaskGet` answer `{ task }`,
 * `TaskUpdate` answers `{ success, taskId, updatedFields, statusChange }`, and
 * `TaskList` answers `{ tasks }`. The task id is assigned by the runtime and
 * exists only here, so nothing is applied without it.
 */
export type ClaudeTaskToolOutput =
  | {
      readonly kind: "task";
      readonly task: {
        readonly id: string;
        readonly subject: string;
        readonly status?: ClaudeTaskStatus;
      } | null;
    }
  | {
      readonly kind: "update";
      readonly success: boolean;
      readonly taskId: string;
      readonly updatedFields: ReadonlyArray<string>;
      readonly statusTo?: string;
    }
  | { readonly kind: "list"; readonly tasks: ReadonlyArray<ClaudeTask> };

/** More tasks than this in one list is not a checklist the panel can show. */
const MAX_TASKS = 256;
const MAX_TASK_ID_CHARACTERS = 64;
const MAX_SUBJECT_CHARACTERS = 4_096;
const TASK_ID = /^[A-Za-z0-9_-]+$/;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function taskId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TASK_ID_CHARACTERS && TASK_ID.test(value)
    ? value
    : undefined;
}

function subject(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_SUBJECT_CHARACTERS ? value : undefined;
}

function status(value: unknown): ClaudeTaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

/** The task a `TaskCreate`, `TaskGet`, or `TaskList` result names; undefined for any other shape. */
function outputTask(value: unknown) {
  const task = record(value);
  const id = taskId(task?.id);
  const text = subject(task?.subject);
  if (task === undefined || id === undefined || text === undefined) return undefined;
  if (task.status === undefined) return { id, subject: text };
  const state = status(task.status);
  return state === undefined ? undefined : { id, subject: text, status: state };
}

export function claudeTaskToolOutput(value: unknown): ClaudeTaskToolOutput | undefined {
  const output = record(value);
  if (output === undefined) return undefined;
  if (Object.hasOwn(output, "task")) {
    if (output.task === null) return { kind: "task", task: null };
    const task = outputTask(output.task);
    return task === undefined ? undefined : { kind: "task", task };
  }
  if (Array.isArray(output.tasks)) {
    if (output.tasks.length > MAX_TASKS) return undefined;
    const tasks: ClaudeTask[] = [];
    for (const value of output.tasks) {
      const task = outputTask(value);
      if (task?.status === undefined) return undefined;
      tasks.push({ id: task.id, subject: task.subject, status: task.status });
    }
    return { kind: "list", tasks };
  }
  if (typeof output.success === "boolean") {
    const id = taskId(output.taskId);
    const fields = output.updatedFields;
    if (
      id === undefined ||
      !Array.isArray(fields) ||
      !fields.every((field) => typeof field === "string")
    ) {
      return undefined;
    }
    const change = record(output.statusChange);
    return {
      kind: "update",
      success: output.success,
      taskId: id,
      updatedFields: fields,
      ...(typeof change?.to === "string" ? { statusTo: change.to } : {}),
    };
  }
  return undefined;
}

/** Claude orders its list by numeric id; an id that is not a number sorts after, by text. */
function byClaudeOrder(left: ClaudeTask, right: ClaudeTask): number {
  const a = Number(left.id);
  const b = Number(right.id);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * One Claude session's task list as the panel shows it, kept for the life of
 * the session across its turns. Every change comes from a task tool's result
 * (the runtime assigns ids, so a call's input alone never adds a row) or from
 * the list Claude stored for the session, read when it opened.
 */
export class ClaudeTaskList {
  readonly #tasks = new Map<string, ClaudeTask>();
  /** The panel's id for each Claude task, stable for the session. */
  readonly #panelIds = new Map<string, string>();
  #seedPending = false;

  /** The stored list a resumed session starts from; the next turn shows it whole. */
  seed(tasks: ReadonlyArray<ClaudeTask>): void {
    this.#tasks.clear();
    for (const task of tasks) this.#tasks.set(task.id, task);
    this.#seedPending = tasks.length > 0;
  }

  /** Whether a seeded list is still waiting to be shown; true only once. */
  takeSeed(): boolean {
    const pending = this.#seedPending;
    this.#seedPending = false;
    return pending;
  }

  ordered(): ReadonlyArray<ClaudeTask> {
    return [...this.#tasks.values()].sort(byClaudeOrder);
  }

  panelTaskId(claudeTaskId: string, makeTaskId: () => string): string {
    let id = this.#panelIds.get(claudeTaskId);
    if (id === undefined) {
      id = makeTaskId();
      this.#panelIds.set(claudeTaskId, id);
    }
    return id;
  }

  /**
   * Applies one settled task tool call. Returns whether the list changed in
   * a way it can show; a refused call, a result without its structured
   * output, or an update to a task the session never saw changes nothing.
   */
  apply(
    toolName: string,
    input: { readonly [key: string]: ClaudeJsonValue } | undefined,
    output: ClaudeTaskToolOutput | undefined,
  ): boolean {
    if (output === undefined) return false;
    switch (toolName) {
      case "TaskCreate": {
        if (output.kind !== "task" || output.task === null) return false;
        // A task created with `_internal` metadata is one `TaskList` hides.
        if (record(input?.metadata)?._internal) return false;
        this.#tasks.set(output.task.id, {
          id: output.task.id,
          subject: output.task.subject,
          status: output.task.status ?? "pending",
        });
        return true;
      }
      case "TaskGet": {
        if (output.kind !== "task" || output.task?.status === undefined) return false;
        const known = this.#tasks.get(output.task.id);
        if (known === undefined) return false;
        this.#tasks.set(output.task.id, {
          id: output.task.id,
          subject: output.task.subject,
          status: output.task.status,
        });
        return true;
      }
      case "TaskList": {
        if (output.kind !== "list") return false;
        this.#tasks.clear();
        for (const task of output.tasks) this.#tasks.set(task.id, task);
        return true;
      }
      case "TaskUpdate": {
        if (output.kind !== "update" || !output.success) return false;
        const known = this.#tasks.get(output.taskId);
        if (known === undefined) return false;
        if (output.statusTo === "deleted") {
          this.#tasks.delete(output.taskId);
          return true;
        }
        const renamed = output.updatedFields.includes("subject")
          ? subject(input?.subject)
          : undefined;
        const moved = output.updatedFields.includes("status") ? status(output.statusTo) : undefined;
        this.#tasks.set(output.taskId, {
          id: known.id,
          subject: renamed ?? known.subject,
          status: moved ?? known.status,
        });
        return true;
      }
      default:
        return false;
    }
  }
}

// The file Claude Code 2.1.211 writes for each task (its own schema, read
// from the bundled binary, 2026-11-14). Extra keys are ignored, as Claude
// ignores them.
const StoredTask = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  description: Schema.String,
  activeForm: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  status: Schema.Literal("pending", "in_progress", "completed"),
  blocks: Schema.Array(Schema.String),
  blockedBy: Schema.Array(Schema.String),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
const decodeStoredTask = Schema.decodeUnknownEither(StoredTask);

/** One task file larger than this is not one Claude wrote for a checklist. */
const MAX_STORED_TASK_BYTES = 65_536;
const MAX_STORED_LIST_BYTES = 1_048_576;
const STORED_TASK_FILE = /^(\d{1,9})\.json$/;

export type ClaudeStoredTaskListRead =
  | { readonly status: "read"; readonly tasks: ReadonlyArray<ClaudeTask> }
  | { readonly status: "refused"; readonly reason: string };

function refused(reason: string): ClaudeStoredTaskListRead {
  return { status: "refused", reason };
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * The task list Claude stored for one session, so a resumed session's panel
 * shows the whole list rather than only the calls Octant sees from now on.
 * The folder is Claude's (`tasks/<session id>` under the account's
 * configuration directory, the session id with every character outside
 * `[A-Za-z0-9_-]` replaced by `-`, as Claude names it). Its files are
 * untrusted: only that session's folder is read, no symlink is followed out
 * of the configuration directory, sizes and counts are bounded, and every
 * task must match Claude's schema. Anything else refuses the whole list, so
 * the panel starts empty rather than partly right. No folder is an empty list.
 */
export async function readClaudeStoredTaskList(
  configDirectory: string,
  claudeSessionId: string,
): Promise<ClaudeStoredTaskListRead> {
  const listName = claudeSessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (listName.length === 0 || listName.length > 256) return refused("invalid session id");
  let root: string;
  try {
    root = await realpath(configDirectory);
  } catch (error) {
    return missing(error) ? { status: "read", tasks: [] } : refused("unreadable directory");
  }
  const tasksDirectory = join(root, "tasks");
  const listDirectory = join(tasksDirectory, listName);
  try {
    for (const directory of [tasksDirectory, listDirectory]) {
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return refused("not a plain folder");
    }
    if ((await realpath(listDirectory)) !== listDirectory) return refused("folder moved");
  } catch (error) {
    return missing(error) ? { status: "read", tasks: [] } : refused("unreadable folder");
  }
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(listDirectory);
  } catch (error) {
    return missing(error) ? { status: "read", tasks: [] } : refused("unreadable folder");
  }
  // Claude keeps a lock and a high-water mark beside the tasks; they start
  // with a dot and are not tasks.
  const files = names.filter((name) => STORED_TASK_FILE.test(name));
  if (files.length > MAX_TASKS) return refused("too many tasks");
  const tasks: ClaudeTask[] = [];
  let totalBytes = 0;
  for (const name of files) {
    const path = join(listDirectory, name);
    if (!path.startsWith(`${listDirectory}${sep}`)) return refused("task outside its folder");
    let text: string;
    try {
      // `O_NOFOLLOW` refuses a symlinked task file at open, after the check
      // above could have been raced.
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) return refused("task is not a file");
        if (stats.size > MAX_STORED_TASK_BYTES) return refused("task file too large");
        totalBytes += stats.size;
        if (totalBytes > MAX_STORED_LIST_BYTES) return refused("task list too large");
        const buffer = Buffer.alloc(MAX_STORED_TASK_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_STORED_TASK_BYTES) return refused("task file too large");
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Claude deletes a task file when the task is deleted; one gone since
      // the folder was listed is simply not in the list.
      if (missing(error)) continue;
      return refused("unreadable task file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refused("task file is not JSON");
    }
    const decoded = decodeStoredTask(parsed);
    if (decoded._tag === "Left") return refused("task file does not match Claude's schema");
    const task = decoded.right;
    const stem = STORED_TASK_FILE.exec(name)?.[1];
    if (task.id !== stem || task.subject.length > MAX_SUBJECT_CHARACTERS) {
      return refused("task file does not match Claude's schema");
    }
    // `TaskList` leaves out a task whose `_internal` metadata is set.
    if (task.metadata?._internal) continue;
    tasks.push({ id: task.id, subject: task.subject, status: task.status });
  }
  return { status: "read", tasks: tasks.sort(byClaudeOrder) };
}
