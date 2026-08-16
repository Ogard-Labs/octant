import {
  ActorId,
  AggregateVersion,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeChatFailure,
  ThreadFollowUpCommand as ThreadFollowUpCommandSchema,
  ThreadWorkCommand as ThreadWorkCommandSchema,
  type ChatFailure,
  type ChatThreadId,
  type ThreadFollowUp,
  type ThreadFollowUpUpdated,
  type ThreadWorkUpdated,
} from "@octant/contracts";
import {
  ThreadWorkPolicyRejected,
  applyThreadWorkCommand,
  completeFollowUp,
  evaluateFollowUpTrigger,
  type ThreadWorkList,
} from "@octant/domain/thread-work-policy";
import { defaultShellSettings } from "@octant/domain";
import { Schema } from "effect";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import { ProjectionApplicationFailed } from "../persistence/projection";
import {
  hasProcessedFollowUpTrigger,
  readAggregateVersion,
  readThreadFollowUp,
  readThreadWorkList,
  readThreadWorkState,
  type ProjectedThreadWorkState,
} from "../persistence/chatProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeThreadWorkCommand = Schema.decodeUnknownSync(ThreadWorkCommandSchema);
const decodeThreadFollowUpCommand = Schema.decodeUnknownSync(ThreadFollowUpCommandSchema);
type ThreadWorkCommand = ReturnType<typeof decodeThreadWorkCommand>;
type ThreadFollowUpCommand = ReturnType<typeof decodeThreadFollowUpCommand>;

export type ThreadWorkCommandResult = ThreadWorkUpdated | ThreadFollowUpUpdated;

export interface ThreadFollowUpTriggerObservation {
  readonly threadId: ChatThreadId;
  readonly sourceEventId: string;
  readonly sourceSequence: number;
  readonly reason: string;
  readonly origin: "manual" | "automatic";
  readonly triggeredAt: string;
}

export interface ThreadWorkServiceOptions {
  readonly persistence: PersistenceService;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class ThreadWorkServiceError extends Error {
  override readonly name = "ThreadWorkServiceError";

  constructor(readonly failure: ChatFailure) {
    super(failure.message);
  }
}

export class ThreadWorkService {
  readonly #persistence: PersistenceService;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: ThreadWorkServiceOptions) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  read(threadId: ChatThreadId): ProjectedThreadWorkState {
    this.#assertReadableThread(threadId);
    return readThreadWorkState(this.#persistence.connection, threadId);
  }

