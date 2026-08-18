import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  decodeThreadCheckpoint,
  decodeThreadCheckpointCommand,
  decodeThreadCheckpointId,
  type ChatThreadId,
  type ChatTurnId,
  type CodeOperationId,
  type CodeThreadId,
  type EventActor as EventActorValue,
  type ThreadCheckpoint,
  type ThreadCheckpointCommandResult,
  type ThreadCheckpointId,
  type ThreadCheckpointRefusalReason,
} from "@octant/contracts";
import type { WindowId } from "@octant/contracts/shell";
import {
  planThreadCheckpointMark,
  planThreadCheckpointRestore,
  type CheckpointChatThreadFacts,
  type CheckpointCodeThreadFacts,
  type CheckpointThreadFacts,
} from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export type ThreadCheckpointErrorCategory = "invalid" | "conflict" | "unavailable";

export class ThreadCheckpointError extends Error {
  readonly category: ThreadCheckpointErrorCategory;

  constructor(category: ThreadCheckpointErrorCategory, message: string) {
    super(message);
    this.name = "ThreadCheckpointError";
    this.category = category;
  }
}

/** What a restore produced, or why the mode's own service turned it down. */
export type CheckpointRestoreOutcome<Id> =
  | Readonly<{ status: "created"; threadId: Id }>
  | Readonly<{ status: "refused"; reason: ThreadCheckpointRefusalReason }>;

export interface ThreadCheckpointChatPort {
  readonly facts: (
    threadId: ChatThreadId,
    turnId: ChatTurnId,
  ) => CheckpointChatThreadFacts | undefined;
  /** Branch the conversation through the marked turn into a second thread. */
  readonly branch: (input: {
    readonly authenticatedWindowId: WindowId;
    readonly threadId: ChatThreadId;
    readonly turnId: ChatTurnId;
    readonly title: string;
  }) => Promise<CheckpointRestoreOutcome<ChatThreadId>>;
}

export interface ThreadCheckpointCodePort {
  readonly facts: (
    threadId: CodeThreadId,
    operationId: CodeOperationId,
  ) => CheckpointCodeThreadFacts | undefined;
  /** Start a thread on its own managed worktree at the marked revision. */
  readonly restore: (input: {
    readonly authenticatedWindowId: WindowId;
    readonly sourceThreadId: CodeThreadId;
    readonly operationId: CodeOperationId;
    readonly revision: string;
    readonly title: string;
  }) => Promise<CheckpointRestoreOutcome<CodeThreadId>>;
}

export interface ThreadCheckpointServiceOptions {
  readonly journal: Pick<Journal, "append">;
  readonly readCheckpoint: (checkpointId: ThreadCheckpointId) => ThreadCheckpoint | undefined;
  readonly readCheckpoints: (threadId: string) => ReadonlyArray<ThreadCheckpoint>;
  /**
   * Whether this window may see work filed under this Project. A checkpoint
   * carries a user-written label, so listing one is a read of the thread it
   * marks and is gated the same way the thread itself is.
   */
  readonly canAccess: (
    authenticatedWindowId: WindowId,
    projectId: string | undefined,
  ) => Promise<boolean>;
  readonly chat: ThreadCheckpointChatPort;
  /** Absent on a host assembled without Code, where a Code anchor names no thread. */
  readonly code?: ThreadCheckpointCodePort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * Checkpoints: the points a user marks in a thread so the work can be taken up
 * again from there.
 *
 * Two invariants hold throughout. Marking records where a turn already is, so a
 * checkpoint never copies or freezes state — the journal is the state, and this
 * service only appends markers to it. Restoring produces a *second* thread, so
 * nothing about the marked thread changes: no turn is rewritten, no checkout is
 * moved, and no journal event is retracted. "Rewind" in Octant always means
 * "take this up again over there".
 *
 * Authority stays where it already lives. This service resolves facts and
 * decides shape; the Chat and Code services it delegates to run their own
 * Project, thread, approval, and worktree checks before creating anything, and
 * a refusal from either is reported as the user-facing reason rather than
 * swallowed.
 */
export class ThreadCheckpointService {
  readonly #options: ThreadCheckpointServiceOptions;
  readonly #actor: EventActorValue;

