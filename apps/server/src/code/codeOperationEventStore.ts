import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CodeOperationEventFrame,
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  MAX_CODE_CONVERSATION_ASSISTANT_PARTS,
  MAX_CODE_CONVERSATION_TURN_STEPS,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  UtcTimestamp,
  decodeCodeOperationEventFrame,
  decodeCodeConversationPage,
  decodeCodeOperationId,
  decodeCodeThreadId,
  type CodeOperationEvent,
  type CodeConversationPage,
  type CodeConversationStep,
  type CodeConversationTurn,
  type CodeProviderLimit,
  type CodeOperationId,
  type CodeThreadId,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

export const CODE_OPERATION_EVENT_RECORDED = "code.operation-event-recorded@1";
export const MAX_CODE_OPERATION_REPLAY_LIMIT = 256;

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 10_000;
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

type JournalPort = Pick<Journal, "append" | "replay">;

export class CodeOperationEventStoreError extends Error {
  override readonly name = "CodeOperationEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: CodeOperationEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface CodeOperationEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendCodeOperationEventInput {
  readonly threadId: CodeThreadId;
  readonly operationId: CodeOperationId;
  readonly expectedCursor: number;
  readonly event: CodeOperationEvent;
}

export interface ReplayCodeOperationEventsInput {
  readonly threadId: CodeThreadId;
  readonly operationId: CodeOperationId;
  readonly afterCursor: number;
  readonly limit: number;
}

export interface ReadCodeConversationInput {
  readonly threadId: CodeThreadId;
  readonly afterCursor: number;
  readonly limit: number;
}

export type CodeOperationEventReplay =
  | {
      readonly status: "ok";
      readonly frames: ReadonlyArray<typeof CodeOperationEventFrame.Type>;
      readonly nextCursor: number;
    }
  | {
      readonly status: "snapshot-required";
      readonly reason:
        | "gap"
        | "identity-mismatch"
        | "invalid-frame"
        | "cursor-ahead"
        | "scan-limit";
    };

