import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import { CodeNativeSessionId } from "./codeOperations";
import { ImportedSessionHistory } from "./importedSessionHistory";

/**
 * Why the host opened a turn the runtime started by itself in a thread's kept
 * session. It is recorded as the turn's prompt and never sent to the runtime,
 * which is already running that turn.
 */
export const RUNTIME_STARTED_TURN_PROMPT =
  "The agent started this turn by itself after background work it was running reported.";

/**
 * What the host sends, as itself, to start the turn after the person approved
 * a plan. Fixed text: it tells the agent to go on and records in the thread
 * why a turn nobody typed exists. A Code and a Work thread send the same one.
 */
export const PLAN_APPROVED_TURN_PROMPT =
  "Octant started this turn: the person approved your plan and the thread has left Plan. Carry the plan out now.";

/** One background task a thread's kept session still runs. */
export const CodeLiveTask = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type CodeLiveTask = typeof CodeLiveTask.Type;

/**
 * The background tasks a Code thread's provider session still runs after the
 * turn that started them completed. Empty when no session is kept. Not
 * journaled: the tasks are processes on this host, and a restart ends them.
 */
export const CodeLiveTasks = Schema.Struct({
  threadId: CodeThreadId,
  tasks: Schema.Array(CodeLiveTask).check(Schema.isMaxLength(64)),
  /** A turn holds the session now: the person's, or one the runtime started. */
  turnRunning: Schema.Boolean,
});
export type CodeLiveTasks = typeof CodeLiveTasks.Type;

/** The person stops a thread's live tasks, and the session that runs them. */
export const StopCodeLiveTasks = Schema.Struct({
  kind: Schema.Literal("stop-code-live-tasks"),
  threadId: CodeThreadId,
});
export type StopCodeLiveTasks = typeof StopCodeLiveTasks.Type;
export const decodeStopCodeLiveTasks = Schema.decodeUnknownSync(
  StopCodeLiveTasks,
  STRICT_DECODE_OPTIONS,
);

export const StopCodeLiveTasksResult = Schema.Struct({
  kind: Schema.Literal("code-live-tasks-stopped"),
  /** Whether a kept session was running; false when there was nothing to stop. */
  stopped: Schema.Boolean,
});
export type StopCodeLiveTasksResult = typeof StopCodeLiveTasksResult.Type;

/**
 * A session the thread's provider keeps for the same account and folder,
 * begun outside Octant, that the person may continue in this thread. Its
 * title is the runtime's own (a name the person gave it, or its summary) and
 * is shown, never journaled.
 */
export const CodeNativeSession = Schema.Struct({
  nativeSessionId: CodeNativeSessionId,
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** When the runtime last wrote the session, in milliseconds since the epoch. */
  lastModified: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  gitBranch: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type CodeNativeSession = typeof CodeNativeSession.Type;

/**
 * What a Code thread offers of its provider's own sessions. `adopted` names
 * the session the thread continues, when it was started from one, with the
 * earlier conversation its adoption imported; `sessions`
 * lists those it may still start from, and is empty once the thread has a
 * message or a session of its own.
 */
export const CodeNativeSessions = Schema.Struct({
  threadId: CodeThreadId,
  adopted: Schema.optional(
    Schema.Struct({
      nativeSessionId: CodeNativeSessionId,
      /**
       * The session's earlier conversation as the adoption imported it.
       * Absent on a thread adopted before Octant imported any.
       */
      history: Schema.optional(ImportedSessionHistory),
    }),
  ),
  sessions: Schema.Array(CodeNativeSession).check(Schema.isMaxLength(50)),
  /** Why the thread cannot start from a session, when it cannot. */
  unavailable: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type CodeNativeSessions = typeof CodeNativeSessions.Type;

/**
 * The person starts an empty Code thread from a provider session begun
 * outside Octant: the thread's next turn resumes that session.
 */
export const AdoptCodeNativeSession = Schema.Struct({
  kind: Schema.Literal("adopt-code-native-session"),
  threadId: CodeThreadId,
  nativeSessionId: CodeNativeSessionId,
});
export type AdoptCodeNativeSession = typeof AdoptCodeNativeSession.Type;
export const decodeAdoptCodeNativeSession = Schema.decodeUnknownSync(
  AdoptCodeNativeSession,
  STRICT_DECODE_OPTIONS,
);

export const AdoptCodeNativeSessionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("code-native-session-adopted"),
    threadId: CodeThreadId,
    nativeSessionId: CodeNativeSessionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-native-session-refused"),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type AdoptCodeNativeSessionResult = typeof AdoptCodeNativeSessionResult.Type;
