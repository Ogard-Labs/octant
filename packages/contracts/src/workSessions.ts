import { Schema } from "effect";
import { CodeLiveTask, CodeNativeSession } from "./codeSessions";
import { ProviderNativeSessionId } from "./providerNativeSession";
import { WorkThreadId } from "./workThreads";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The background tasks a Work thread's provider session still runs after the
 * turn that started them completed, as a Code thread's are read. Empty when
 * no session is kept. Not journaled: the tasks are processes on this host,
 * and a restart ends them.
 */
export const WorkLiveTasks = Schema.Struct({
  threadId: WorkThreadId,
  tasks: Schema.Array(CodeLiveTask).pipe(Schema.maxItems(64)),
  /** A turn holds the session now: the person's, or one the runtime started. */
  turnRunning: Schema.Boolean,
}).annotations(strict);
export type WorkLiveTasks = typeof WorkLiveTasks.Type;

/** The person stops a Work thread's live tasks, and the session that runs them. */
export const StopWorkLiveTasks = Schema.Struct({
  kind: Schema.Literal("stop-work-live-tasks"),
  threadId: WorkThreadId,
}).annotations(strict);
export type StopWorkLiveTasks = typeof StopWorkLiveTasks.Type;
export const decodeStopWorkLiveTasks = Schema.decodeUnknownSync(StopWorkLiveTasks);

export const StopWorkLiveTasksResult = Schema.Struct({
  kind: Schema.Literal("work-live-tasks-stopped"),
  /** Whether a kept session was running; false when there was nothing to stop. */
  stopped: Schema.Boolean,
}).annotations(strict);
export type StopWorkLiveTasksResult = typeof StopWorkLiveTasksResult.Type;

/**
 * What a Work thread offers of its provider's own sessions for the folder its
 * turns run in. `adopted` names the session the thread continues, when it was
 * started from one; `sessions` lists those it may still start from, and is
 * empty once the thread has a turn or a session of its own.
 */
export const WorkNativeSessions = Schema.Struct({
  threadId: WorkThreadId,
  adopted: Schema.optional(
    Schema.Struct({ nativeSessionId: ProviderNativeSessionId }).annotations(strict),
  ),
  sessions: Schema.Array(CodeNativeSession).pipe(Schema.maxItems(50)),
  /** Why the thread cannot start from a session, when it cannot. */
  unavailable: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type WorkNativeSessions = typeof WorkNativeSessions.Type;

/**
 * The person starts an empty Work thread from a provider session begun
 * outside Octant in the folder the thread works in: its first turn resumes
 * that session.
 */
export const AdoptWorkNativeSession = Schema.Struct({
  kind: Schema.Literal("adopt-work-native-session"),
  threadId: WorkThreadId,
  nativeSessionId: ProviderNativeSessionId,
}).annotations(strict);
export type AdoptWorkNativeSession = typeof AdoptWorkNativeSession.Type;
export const decodeAdoptWorkNativeSession = Schema.decodeUnknownSync(AdoptWorkNativeSession);

export const AdoptWorkNativeSessionResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("work-native-session-adopted"),
    threadId: WorkThreadId,
    nativeSessionId: ProviderNativeSessionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("work-native-session-refused"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type AdoptWorkNativeSessionResult = typeof AdoptWorkNativeSessionResult.Type;