export class CodeOperationEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: CodeOperationEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    try {
      this.#actor = decodeActor(options.actor);
      decodeActorId(this.#actor.actorId);
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code operation event actor is invalid.");
    }
  }

  append(input: AppendCodeOperationEventInput): typeof CodeOperationEventFrame.Type {
    let frame: typeof CodeOperationEventFrame.Type;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      const operationId = decodeCodeOperationId(input.operationId);
      const threadId = decodeCodeThreadId(input.threadId);
      expectedVersion = decodeAggregateVersion(input.expectedCursor);
      aggregateId = decodeAggregateId(operationId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      frame = decodeCodeOperationEventFrame({
        threadId,
        operationId,
        cursor: input.expectedCursor + 1,
        occurredAt: decodeTimestamp(this.#clock()),
        event: input.event,
      });
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code operation event append is invalid.");
    }

    const committed = this.#journal.append({
      aggregate: { aggregateType: "code-operation", aggregateId },
      expectedVersion,
      events: [
        {
          eventId,
          eventName: CODE_OPERATION_EVENT_RECORDED,
          eventVersion: 1,
          correlationId,
          actor: this.#actor,
          occurredAt: frame.occurredAt,
          payload: frame,
        },
      ],
    });
    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== "code-operation" ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== frame.cursor ||
      envelope.eventName !== CODE_OPERATION_EVENT_RECORDED ||
      envelope.eventVersion !== 1 ||
      !sameFrame(envelope.payload, frame)
    ) {
      throw new CodeOperationEventStoreError(
        "journal-mismatch",
        "Committed Code operation event does not match its append.",
      );
    }
    return frame;
  }

  replay(input: ReplayCodeOperationEventsInput): CodeOperationEventReplay {
    let threadId: CodeThreadId;
    let operationId: CodeOperationId;
    try {
      threadId = decodeCodeThreadId(input.threadId);
      operationId = decodeCodeOperationId(input.operationId);
      if (
        !Number.isSafeInteger(input.afterCursor) ||
        input.afterCursor < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_CODE_OPERATION_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor");
      }
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code operation event replay is invalid.");
    }

    const frames: Array<typeof CodeOperationEventFrame.Type> = [];
    let expectedCursor = 1;
    let afterSequence = 0;
    let scannedEvents = 0;

    while (frames.length < input.limit) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;

      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        if (!isRequestedAggregate(envelope, operationId)) continue;
        if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }

        let frame: typeof CodeOperationEventFrame.Type;
        try {
          frame = decodeCodeOperationEventFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        if (frame.operationId !== operationId || frame.threadId !== threadId) {
          return { status: "snapshot-required", reason: "identity-mismatch" };
        }
        if (frame.cursor !== expectedCursor || envelope.aggregateVersion !== frame.cursor) {
          return { status: "snapshot-required", reason: "gap" };
        }
        expectedCursor += 1;
        if (frame.cursor > input.afterCursor) frames.push(frame);
        if (frames.length === input.limit) break;
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    if (input.afterCursor >= expectedCursor) {
      return { status: "snapshot-required", reason: "cursor-ahead" };
    }
    return {
      status: "ok",
      frames,
      nextCursor: frames.at(-1)?.cursor ?? input.afterCursor,
    };
  }

  /**
   * Collect every Code operation event frame for one thread in journal order.
   * Used by the Code Thread Board metadata projection (#12B/#12C). A scan-limit
   * or invalid frame forces `rebuild-required` so the board never fabricates a
   * Done status from a truncated history.
   */
  historyForThread(threadIdInput: CodeThreadId):
    | {
        readonly status: "ok";
        readonly frames: ReadonlyArray<typeof CodeOperationEventFrame.Type>;
      }
    | {
        readonly status: "rebuild-required";
      } {
    let threadId: CodeThreadId;
    try {
      threadId = decodeCodeThreadId(threadIdInput);
    } catch {
      return { status: "rebuild-required" };
    }

    const frames: Array<typeof CodeOperationEventFrame.Type> = [];
    let afterSequence = 0;
    let scannedEvents = 0;

    for (;;) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "rebuild-required" };
        }
        if (
          envelope.aggregateType !== "code-operation" ||
          envelope.eventName !== CODE_OPERATION_EVENT_RECORDED ||
          envelope.eventVersion !== 1
        ) {
          continue;
        }
        let frame: typeof CodeOperationEventFrame.Type;
        try {
          frame = decodeCodeOperationEventFrame(envelope.payload);
        } catch {
          return { status: "rebuild-required" };
        }
        if (
          String(frame.operationId) !== String(envelope.aggregateId) ||
          frame.cursor !== envelope.aggregateVersion
        ) {
          return { status: "rebuild-required" };
        }
        if (frame.threadId === threadId) {
          frames.push(frame);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    return { status: "ok", frames };
  }

  conversation(input: ReadCodeConversationInput): CodeConversationPage {
    let threadId: CodeThreadId;
    try {
      threadId = decodeCodeThreadId(input.threadId);
      if (
        !Number.isSafeInteger(input.afterCursor) ||
        input.afterCursor < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_CODE_CONVERSATION_PAGE_SIZE
      ) {
        throw new Error("invalid cursor");
      }
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code conversation request is invalid.");
    }

    const turns: Array<CodeConversationBuilder> = [];
    const byOperation = new Map<string, CodeConversationBuilder>();
    const limits = new Map<
      string,
      { readonly providerInstanceId: string; readonly limit: CodeProviderLimit }
    >();
    let afterSequence = 0;
    let scannedEvents = 0;
    let hasMore = false;

    for (;;) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          throw new CodeOperationEventStoreError(
            "invalid",
            "Code conversation exceeds the bounded replay window.",
          );
        }
        if (
          envelope.aggregateType !== "code-operation" ||
          envelope.eventName !== CODE_OPERATION_EVENT_RECORDED ||
          envelope.eventVersion !== 1
        ) {
          continue;
        }
        let frame: typeof CodeOperationEventFrame.Type;
        try {
          frame = decodeCodeOperationEventFrame(envelope.payload);
        } catch {
          continue;
        }
        if (
          String(frame.operationId) !== String(envelope.aggregateId) ||
          frame.cursor !== envelope.aggregateVersion
        ) {
          continue;
        }
        const key = String(frame.operationId);
        if (
          frame.threadId === threadId &&
          frame.event.kind === "conversation-turn-started" &&
          envelope.globalSequence > input.afterCursor
        ) {
          if (turns.length === input.limit) {
            hasMore = true;
            continue;
          }
          const builder: CodeConversationBuilder = {
            startCursor: envelope.globalSequence,
            operationId: frame.operationId,
            providerInstanceId: frame.event.providerInstanceId,
            modelId: frame.event.modelId,
            sessionId: frame.event.sessionId,
            prompt: frame.event.prompt,
            ...(frame.event.checkpoint === undefined ? {} : { checkpoint: frame.event.checkpoint }),
            assistant: [],
            steps: [],
            stepsTruncated: false,
            status: "incomplete",
            startedAt: frame.occurredAt,
            updatedAt: frame.occurredAt,
          };
          turns.push(builder);
          byOperation.set(key, builder);
          continue;
        }
        const builder = byOperation.get(key);
        if (builder === undefined || frame.threadId !== threadId) continue;
        builder.updatedAt = frame.occurredAt;
        if (frame.event.kind === "provider-content" && frame.event.channel === "message") {
          if (builder.assistant.length < MAX_CODE_CONVERSATION_ASSISTANT_PARTS) {
            builder.assistant.push(frame.event.content);
          }
        } else if (frame.event.kind === "provider-content") {
          appendStep(builder, { kind: "reasoning", content: frame.event.content });
        } else if (frame.event.kind === "tool-activity") {
          // One row per tool call: a later state for the same call replaces the
          // earlier one instead of adding a step, exactly as the live
          // transcript folds it.
          const toolCallId = String(frame.event.toolCallId);
          const existing = builder.steps.findIndex(
            (step) => step.kind === "tool" && String(step.toolCallId) === toolCallId,
          );
          const step = {
            kind: "tool" as const,
            toolCallId: frame.event.toolCallId,
            toolName: frame.event.toolName,
            state: frame.event.state,
            ...(frame.event.summary === undefined ? {} : { summary: frame.event.summary }),
          };
          if (existing === -1) appendStep(builder, step);
          else builder.steps[existing] = step;
        } else if (frame.event.kind === "usage") {
          // A provider may report usage more than once in a turn; the last
          // report is the turn's own figure, not a running sum to add to.
          builder.usage = {
            inputTokens: frame.event.inputTokens,
            outputTokens: frame.event.outputTokens,
            ...(frame.event.costUsd === undefined ? {} : { costUsd: frame.event.costUsd }),
          };
        } else if (frame.event.kind === "provider-limit") {
          // Window names are the provider's own, so two providers routinely
          // report the same one. Keying by name alone lets a thread that
          // changed providers show the previous account's remaining quota as
          // the current one's, decided by nothing but journal order.
          const providerInstanceId = String(builder.providerInstanceId);
          limits.set(`${providerInstanceId}\n${frame.event.window}`, {
            providerInstanceId,
            limit: {
              window: frame.event.window,
              status: frame.event.status,
              ...(frame.event.utilization === undefined
                ? {}
                : { utilization: frame.event.utilization }),
              ...(frame.event.resetsAt === undefined ? {} : { resetsAt: frame.event.resetsAt }),
            },
          });
        } else if (frame.event.kind === "operation-state") {
          builder.status = conversationStatus(frame.event.state);
        } else if (frame.event.kind === "operation-result") {
          if (frame.event.result.kind === "provider-turn-state") {
            builder.status = conversationStatus(frame.event.result.state);
          } else if (frame.event.result.kind === "operation-failed") {
            builder.status = "failed";
          }
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    // Only the provider the thread is on now can speak for the account the page
    // reports. A limit an earlier provider left behind is history, not a
    // remaining quota, so it is dropped rather than relabelled.
    const currentProviderInstanceId = String(turns.at(-1)?.providerInstanceId ?? "");
    const currentLimits = [...limits.values()]
      .filter((entry) => entry.providerInstanceId === currentProviderInstanceId)
      .map((entry) => entry.limit);

    return decodeCodeConversationPage({
      version: 2,
      threadId,
      turns: turns.map(({ startCursor: _startCursor, steps, stepsTruncated, ...turn }) => ({
        ...turn,
        ...(steps.length === 0 ? {} : { steps }),
        ...(stepsTruncated ? { stepsTruncated: true } : {}),
      })),
      nextCursor: turns.at(-1)?.startCursor ?? input.afterCursor,
      hasMore,
      ...(currentLimits.length === 0 ? {} : { limits: currentLimits.slice(0, 8) }),
    });
  }
}

