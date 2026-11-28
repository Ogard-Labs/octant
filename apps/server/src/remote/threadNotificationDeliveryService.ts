// Notifications for ordinary threads.
//
// The host observes thread lifecycle facts as the journal commits them, in
// every mode: a Chat attempt, a Work turn, or a Code provider turn that
// completed, failed, or waits on the person; a Work or Code approval request;
// and an approval or question the harness asked. The asks a host service
// holds in memory (an MCP tool approval, a memory or routine proposal, an
// image offer, a Browser approval or sign-in card) are not journaled when they
// are raised, so their services announce them here directly. Each becomes at most one
// notification per device for its thread, kind, and run, within the device's
// rate limit, and only for a device that still stands, wants that kind, and
// could read the thread.
//
// A thread move a window holds here for an owner phone is told the same way,
// once per wait and only to phones on this host's owner list: that a move
// waits and the destination's name, nothing about its threads.
//
// Every payload is built through the single domain builder (`buildPushAlert`)
// with the host's held-secret snapshot, so every free-text field passes the
// host-side secret check (failing closed to the generic placeholder when the
// check cannot run). The journal gets one receipt per notification (kind,
// device, thread, outcome, time) and nothing else; a delivery that fails never
// moves a thread, run, or approval. Nothing here logs content, tokens, or secrets.

import { createHash, createHmac } from "node:crypto";
import { Option, Schema } from "effect";
import {
  decodeRemotePushDeliveryRecordedV1,
  decodeRemotePushDeviceJoinedDeliveryRecordedV1,
  decodeRemotePushMoveWaitingDeliveryRecordedV1,
  REMOTE_PUSH_DELIVERY_EVENT_NAMES,
  REMOTE_PUSH_DEVICE_JOINED_DELIVERY_EVENT_NAMES,
  REMOTE_PUSH_MOVE_WAITING_DELIVERY_EVENT_NAMES,
  type OctantMode,
  type RemotePushDeliveryOutcome,
  type RemotePushNotificationKind,
  type StableHostId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  admitRemotePushByRate,
  buildPushAlert,
  remotePushDedupeKey,
  remotePushPreferenceAllows,
  remotePushWantsNewDevices,
  type CheckedPushMessageV2,
  type HeldSecretSnapshot,
} from "@octant/domain/push-notification-policy";
import type { PushDeliveryTransport } from "../automation/pushDeliveryTransport";
import type { Journal } from "../persistence/journal";
import type { PushNotificationTokenStore, PushTokenRecord } from "./pushNotificationTokenStore";

/** Each notification to one device is one aggregate holding its one receipt. */
export const PUSH_DELIVERY_AGGREGATE = "remote-push-delivery";

export interface ThreadNotificationDeliveryOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregate">;
  readonly registrations: Pick<PushNotificationTokenStore, "listDestinations" | "get" | "clear">;
  readonly transport: PushDeliveryTransport;
  /** Whether a registered device stands (active, not revoked or expired). */
  readonly hasStanding: (hostId: string, deviceId: string) => boolean;
  /**
   * The thread's mode and title when a paired device could read it, and
   * nothing when it could not (deleted, hidden, or in a mode that is off).
   */
  readonly readThread: (
    threadId: string,
  ) =>
    | { readonly mode: OctantMode; readonly title: string; readonly projectName?: string }
    | undefined;
  /** The name the paired computer shows the phone. */
  readonly computerLabel: () => string;
  /** Reads the host's held secret values for the push-label secret floor. */
  readonly readHeldSecrets: () => Promise<HeldSecretSnapshot>;
  readonly clock: () => string;
  readonly uuid: () => string;
  /** The host's own actor, for the receipts it journals. */
  readonly hostActorId: string;
  /** Told a fixed sentence when delivery fails; never content, a token, or a secret. */
  readonly onError?: (message: string) => void;
}

