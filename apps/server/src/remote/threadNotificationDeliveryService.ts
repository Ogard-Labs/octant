// Notifications for ordinary threads.
//
// The host observes thread lifecycle facts as the journal commits them, in
// every mode: a Chat attempt, a Work turn, or a Code provider turn that
// completed, failed, or waits on the person; a Work or Code approval request;
// and an approval or question the harness asked. Each becomes at most one
// notification per device for its thread, kind, and run, within the device's
// rate limit, and only for a device that still stands, wants that kind, and
// could read the thread.
//
// What reaches the transport is the sealed envelope alone: the display text
// is built by the domain redaction policy and sealed to the phone's key. The
// journal gets one receipt per notification (kind, device, thread, outcome,
// time) and nothing else; a delivery that fails never moves a thread, run, or
// approval. Nothing here logs content, tokens, or keys.

import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
import {
  decodeRemotePushDeliveryRecordedV1,
  REMOTE_PUSH_DELIVERY_EVENT_NAMES,
  type OctantMode,
  type RemotePushDeliveryOutcome,
  type RemotePushNotificationKind,
} from "@octant/contracts";
import {
  admitRemotePushByRate,
  buildRedactedPushNotification,
  remotePushDedupeKey,
  remotePushPreferenceAllows,
} from "@octant/domain/push-notification-policy";
import type { PushDeliveryTransport } from "../automation/pushDeliveryTransport";
import type { Journal } from "../persistence/journal";
import { sealPushNotification } from "./pushNotificationSealing";
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
  ) => { readonly mode: OctantMode; readonly title: string } | undefined;
  /** The name the paired computer shows the phone. */
  readonly computerLabel: () => string;
  readonly clock: () => string;
  readonly uuid: () => string;
  /** The host's own actor, for the receipts it journals. */
  readonly hostActorId: string;
  /** Told a fixed sentence when delivery fails; never content, a token, or a key. */
  readonly onError?: (message: string) => void;
}

interface ThreadNotificationFact {
  readonly threadId: string;
  readonly kind: RemotePushNotificationKind;
  readonly runId: string;
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
  attempt: Schema.Struct({ id: Id, threadId: Id, outcome: Schema.String }),
});
const WorkTurnUpdated = Schema.Struct({ threadId: Id, turnId: Id, status: Schema.String });
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
    Schema.Struct({ kind: Schema.Literal("approval-requested"), approvalId: Id }),
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
): ThreadNotificationFact | undefined {
  return kind === undefined ? undefined : { threadId, kind, runId };
}