  async execute(input: unknown): Promise<ThreadWorkCommandResult> {
    try {
      this.#assertChatEnabled();
      if (this.#isFollowUpCommand(input)) {
        return await this.#executeFollowUp(decodeThreadFollowUpCommand(input));
      }
      return await this.#executeWork(decodeThreadWorkCommand(input));
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async observeTrigger(input: ThreadFollowUpTriggerObservation): Promise<ThreadFollowUp> {
    this.#assertChatEnabled();
    this.#assertMutableThread(input.threadId);
    try {
      if (
        hasProcessedFollowUpTrigger(
          this.#persistence.connection,
          input.threadId,
          input.sourceEventId,
        )
      ) {
        return this.#requireFollowUpProjection(input.threadId);
      }

      const current = readThreadFollowUp(this.#persistence.connection, input.threadId);
      const next = evaluateFollowUpTrigger(input.threadId, current, {
        sequence: input.sourceSequence,
        reason: input.reason,
        origin: input.origin,
        triggeredAt: decodeTimestamp(input.triggeredAt),
      });
      if (this.#followUpEquivalent(current, next)) {
        return next;
      }

      const expectedVersion = readAggregateVersion(
        this.#persistence.connection,
        "thread-follow-up",
        input.threadId,
      );
      this.#appendFollowUp(input.threadId, expectedVersion, next, {
        causationId: input.sourceEventId,
        actorKind: "system",
      });
      return this.#requireFollowUpProjection(input.threadId);
    } catch (error) {
      if (
        error instanceof ConcurrencyConflict &&
        hasProcessedFollowUpTrigger(
          this.#persistence.connection,
          input.threadId,
          input.sourceEventId,
        )
      ) {
        return this.#requireFollowUpProjection(input.threadId);
      }
      throw this.#mapFailure(error);
    }
  }

  async #executeWork(command: ThreadWorkCommand): Promise<ThreadWorkUpdated> {
    this.#assertReady();
    this.#assertMutableThread(command.threadId);
    try {
      const current = readThreadWorkList(this.#persistence.connection, command.threadId);
      const timestamp = decodeTimestamp(this.#clock());
      const next = applyThreadWorkCommand(current, command, timestamp);
      const changedItems = this.#changedWorkItems(current, next);
      if (changedItems.length === 0) {
        throw new ThreadWorkServiceError({
          category: "invalid",
          message: "Work command made no changes.",
        });
      }

      this.#persistence.journal.append({
        aggregate: { aggregateType: "thread-work-list", aggregateId: command.threadId },
        expectedVersion: command.expectedVersion,
        events: changedItems.map((workItem) =>
          this.#pendingEvent(
            "thread.work-updated@1",
            { kind: "work-updated", workItem: this.#serializeWorkItem(workItem) },
            command.threadId,
          ),
        ),
      });

      const authoritative = this.#requireWorkItem(command.threadId, changedItems.at(-1)!.id);
      return { kind: "work-updated", workItem: authoritative };
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async #executeFollowUp(command: ThreadFollowUpCommand): Promise<ThreadFollowUpUpdated> {
    this.#assertReady();
    this.#assertMutableThread(command.threadId);
    try {
      const timestamp = decodeTimestamp(this.#clock());
      const currentVersion = readAggregateVersion(
        this.#persistence.connection,
        "thread-follow-up",
        command.threadId,
      );
      if (currentVersion !== command.expectedVersion) {
        throw new ThreadWorkServiceError(
          decodeChatFailure({
            category: "stale",
            message: "Thread follow-up changed; reload and retry.",
          }),
        );
      }
      const current = readThreadFollowUp(this.#persistence.connection, command.threadId);
      const next =
        command.kind === "open-chat-follow-up"
          ? evaluateFollowUpTrigger(command.threadId, current, {
              sequence: command.triggerSequence,
              reason: command.reason,
              origin: command.origin,
              triggeredAt: timestamp,
            })
          : completeFollowUp(currentVersion, this.#requireOpenFollowUp(current, command.threadId), {
              expectedVersion: command.expectedVersion,
              acknowledgedThroughSequence: command.acknowledgedThroughSequence,
              completedAt: timestamp,
            });

      if (this.#followUpEquivalent(current, next)) {
        return {
          kind: "follow-up-updated",
          followUp: this.#requireFollowUpProjection(command.threadId),
        };
      }

      this.#appendFollowUp(command.threadId, command.expectedVersion, next);
      return {
        kind: "follow-up-updated",
        followUp: this.#requireFollowUpProjection(command.threadId),
      };
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  #appendFollowUp(
    threadId: ChatThreadId,
    expectedVersion: AggregateVersion,
    followUp: ThreadFollowUp,
    options?: { readonly causationId?: string; readonly actorKind?: "local-user" | "system" },
  ): void {
    this.#persistence.journal.append({
      aggregate: { aggregateType: "thread-follow-up", aggregateId: threadId },
      expectedVersion,
      events: [
        this.#pendingEvent(
          "thread.follow-up-updated@1",
          { kind: "follow-up-updated", followUp: this.#serializeFollowUp(followUp) },
          threadId,
          options?.causationId,
          options?.actorKind ?? "local-user",
        ),
      ],
    });
  }

  #serializeWorkItem(item: ThreadWorkList["items"][number]): ThreadWorkList["items"][number] {
    const { detail, ...rest } = item;
    return detail === undefined ? rest : { ...rest, detail };
  }

  #serializeFollowUp(followUp: ThreadFollowUp): ThreadFollowUp {
    const { completedAt, ...rest } = followUp;
    return completedAt === undefined ? rest : { ...rest, completedAt };
  }