interface ThreadNotificationFact {
  readonly threadId: string;
  readonly kind: RemotePushNotificationKind;
  readonly runId: string;
  readonly turnId?: string;
  readonly input?: { readonly requestId: string; readonly kind: "approval" | "question" };
}

/** A new-device alert this host raised, for every paired phone to hear of. */
export interface DeviceJoinedFact {
  /** The alert's own id: one notification per alert and phone (never put on the wire). */
  readonly alertId: string;
  readonly deviceName: string;
  readonly joined: "hub" | "host";
  /** A device that paired with this host is not told about itself. */
  readonly newDeviceId?: string;
}

/** A move a window holds here until an owner phone confirms it. */
export interface MoveWaitingFact {
  /** The wait's own id: one notification per wait, never one per thread it holds. */
  readonly waitId: string;
  readonly destinationName: string;
  /**
   * Whether a paired device belongs to an owner on this host's current owner
   * list, which alone can confirm a move held here. A phone paired only for
   * threads hears nothing about moves. Asked per device at send time, so an
   * owner removed while earlier sends yielded is not told.
   */
  readonly confirmsMoves: (deviceId: string) => boolean;
}

interface DeliveryResult {
  readonly outcome: RemotePushDeliveryOutcome;
  readonly failureCategory?: string;
}

/** One notification for one device, whatever it is about. */
interface Delivery {
  readonly destination: PushTokenRecord;
  readonly receiptId: string;
  readonly collapseOn: string;
  readonly buildMessage: (input: {
    readonly collapseId: string;
    readonly sequence: number;
    readonly occurredAt: UtcTimestamp;
    readonly heldSecrets: HeldSecretSnapshot;
  }) => CheckedPushMessageV2;
  /** The receipt the journal keeps for this delivery; never its text. */
  readonly receipt: (result: DeliveryResult, recordedAt: string) => ReceiptEvent;
}

interface ReceiptEvent {
  readonly eventName: string;
  readonly payload: unknown;
}

interface CommittedFact {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

// Only the fields a fact needs are read. The journal has already decoded each
// payload against its registered schema; these narrow it without depending on
// the rest of it.
const Id = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
const ChatAttemptUpdated = Schema.Struct({
  attempt: Schema.Struct({
    id: Id,
    turnId: Schema.optional(Id),
    threadId: Id,
    outcome: Schema.String,
    pendingQuestion: Schema.optional(
      Schema.Struct({ requestId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)) }),
    ),
  }),
});
const WorkTurnUpdated = Schema.Struct({
  threadId: Id,
  turnId: Id,
  status: Schema.String,
  carried: Schema.optional(Schema.Literal(true)),
});
const WorkRequestRecorded = Schema.Struct({
  kind: Schema.String,
  request: Schema.Struct({
    requestId: Id,
    threadId: Id,
    detail: Schema.Struct({ kind: Schema.String }),
  }),
});
const CodeRuntimeWorkUpdated = Schema.Struct({
  work: Schema.Struct({ id: Id, threadId: Id, kind: Schema.String, state: Schema.String }),
});
// A Code turn can ask several approvals and questions; each request is its
// own run, so a second approval in one turn still reaches the phone.
const RequestId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));
const CodeOperationEventRecorded = Schema.Struct({
  threadId: Id,
  event: Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("approval-requested"),
      approvalId: Id,
    }),
    Schema.Struct({ kind: Schema.Literal("input-requested"), requestId: RequestId }),
  ),
});
const HarnessAsked = Schema.Struct({ id: Id });

function read<A, I>(schema: Schema.Schema<A, I>, value: unknown): A | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
}

/** A turn that ended or parked; an interrupted or cancelled one notifies nothing. */
function lifecycleKind(state: string): RemotePushNotificationKind | undefined {
  switch (state) {
    case "completed":
      return "completion";
    case "failed":
      return "failure";
    case "waiting":
      return "waiting";
    default:
      return undefined;
  }
}