/** The notification a committed event calls for, if any. */
function threadNotificationFactOf(event: CommittedFact): ThreadNotificationFact | undefined {
  switch (event.eventName) {
    case "chat.attempt-updated@1": {
      const attempt = read(ChatAttemptUpdated, event.payload)?.attempt;
      if (attempt === undefined) return undefined;
      return fact(attempt.threadId, lifecycleKind(attempt.outcome), attempt.id);
    }
    case "work.turn-updated@1": {
      const turn = read(WorkTurnUpdated, event.payload);
      if (turn === undefined) return undefined;
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
      return fact(frame.request.threadId, kind, frame.request.requestId);
    }
    case "code.runtime-work-updated@1": {
      const work = read(CodeRuntimeWorkUpdated, event.payload)?.work;
      if (work === undefined || work.kind !== "provider-turn") return undefined;
      return fact(work.threadId, lifecycleKind(work.state), work.id);
    }
    case "code.operation-event-recorded@1": {
      const frame = read(CodeOperationEventRecorded, event.payload);
      if (frame === undefined) return undefined;
      return frame.event.kind === "approval-requested"
        ? fact(frame.threadId, "approval-needed", frame.event.approvalId)
        : fact(frame.threadId, "waiting", frame.event.requestId);
    }
    // The harness session aggregate is keyed by its thread.
    case "native-harness-approval-asked@1": {
      const asked = read(HarnessAsked, event.payload);
      return asked === undefined ? undefined : fact(event.aggregateId, "approval-needed", asked.id);
    }
    case "native-harness-question-asked@1": {
      const asked = read(HarnessAsked, event.payload);
      return asked === undefined ? undefined : fact(event.aggregateId, "waiting", asked.id);
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

const FAILURE_CATEGORY = /^[a-z0-9-]{1,64}$/;

export class ThreadNotificationDeliveryService {
  readonly #journal: ThreadNotificationDeliveryOptions["journal"];
  readonly #registrations: ThreadNotificationDeliveryOptions["registrations"];
  readonly #transport: PushDeliveryTransport;
  readonly #hasStanding: ThreadNotificationDeliveryOptions["hasStanding"];
  readonly #readThread: ThreadNotificationDeliveryOptions["readThread"];
  readonly #computerLabel: () => string;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #hostActorId: string;
  readonly #onError: ((message: string) => void) | undefined;
  /** Each device's recent send times, for its rate limit. */
  readonly #recentSends = new Map<string, ReadonlyArray<number>>();
  /** Notifications go out one at a time, in commit order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ThreadNotificationDeliveryOptions) {
    this.#journal = options.journal;
    this.#registrations = options.registrations;
    this.#transport = options.transport;
    this.#hasStanding = options.hasStanding;
    this.#readThread = options.readThread;
    this.#computerLabel = options.computerLabel;
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

  async #notify(observed: ThreadNotificationFact): Promise<void> {
    // With the Notifications setting off, nothing is sealed, sent, or journaled.
    if (this.#transport.providerDelivery() !== "available") return;
    const thread = this.#readThread(observed.threadId);
    if (thread === undefined) return;
    for (const listed of this.#registrations.listDestinations()) {
      await this.#notifyDevice(observed, thread, listed);
    }
  }

  async #notifyDevice(
    observed: ThreadNotificationFact,
    thread: { readonly mode: OctantMode; readonly title: string },
    listed: PushTokenRecord,
  ): Promise<void> {
    // Read now, after earlier sends yielded: a revoke or sign-out that landed
    // since leaves no registration or no standing, and nothing between this
    // check and the send below yields.
    const destination = this.#registrations.get({
      hostId: listed.hostId,
      deviceId: listed.deviceId,
    });
    if (destination === undefined) return;
    if (!this.#hasStanding(destination.hostId, destination.deviceId)) return;
    if (!remotePushPreferenceAllows(destination.preferences, observed.kind)) return;

    const receiptId = receiptAggregateId(destination, remotePushDedupeKey(observed));
    if (this.#receipted(receiptId)) return;

    const recordedAt = this.#clock();
    const deviceKey = `${destination.hostId}\0${destination.deviceId}`;
    const rate = admitRemotePushByRate({
      recent: this.#recentSends.get(deviceKey) ?? [],
      now: Date.parse(recordedAt),
    });
    this.#recentSends.set(deviceKey, rate.recent);
    if (rate.kind === "rate-limited") {
      this.#receipt(receiptId, destination, observed, { outcome: "rate-limited" });
      return;
    }

    const sealed = sealPushNotification({
      hostId: destination.hostId,
      deviceId: destination.deviceId,
      notificationPublicKey: destination.notificationPublicKey,
      collapseKey: destination.collapseKey,
      threadId: observed.threadId,
      kind: observed.kind,
      content: buildRedactedPushNotification({
        kind: observed.kind,
        hostId: destination.hostId,
        threadId: observed.threadId,
        mode: thread.mode,
        computerLabel: this.#computerLabel(),
        threadTitle: thread.title,
        threadTitles: destination.preferences.threadTitles,
      }),
    });
    if (sealed.status === "refused") {
      this.#receipt(receiptId, destination, observed, {
        outcome: "failed",
        failureCategory: `sealing-${sealed.reason}`,
      });
      return;
    }

    let result: Awaited<ReturnType<PushDeliveryTransport["send"]>>;
    try {
      result = await this.#transport.send({
        destination: {
          deviceId: destination.deviceId,
          platform: destination.platform,
          token: destination.token,
        },
        envelope: sealed.envelope,
      });
    } catch {
      this.#report("A thread notification failed in the push transport.");
      result = { kind: "failed", retryable: false, category: "transport-error" };
    }
    switch (result.kind) {
      case "delivered":
        this.#receipt(receiptId, destination, observed, { outcome: "delivered" });
        return;
      case "destination-gone":
        this.#clearGone(destination);
        this.#receipt(receiptId, destination, observed, { outcome: "destination-gone" });
        return;
      case "failed":
        this.#receipt(receiptId, destination, observed, {
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

  #receipt(
    receiptId: string,
    destination: PushTokenRecord,
    observed: ThreadNotificationFact,
    result: {
      readonly outcome: RemotePushDeliveryOutcome;
      readonly failureCategory?: string;
    },
  ): void {
    const occurredAt = this.#clock();
    try {
      const payload = decodeRemotePushDeliveryRecordedV1({
        hostId: destination.hostId,
        deviceId: destination.deviceId,
        threadId: observed.threadId,
        kind: observed.kind,
        outcome: result.outcome,
        ...(result.failureCategory === undefined
          ? {}
          : { failureCategory: result.failureCategory }),
        recordedAt: occurredAt,
      });
      const eventId = this.#uuid();
      this.#journal.append({
        aggregate: { aggregateType: PUSH_DELIVERY_AGGREGATE, aggregateId: receiptId },
        // The first receipt for this notification wins; a second is refused.
        expectedVersion: 0,
        events: [
          {
            eventId,
            eventName: REMOTE_PUSH_DELIVERY_EVENT_NAMES.recorded,
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