  constructor(options: ThreadCheckpointServiceOptions) {
    this.#options = options;
    const actor = decodeActor(options.actor);
    decodeActorId(actor.actorId);
    this.#actor = actor;
  }

  async list(
    authenticatedWindowId: WindowId,
    threadId: string,
  ): Promise<ReadonlyArray<ThreadCheckpoint>> {
    if (threadId.trim().length === 0) {
      throw new ThreadCheckpointError("invalid", "Checkpoint thread is invalid.");
    }
    const checkpoints = this.#options.readCheckpoints(threadId);
    const visible: ThreadCheckpoint[] = [];
    for (const checkpoint of checkpoints) {
      if (await this.#options.canAccess(authenticatedWindowId, checkpoint.projectId)) {
        visible.push(checkpoint);
      }
    }
    return visible;
  }

  async execute(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<ThreadCheckpointCommandResult> {
    let command;
    try {
      command = decodeThreadCheckpointCommand(input);
    } catch {
      throw new ThreadCheckpointError("invalid", "Checkpoint command is invalid.");
    }
    if (command.kind === "mark-thread-checkpoint") {
      return this.#mark(authenticatedWindowId, command);
    }
    if (command.kind === "forget-thread-checkpoint") {
      return this.#forget(authenticatedWindowId, command);
    }
    return this.#restore(authenticatedWindowId, command);
  }

  async #mark(
    authenticatedWindowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeThreadCheckpointCommand>,
      { kind: "mark-thread-checkpoint" }
    >,
  ): Promise<ThreadCheckpointCommandResult> {
    const checkpointId = command.checkpointId ?? decodeThreadCheckpointId(this.#options.uuid());
    if (this.#options.readCheckpoint(checkpointId) !== undefined) {
      throw new ThreadCheckpointError("conflict", "Checkpoint ID is already in use.");
    }
    const plan = planThreadCheckpointMark({
      anchor: command.anchor,
      thread: this.#facts(command.anchor),
    });
    if (plan.status === "refuses") return { kind: "checkpoint-refused", reason: plan.reason };
    if (!(await this.#options.canAccess(authenticatedWindowId, plan.projectId))) {
      throw new ThreadCheckpointError("invalid", "Checkpoint thread is unavailable.");
    }

    const timestamp = decodeTimestamp(this.#options.clock());
    const checkpoint = decodeThreadCheckpoint({
      id: checkpointId,
      anchor: plan.anchor,
      label: command.label,
      ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
      lifecycle: "marked",
      restoreCount: 0,
      markedAt: timestamp,
      version: 1,
      updatedAt: timestamp,
    });
    this.#append(checkpoint, 0, "checkpoint.marked@1", {
      kind: "checkpoint-marked",
      checkpoint,
    });
    return { kind: "checkpoint-marked", checkpoint };
  }

  async #forget(
    authenticatedWindowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeThreadCheckpointCommand>,
      { kind: "forget-thread-checkpoint" }
    >,
  ): Promise<ThreadCheckpointCommandResult> {
    const current = this.#require(command.checkpointId, command.expectedVersion);
    if (!(await this.#options.canAccess(authenticatedWindowId, current.projectId))) {
      throw new ThreadCheckpointError("invalid", "Checkpoint was not found.");
    }
    const forgotten = decodeThreadCheckpoint({
      ...current,
      lifecycle: "forgotten",
      version: current.version + 1,
      updatedAt: decodeTimestamp(this.#options.clock()),
    });
    this.#append(forgotten, current.version, "checkpoint.forgotten@1", {
      kind: "checkpoint-forgotten",
      checkpoint: forgotten,
    });
    return { kind: "checkpoint-forgotten", checkpoint: forgotten };
  }