function fact(
  threadId: string,
  kind: RemotePushNotificationKind | undefined,
  runId: string,
  inputKind?: "approval" | "question",
): ThreadNotificationFact | undefined {
  return kind === undefined
    ? undefined
    : {
        threadId,
        kind,
        runId,
        ...(inputKind === undefined ? {} : { input: { requestId: runId, kind: inputKind } }),
      };
}

/** The notification a committed event calls for, if any. */
export function threadNotificationFactOf(event: CommittedFact): ThreadNotificationFact | undefined {
  switch (event.eventName) {
    case "chat.attempt-updated@1": {
      const attempt = read(ChatAttemptUpdated, event.payload)?.attempt;
      if (attempt === undefined) return undefined;
      const kind = lifecycleKind(attempt.outcome);
      if (kind === undefined) return undefined;
      const requestId = kind === "waiting" ? attempt.pendingQuestion?.requestId : undefined;
      // Phone notifications deduplicate on the attempt. MCP clients read the turn or question.
      return {
        threadId: attempt.threadId,
        kind,
        runId: attempt.id,
        ...(attempt.turnId === undefined ? {} : { turnId: attempt.turnId }),
        ...(requestId === undefined ? {} : { input: { requestId, kind: "question" } }),
      };
    }
    case "work.turn-updated@1": {
      const turn = read(WorkTurnUpdated, event.payload);
      // A fork's copy of a source turn finished nowhere; nobody is owed a push.
      if (turn === undefined || turn.carried === true) return undefined;
      return fact(turn.threadId, lifecycleKind(turn.status), turn.turnId);
    }
    case "work.request-recorded@1": {
      const frame = read(WorkRequestRecorded, event.payload);
      if (frame === undefined || frame.kind !== "requested") return undefined;
      const kind =
        frame.request.detail.kind === "approval"
          ? "approval-needed"
          : frame.request.detail.kind === "user-input"
            ? "waiting"
            : undefined;
      return fact(
        frame.request.threadId,
        kind,
        frame.request.requestId,
        kind === "approval-needed" ? "approval" : "question",
      );
    }
    case "code.runtime-work-updated@1": {
      const work = read(CodeRuntimeWorkUpdated, event.payload)?.work;
      if (work === undefined || work.kind !== "provider-turn") return undefined;
      return fact(work.threadId, lifecycleKind(work.state), work.id);
    }
    case "code.operation-event-recorded@1": {
      const frame = read(CodeOperationEventRecorded, event.payload);
      if (frame === undefined) return undefined;
      if (frame.event.kind === "input-requested") {
        return fact(frame.threadId, "waiting", frame.event.requestId, "question");
      }
      return {
        threadId: frame.threadId,
        kind: "approval-needed",
        runId: frame.event.approvalId,
        input: { requestId: frame.event.approvalId, kind: "approval" },
      };
    }
    // The harness session aggregate is keyed by its thread.
    case "native-harness-approval-asked@1": {
      const asked = read(HarnessAsked, event.payload);
      return asked === undefined
        ? undefined
        : fact(event.aggregateId, "approval-needed", asked.id, "approval");
    }
    case "native-harness-question-asked@1": {
      const asked = read(HarnessAsked, event.payload);
      return asked === undefined
        ? undefined
        : fact(event.aggregateId, "waiting", asked.id, "question");
    }
    default:
      return undefined;
  }
}