  #changedWorkItems(before: ThreadWorkList, after: ThreadWorkList): ThreadWorkList["items"] {
    const beforeById = new Map(before.items.map((item) => [String(item.id), item]));
    return after.items.filter((item) => {
      const previous = beforeById.get(String(item.id));
      return previous === undefined || JSON.stringify(previous) !== JSON.stringify(item);
    });
  }

  #requireWorkItem(threadId: ChatThreadId, itemId: ThreadWorkList["items"][number]["id"]) {
    const item = readThreadWorkList(this.#persistence.connection, threadId).items.find(
      (candidate) => String(candidate.id) === String(itemId),
    );
    if (item === undefined) {
      throw new ThreadWorkServiceError({
        category: "invalid",
        message: "Thread work item projection is inconsistent.",
      });
    }
    return item;
  }

  #requireFollowUpProjection(threadId: ChatThreadId): ThreadFollowUp {
    const followUp = readThreadFollowUp(this.#persistence.connection, threadId);
    if (followUp === undefined) {
      throw new ThreadWorkServiceError({
        category: "invalid",
        message: "Thread follow-up projection is inconsistent.",
      });
    }
    return followUp;
  }

  #requireOpenFollowUp(
    followUp: ThreadFollowUp | undefined,
    threadId: ChatThreadId,
  ): ThreadFollowUp {
    if (followUp === undefined || followUp.threadId !== threadId || followUp.state !== "open") {
      throw new ThreadWorkServiceError({
        category: "invalid",
        message: "Thread follow-up is not open.",
      });
    }
    return followUp;
  }

  #followUpEquivalent(current: ThreadFollowUp | undefined, next: ThreadFollowUp): boolean {
    return current !== undefined && JSON.stringify(current) === JSON.stringify(next);
  }

  #pendingEvent(
    eventName: string,
    payload: unknown,
    threadId: ChatThreadId,
    causationId?: string,
    actorKind: "local-user" | "system" = "local-user",
  ) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      correlationId: decodeCorrelationId(this.#uuid()),
      causationId: causationId === undefined ? undefined : decodeEventId(causationId),
      actor: { kind: actorKind, actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #assertReadableThread(threadId: ChatThreadId): void {
    const thread = this.#persistence.readChatThread(threadId);
    if (thread === undefined || thread.lifecycle === "deleted") {
      throw new ThreadWorkServiceError({
        category: "invalid",
        message: "Chat thread was not found.",
      });
    }
    if (String(thread.id) !== String(threadId)) {
      throw new ThreadWorkServiceError({
        category: "invalid",
        message: "Chat thread identity is inconsistent.",
      });
    }
  }

  #assertMutableThread(threadId: ChatThreadId): void {
    this.#assertReadableThread(threadId);
    const thread = this.#persistence.readChatThread(threadId);
    if (thread?.lifecycle !== "active") {
      throw new ThreadWorkServiceError({
        category: "invalid",
        message: `Chat thread is ${thread?.lifecycle ?? "unavailable"}.`,
      });
    }
  }

  #assertReady(): void {
    try {
      const status = this.#persistence.status();
      if (status.state !== "current" || status.integrity !== "ok") {
        throw new Error("not ready");
      }
    } catch (error) {
      if (error instanceof ThreadWorkServiceError) throw error;
      throw this.#unavailable();
    }
  }

  #assertChatEnabled(): void {
    this.#assertReady();
    const settings = this.#persistence.readShellSettings()?.settings ?? defaultShellSettings();
    if (!settings.chatEnabled) {
      throw new ThreadWorkServiceError(
        decodeChatFailure({ category: "unavailable", message: "Chat mode is disabled." }),
      );
    }
  }

  #isFollowUpCommand(input: unknown): input is ThreadFollowUpCommand {
    return (
      typeof input === "object" &&
      input !== null &&
      "kind" in input &&
      (input.kind === "open-chat-follow-up" || input.kind === "complete-chat-follow-up")
    );
  }

  #mapFailure(error: unknown): ThreadWorkServiceError {
    if (error instanceof ThreadWorkServiceError) return error;
    if (error instanceof ThreadWorkPolicyRejected) {
      if (error.code === "stale-version") {
        return new ThreadWorkServiceError(
          decodeChatFailure({
            category: "stale",
            message: "Thread work changed; reload and retry.",
          }),
        );
      }
      return new ThreadWorkServiceError(
        decodeChatFailure({ category: "invalid", message: error.message }),
      );
    }
    if (error instanceof ConcurrencyConflict) {
      return new ThreadWorkServiceError(
        decodeChatFailure({
          category: "stale",
          message: "Thread work changed; reload and retry.",
        }),
      );
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#unavailable();
    }
    if (error instanceof Error && error.name === "EventPayloadInvalid") {
      return new ThreadWorkServiceError(
        decodeChatFailure({ category: "invalid", message: "Thread work command is invalid." }),
      );
    }
    return this.#unavailable();
  }

  #unavailable(): ThreadWorkServiceError {
    return new ThreadWorkServiceError(
      decodeChatFailure({
        category: "unavailable",
        message: "Thread work storage is unavailable.",
      }),
    );
  }
}