  async #restore(
    authenticatedWindowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeThreadCheckpointCommand>,
      { kind: "restore-from-thread-checkpoint" }
    >,
  ): Promise<ThreadCheckpointCommandResult> {
    const current = this.#require(command.checkpointId, command.expectedVersion);
    if (!(await this.#options.canAccess(authenticatedWindowId, current.projectId))) {
      throw new ThreadCheckpointError("invalid", "Checkpoint was not found.");
    }
    const plan = planThreadCheckpointRestore({
      checkpoint: current,
      thread: this.#facts(current.anchor),
    });
    if (plan.status === "refuses") return { kind: "checkpoint-refused", reason: plan.reason };

    // The thread is created first and the marker updated after, so a journal
    // failure leaves a real thread whose own provenance still names where it
    // came from. Recording the restore first would leave the opposite: a
    // checkpoint claiming a thread nobody can open.
    let restore: ThreadCheckpointRestoreValue;
    if (current.anchor.mode === "chat") {
      const outcome = await this.#options.chat.branch({
        authenticatedWindowId,
        threadId: current.anchor.threadId,
        turnId: current.anchor.turnId,
        title: command.title,
      });
      if (outcome.status === "refused")
        return { kind: "checkpoint-refused", reason: outcome.reason };
      restore = { mode: "chat", threadId: outcome.threadId };
    } else {
      const code = this.#options.code;
      if (code === undefined) return { kind: "checkpoint-refused", reason: "restore-unavailable" };
      const outcome = await code.restore({
        authenticatedWindowId,
        sourceThreadId: current.anchor.threadId,
        operationId: current.anchor.operationId,
        revision: current.anchor.revision,
        title: command.title,
      });
      if (outcome.status === "refused")
        return { kind: "checkpoint-refused", reason: outcome.reason };
      restore = { mode: "code", threadId: outcome.threadId };
    }

    const restoredAt = decodeTimestamp(this.#options.clock());
    const restored = decodeThreadCheckpoint({
      ...current,
      restoreCount: current.restoreCount + 1,
      lastRestoredAt: restoredAt,
      version: current.version + 1,
      updatedAt: restoredAt,
    });
    this.#append(restored, current.version, "checkpoint.restored@1", {
      kind: "checkpoint-restored",
      checkpoint: restored,
      restore,
    });
    return { kind: "checkpoint-restored", checkpoint: restored, restore };
  }

  #facts(anchor: ThreadCheckpointAnchorLike): CheckpointThreadFacts | undefined {
    if (anchor.mode === "chat") return this.#options.chat.facts(anchor.threadId, anchor.turnId);
    return this.#options.code?.facts(anchor.threadId, anchor.operationId);
  }

  #require(checkpointId: ThreadCheckpointId, expectedVersion: number): ThreadCheckpoint {
    const current = this.#options.readCheckpoint(checkpointId);
    if (current === undefined) {
      throw new ThreadCheckpointError("invalid", "Checkpoint was not found.");
    }
    if (current.version !== expectedVersion) {
      throw new ThreadCheckpointError("conflict", "Checkpoint has changed since it was read.");
    }
    return current;
  }

  #append(
    checkpoint: ThreadCheckpoint,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: "thread-checkpoint",
        aggregateId: decodeAggregateId(String(checkpoint.id)),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: this.#actor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload,
        },
      ],
    });
  }
}

type ThreadCheckpointRestoreValue =
  | Readonly<{ mode: "chat"; threadId: ChatThreadId }>
  | Readonly<{ mode: "code"; threadId: CodeThreadId }>;

type ThreadCheckpointAnchorLike =
  | Readonly<{ mode: "chat"; threadId: ChatThreadId; turnId: ChatTurnId }>
  | Readonly<{ mode: "code"; threadId: CodeThreadId; operationId: CodeOperationId }>;