function receiptAggregateId(destination: PushTokenRecord, dedupeKey: string): string {
  const bytes = createHash("sha256")
    .update(`remote-push-delivery:${destination.hostId}:${destination.deviceId}:${dedupeKey}`)
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 22 unpadded base64url chars derived per destination and collapse subject. */
export function derivePushCollapseId(collapseKey: string, subject: string): string {
  const key = Buffer.from(collapseKey, "base64url");
  return createHmac("sha256", key)
    .update(subject, "utf8")
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

const FAILURE_CATEGORY = /^[a-z0-9-]{1,64}$/;

export class ThreadNotificationDeliveryService {
  readonly #journal: ThreadNotificationDeliveryOptions["journal"];
  readonly #registrations: ThreadNotificationDeliveryOptions["registrations"];
  readonly #transport: PushDeliveryTransport;
  readonly #hasStanding: ThreadNotificationDeliveryOptions["hasStanding"];
  readonly #readThread: ThreadNotificationDeliveryOptions["readThread"];
  readonly #computerLabel: () => string;
  readonly #readHeldSecrets: () => Promise<HeldSecretSnapshot>;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #hostActorId: string;
  readonly #onError: ((message: string) => void) | undefined;
  /** Each device's recent send times, for its rate limit. */
  readonly #recentSends = new Map<string, ReadonlyArray<number>>();
  /** Notifications go out one at a time, in commit order. */
  #queue: Promise<void> = Promise.resolve();
  #sequence = 0;

  constructor(options: ThreadNotificationDeliveryOptions) {
    this.#journal = options.journal;
    this.#registrations = options.registrations;
    this.#transport = options.transport;
    this.#hasStanding = options.hasStanding;
    this.#readThread = options.readThread;
    this.#computerLabel = options.computerLabel;
    this.#readHeldSecrets = options.readHeldSecrets;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#hostActorId = options.hostActorId;
    this.#onError = options.onError;
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: { readonly events: ReadonlyArray<CommittedFact> }): void {
    for (const event of append.events) {
      const observed = threadNotificationFactOf(event);
      if (observed === undefined) continue;
      this.#queue = this.#queue
        .then(() => this.#notify(observed))
        .catch(() => this.#report("Thread notification delivery stopped on an unexpected error."));
    }
  }

  /**
   * An ask a host service began to hold for the person: told like a journaled
   * approval request, once per ask and device, under the phone's Approval
   * needed setting. The notification names the thread and nothing of the ask.
   */
  notifyWaitingAsk(ask: { readonly threadId: string; readonly askId: string }): void {
    this.#queue = this.#queue
      .then(() =>
        this.#notify({ threadId: ask.threadId, kind: "approval-needed", runId: ask.askId }),
      )
      .catch(() => this.#report("Thread notification delivery stopped on an unexpected error."));
  }

  /**
   * A window held a move here for an owner phone. Called once per wait, a
   * batch included; a second call for the same wait sends nothing more.
   */
  notifyMoveWaiting(wait: MoveWaitingFact): void {
    this.#queue = this.#queue
      .then(() => this.#notifyMoveWaiting(wait))
      .catch(() => this.#report("A held-move notification stopped on an unexpected error."));
  }

  /**
   * A new device joined this host's hub or paired with it: every phone paired
   * here hears of it, unless it turned new devices off (maintainer decision,
   * 2026-11-19). A second call for the same alert sends nothing more.
   */
  notifyDeviceJoined(fact: DeviceJoinedFact): void {
    this.#queue = this.#queue
      .then(() => this.#notifyDeviceJoined(fact))
      .catch(() => this.#report("A new-device notification stopped on an unexpected error."));
  }

  async #notifyDeviceJoined(fact: DeviceJoinedFact): Promise<void> {
    if (this.#transport.providerDelivery() !== "available") return;
    for (const listed of this.#registrations.listDestinations()) {
      const destination = this.#current(listed);
      if (destination === undefined) continue;
      if (fact.newDeviceId !== undefined && destination.deviceId === fact.newDeviceId) continue;
      if (!remotePushWantsNewDevices(destination.preferences)) continue;
      await this.#deliver({
        destination,
        receiptId: receiptAggregateId(destination, `device-joined:${fact.alertId}`),
        collapseOn: `device-joined:${fact.alertId}`,
        buildMessage: ({ collapseId, sequence, occurredAt, heldSecrets }) =>
          buildPushAlert({
            source: "device-joined",
            hostId: destination.hostId as StableHostId,
            deviceName: fact.deviceName,
            joined: fact.joined,
            computerLabel: this.#computerLabel(),
            collapseId,
            sequence,
            occurredAt,
            heldSecrets,
          }),
        receipt: (result, recordedAt) => ({
          eventName: REMOTE_PUSH_DEVICE_JOINED_DELIVERY_EVENT_NAMES.recorded,
          payload: decodeRemotePushDeviceJoinedDeliveryRecordedV1({
            hostId: destination.hostId,
            deviceId: destination.deviceId,
            alertId: fact.alertId,
            ...result,
            recordedAt,
          }),
        }),
      });
    }
  }

  async #notifyMoveWaiting(wait: MoveWaitingFact): Promise<void> {
    if (this.#transport.providerDelivery() !== "available") return;
    for (const listed of this.#registrations.listDestinations()) {
      const destination = this.#current(listed);
      if (destination === undefined) continue;
      if (!wait.confirmsMoves(destination.deviceId)) continue;
      // Confirming a move is the person approving it, so the phone's Approval
      // needed setting governs it.
      if (!destination.preferences.approvalNeeded) continue;
      await this.#deliver({
        destination,
        receiptId: receiptAggregateId(destination, `move-waiting:${wait.waitId}`),
        collapseOn: `move-waiting:${wait.waitId}`,
        buildMessage: ({ collapseId, sequence, occurredAt, heldSecrets }) =>
          buildPushAlert({
            source: "move-waiting",
            hostId: destination.hostId as StableHostId,
            destinationName: wait.destinationName,
            collapseId,
            sequence,
            occurredAt,
            heldSecrets,
          }),
        receipt: (result, recordedAt) => ({
          eventName: REMOTE_PUSH_MOVE_WAITING_DELIVERY_EVENT_NAMES.recorded,
          payload: decodeRemotePushMoveWaitingDeliveryRecordedV1({
            hostId: destination.hostId,
            deviceId: destination.deviceId,
            ...result,
            recordedAt,
          }),
        }),
      });
    }
  }

  async #notify(observed: ThreadNotificationFact): Promise<void> {
    // While direct push is unavailable, nothing is built, sent, or journaled.
    if (this.#transport.providerDelivery() !== "available") return;
    const thread = this.#readThread(observed.threadId);
    if (thread === undefined) return;
    for (const listed of this.#registrations.listDestinations()) {
      await this.#notifyDevice(observed, thread, listed);
    }
  }

  async #notifyDevice(
    observed: ThreadNotificationFact,
    thread: { readonly mode: OctantMode; readonly title: string; readonly projectName?: string },
    listed: PushTokenRecord,
  ): Promise<void> {
    const destination = this.#current(listed);
    if (destination === undefined) return;
    if (!remotePushPreferenceAllows(destination.preferences, observed.kind)) return;
    await this.#deliver({
      destination,
      receiptId: receiptAggregateId(destination, remotePushDedupeKey(observed)),
      collapseOn: observed.threadId,
      buildMessage: ({ collapseId, sequence, occurredAt, heldSecrets }) =>
        buildPushAlert({
          source: "thread",
          kind: observed.kind,
          hostId: destination.hostId as StableHostId,
          threadId: observed.threadId,
          mode: thread.mode,
          computerLabel: this.#computerLabel(),
          threadTitle: thread.title,
          ...(thread.projectName === undefined ? {} : { projectName: thread.projectName }),
          threadTitles: destination.preferences.threadTitles,
          collapseId,
          sequence,
          occurredAt,
          heldSecrets,
        }),
      receipt: (result, recordedAt) => ({
        eventName: REMOTE_PUSH_DELIVERY_EVENT_NAMES.recorded,
        payload: decodeRemotePushDeliveryRecordedV1({
          hostId: destination.hostId,
          deviceId: destination.deviceId,
          threadId: observed.threadId,
          kind: observed.kind,
          ...result,
          recordedAt,
        }),
      }),
    });
  }

  /**
   * The destination as it stands now, after earlier sends yielded: a revoke or
   * sign-out that landed since leaves no registration or no standing.
   */
  #current(listed: PushTokenRecord): PushTokenRecord | undefined {
    const destination = this.#registrations.get({
      hostId: listed.hostId,
      deviceId: listed.deviceId,
    });
    if (destination === undefined) return undefined;
    if (!this.#hasStanding(destination.hostId, destination.deviceId)) return undefined;
    return destination;
  }

  async #deliver(delivery: Delivery): Promise<void> {
    const { destination, receiptId } = delivery;
    if (this.#receipted(receiptId)) return;

    const recordedAt = this.#clock();
    const deviceKey = `${destination.hostId}\0${destination.deviceId}`;
    const rate = admitRemotePushByRate({
      recent: this.#recentSends.get(deviceKey) ?? [],
      now: Date.parse(recordedAt),
    });
    this.#recentSends.set(deviceKey, rate.recent);
    if (rate.kind === "rate-limited") {
      this.#receipt(delivery, { outcome: "rate-limited" });
      return;
    }

    let heldSecrets: HeldSecretSnapshot;
    try {
      heldSecrets = await this.#readHeldSecrets();
    } catch {
      heldSecrets = { status: "unavailable" };
    }

    // Re-check standing after the async secret read before sending.
    if (this.#current(destination) === undefined) return;

    this.#sequence += 1;
    const message = delivery.buildMessage({
      collapseId: derivePushCollapseId(destination.collapseKey, delivery.collapseOn),
      sequence: this.#sequence,
      occurredAt: recordedAt as UtcTimestamp,
      heldSecrets,
    });

    let result: Awaited<ReturnType<PushDeliveryTransport["send"]>>;
    try {
      result = await this.#transport.send({
        destination: {
          deviceId: destination.deviceId,
          platform: destination.platform,
          token: destination.token,
        },
        message,
      });
    } catch {
      this.#report("A thread notification failed in the push transport.");
      result = { kind: "failed", retryable: false, category: "transport-error" };
    }
    switch (result.kind) {
      case "delivered":
        this.#receipt(delivery, { outcome: "delivered" });
        return;
      case "destination-gone":
        this.#clearGone(destination);
        this.#receipt(delivery, { outcome: "destination-gone" });
        return;
      case "failed":
        this.#receipt(delivery, {
          outcome: "failed",
          failureCategory: FAILURE_CATEGORY.test(result.category)
            ? result.category
            : "transport-error",
        });
        return;
    }
  }

  #receipted(receiptId: string): boolean {
    return (
      this.#journal.replayAggregate({
        aggregateType: PUSH_DELIVERY_AGGREGATE,
        aggregateId: receiptId,
        afterVersion: 0,
        limit: 1,
      }).length > 0
    );
  }

  #receipt(delivery: Delivery, result: DeliveryResult): void {
    const occurredAt = this.#clock();
    try {
      const { eventName, payload } = delivery.receipt(result, occurredAt);
      const eventId = this.#uuid();
      this.#journal.append({
        aggregate: { aggregateType: PUSH_DELIVERY_AGGREGATE, aggregateId: delivery.receiptId },
        // The first receipt for this notification wins; a second is refused.
        expectedVersion: 0,
        events: [
          {
            eventId,
            eventName,
            eventVersion: 1,
            correlationId: eventId,
            actor: { kind: "system", actorId: this.#hostActorId },
            occurredAt,
            payload,
          },
        ],
      });
    } catch {
      this.#report("A thread notification receipt could not be journaled.");
    }
  }

  #clearGone(destination: PushTokenRecord): void {
    try {
      this.#registrations.clear({
        hostId: destination.hostId,
        deviceId: destination.deviceId,
        reason: "destination-gone",
        now: this.#clock(),
      });
    } catch {
      // The registration file already dropped it before the journal failed.
      this.#report("A gone push destination was dropped but its clear was not journaled.");
    }
  }

  #report(message: string): void {
    try {
      this.#onError?.(message);
    } catch {
      // Reporting never stops delivery.
    }
  }
}