type CodeConversationBuilder = {
  startCursor: number;
  operationId: CodeConversationTurn["operationId"];
  providerInstanceId: CodeConversationTurn["providerInstanceId"];
  modelId: CodeConversationTurn["modelId"];
  sessionId: CodeConversationTurn["sessionId"];
  prompt: CodeConversationTurn["prompt"];
  checkpoint?: CodeConversationTurn["checkpoint"];
  usage?: CodeConversationTurn["usage"];
  assistant: Array<CodeConversationTurn["assistant"][number]>;
  steps: Array<CodeConversationStep>;
  stepsTruncated: boolean;
  status: CodeConversationTurn["status"];
  startedAt: CodeConversationTurn["startedAt"];
  updatedAt: CodeConversationTurn["updatedAt"];
};

function appendStep(builder: CodeConversationBuilder, step: CodeConversationStep): void {
  if (builder.steps.length >= MAX_CODE_CONVERSATION_TURN_STEPS) {
    builder.stepsTruncated = true;
    return;
  }
  builder.steps.push(step);
}

function conversationStatus(
  state: "running" | "waiting" | "completed" | "interrupted" | "failed",
): CodeConversationTurn["status"] {
  return state === "running" ? "incomplete" : state;
}

function isRequestedAggregate(envelope: EventEnvelope, operationId: CodeOperationId): boolean {
  return (
    envelope.aggregateType === "code-operation" &&
    String(envelope.aggregateId) === String(operationId)
  );
}

function sameFrame(left: unknown, right: typeof CodeOperationEventFrame.Type): boolean {
  try {
    return JSON.stringify(decodeCodeOperationEventFrame(left)) === JSON.stringify(right);
  } catch {
    return false;
  }
}
