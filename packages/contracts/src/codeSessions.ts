import { Schema } from "effect";
import { CodeThreadId } from "./code";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Why the host opened a turn the runtime started by itself in a thread's kept
 * session. It is recorded as the turn's prompt and never sent to the runtime,
 * which is already running that turn.
 */
export const RUNTIME_STARTED_TURN_PROMPT =
  "The agent started this turn by itself after background work it was running reported.";

/** One background task a thread's kept session still runs. */
export const CodeLiveTask = Schema.Struct({
  taskId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type CodeLiveTask = typeof CodeLiveTask.Type;

/**
 * The background tasks a Code thread's provider session still runs after the
 * turn that started them completed. Empty when no session is kept. Not
 * journaled: the tasks are processes on this host, and a restart ends them.
 */
export const CodeLiveTasks = Schema.Struct({
  threadId: CodeThreadId,
  tasks: Schema.Array(CodeLiveTask).pipe(Schema.maxItems(64)),
  /** A turn holds the session now: the person's, or one the runtime started. */
  turnRunning: Schema.Boolean,
}).annotations(strict);
export type CodeLiveTasks = typeof CodeLiveTasks.Type;

/** The person stops a thread's live tasks, and the session that runs them. */
export const StopCodeLiveTasks = Schema.Struct({
  kind: Schema.Literal("stop-code-live-tasks"),
  threadId: CodeThreadId,
}).annotations(strict);
export type StopCodeLiveTasks = typeof StopCodeLiveTasks.Type;
export const decodeStopCodeLiveTasks = Schema.decodeUnknownSync(StopCodeLiveTasks);

export const StopCodeLiveTasksResult = Schema.Struct({
  kind: Schema.Literal("code-live-tasks-stopped"),
  /** Whether a kept session was running; false when there was nothing to stop. */
  stopped: Schema.Boolean,
}).annotations(strict);
export type StopCodeLiveTasksResult = typeof StopCodeLiveTasksResult.Type;
