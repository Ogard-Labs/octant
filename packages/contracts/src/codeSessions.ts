import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { CodeNativeSessionId } from "./codeOperations";

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

/**
 * A session the thread's provider keeps for the same account and folder,
 * begun outside Octant, that the person may continue in this thread. Its
 * title is the runtime's own (a name the person gave it, or its summary) and
 * is shown, never journaled.
 */
export const CodeNativeSession = Schema.Struct({
  nativeSessionId: CodeNativeSessionId,
  title: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  /** When the runtime last wrote the session, in milliseconds since the epoch. */
  lastModified: Schema.Number.pipe(Schema.nonNegative()),
  gitBranch: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
}).annotations(strict);
export type CodeNativeSession = typeof CodeNativeSession.Type;

/**
 * What a Code thread offers of its provider's own sessions. `adopted` names
 * the session the thread continues, when it was started from one; `sessions`
 * lists those it may still start from, and is empty once the thread has a
 * message or a session of its own.
 */
export const CodeNativeSessions = Schema.Struct({
  threadId: CodeThreadId,
  adopted: Schema.optional(
    Schema.Struct({ nativeSessionId: CodeNativeSessionId }).annotations(strict),
  ),
  sessions: Schema.Array(CodeNativeSession).pipe(Schema.maxItems(50)),
  /** Why the thread cannot start from a session, when it cannot. */
  unavailable: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type CodeNativeSessions = typeof CodeNativeSessions.Type;

/**
 * The person starts an empty Code thread from a provider session begun
 * outside Octant: the thread's next turn resumes that session.
 */
export const AdoptCodeNativeSession = Schema.Struct({
  kind: Schema.Literal("adopt-code-native-session"),
  threadId: CodeThreadId,
  nativeSessionId: CodeNativeSessionId,
}).annotations(strict);
export type AdoptCodeNativeSession = typeof AdoptCodeNativeSession.Type;
export const decodeAdoptCodeNativeSession = Schema.decodeUnknownSync(AdoptCodeNativeSession);

export const AdoptCodeNativeSessionResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("code-native-session-adopted"),
    threadId: CodeThreadId,
    nativeSessionId: CodeNativeSessionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-native-session-refused"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type AdoptCodeNativeSessionResult = typeof AdoptCodeNativeSessionResult.Type;
