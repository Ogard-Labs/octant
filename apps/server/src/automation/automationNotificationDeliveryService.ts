import { createHash } from "node:crypto";
import {
  REMOTE_PUSH_DELIVERY_EVENT_NAMES,
  decodeAutomationNotificationDeliveryQueryResponse,
  decodeAutomationNotificationDeliveryStatus,
  decodeRemotePushDeliveryRecordedV1,
  type AutomationDefinition,
  type AutomationId,
  type AutomationNotificationDeliveryQueryResponse,
  type AutomationNotificationDeliveryReceipt,
  type AutomationNotificationDeliveryStatus,
  type AutomationNotificationKind,
  type AutomationRun,
  type AutomationRunLifecycle,
  type RemotePushDeliveryOutcome,
  type StableHostId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  admitAutomationNotification,
  automationNotificationDedupeKey,
  nextAutomationNotificationOutcome,
} from "@octant/domain/automation-notification-policy";
import {
  admitRemotePushByRate,
  automationNotificationKindForLifecycle,
  buildPushAlert,
  remotePushPreferenceAllows,
  type HeldSecretSnapshot,
} from "@octant/domain/push-notification-policy";
import type { Journal } from "../persistence/journal";
import type {
  PushNotificationTokenStore,
  PushTokenRecord,
} from "../remote/pushNotificationTokenStore";
import {
  PUSH_DELIVERY_AGGREGATE,
  derivePushCollapseId,
} from "../remote/threadNotificationDeliveryService";
import type { AutomationNotificationDeliveryStore } from "./automationNotificationDeliveryStore";
import type { AutomationNotificationPreferencesStore } from "./automationNotificationPreferencesStore";
import type { PushDeliveryTransport } from "./pushDeliveryTransport";
import { deterministicAutomationUuid } from "./automationRunIdentity";

export interface AutomationNotificationDeliveryServiceOptions {
  readonly preferences: Pick<AutomationNotificationPreferencesStore, "current">;
  readonly deliveries: Pick<
    AutomationNotificationDeliveryStore,
    "getByDedupeKey" | "record" | "list" | "listByRunId" | "listByAutomationId"
  >;
  readonly tokens: Pick<PushNotificationTokenStore, "listDestinations" | "get" | "clear">;
  /**
   * Whether a registered device still stands (active, not revoked or
   * expired). Asked when a run is observed and again right before each send.
   */
  readonly hasStanding: (hostId: string, deviceId: string) => boolean;
  /** The name the paired computer shows the phone. */
  readonly computerLabel: () => string;
  /** Reads the host's held secret values for the push-label secret floor. */
  readonly readHeldSecrets: () => Promise<HeldSecretSnapshot>;
  readonly transport: PushDeliveryTransport;
  readonly clock: () => UtcTimestamp;
  readonly uuid?: () => string;
  /**
   * Optional journal for recording per-device `remote.push-delivery-recorded@1`
   * receipts when an automation run has an ordinary thread so the phone's Inbox
   * lists routine notifications beside thread notifications.
   */
  readonly journal?: Pick<Journal, "append" | "replayAggregate">;
  readonly hostActorId?: string;
  /**
   * Optional hook to append an opaque delivery ref onto the run aggregate.
   * Failures here must never change run lifecycle — they are swallowed after
   * the durable delivery receipt is already recorded.
   */
  readonly recordRunNotificationRef?: (input: {
    readonly run: AutomationRun;
    readonly notificationRef: string;
    readonly recordedAt: UtcTimestamp;
  }) => void;
  /**
   * Host/Project scoping for delivery queries. Resolves the Project that owns
   * an Automation definition so Center can filter receipts without inventing
   * cross-Project facts.
   */
  readonly resolveAutomationProjectId?: (automationId: AutomationId) => string | undefined;
}

const TERMINAL_OUTCOMES = new Set(["delivered", "failed", "cancelled", "exhausted"]);

const REOPENABLE_OUTCOMES = new Set(["skipped-preference", "skipped-no-destination", "queued"]);

const FAILURE_CATEGORY = /^[a-z0-9-]{1,64}$/;

function deviceReceiptAggregateId(destination: PushTokenRecord, dedupeKey: string): string {
  const bytes = createHash("sha256")
    .update(
      `remote-push-delivery:automation:${destination.hostId}:${destination.deviceId}:${dedupeKey}`,
    )
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Host-side Automation notification delivery. Observes run lifecycle truth,
 * builds checked v2 payloads via the single shared domain builder, delivers to
 * every standing registered device that wants the kind (with per-device rate
 * limiting), and journals durable receipts. Notification failure never mutates
 * run or ordinary-thread lifecycle.
 */
export class AutomationNotificationDeliveryService {
  readonly #preferences: AutomationNotificationDeliveryServiceOptions["preferences"];
  readonly #deliveries: AutomationNotificationDeliveryServiceOptions["deliveries"];
  readonly #tokens: AutomationNotificationDeliveryServiceOptions["tokens"];
  readonly #hasStanding: AutomationNotificationDeliveryServiceOptions["hasStanding"];
  readonly #computerLabel: () => string;
  readonly #readHeldSecrets: () => Promise<HeldSecretSnapshot>;
  readonly #transport: PushDeliveryTransport;
  readonly #clock: () => UtcTimestamp;
  readonly #uuid: () => string;
  readonly #journal: AutomationNotificationDeliveryServiceOptions["journal"];
  readonly #hostActorId: string;
  readonly #recordRunNotificationRef:
    | AutomationNotificationDeliveryServiceOptions["recordRunNotificationRef"]
    | undefined;
  readonly #resolveAutomationProjectId:
    | AutomationNotificationDeliveryServiceOptions["resolveAutomationProjectId"]
    | undefined;
  readonly #cancelledDedupeKeys = new Set<string>();
  readonly #inflight = new Set<string>();
  readonly #recentSends = new Map<string, ReadonlyArray<number>>();
  #sequence = 0;

  constructor(options: AutomationNotificationDeliveryServiceOptions) {
    this.#preferences = options.preferences;
    this.#deliveries = options.deliveries;
    this.#tokens = options.tokens;
    this.#hasStanding = options.hasStanding;
    this.#computerLabel = options.computerLabel;
    this.#readHeldSecrets = options.readHeldSecrets;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#journal = options.journal;
    this.#hostActorId = options.hostActorId ?? "local-user";
    this.#recordRunNotificationRef = options.recordRunNotificationRef;
    this.#resolveAutomationProjectId = options.resolveAutomationProjectId;
  }

  status(): AutomationNotificationDeliveryStatus {
    const preferences = this.#preferences.current();
    const providerDelivery = this.#transport.providerDelivery();
    const registeredDestinationCount = this.#standingDestinations().length;
    return decodeAutomationNotificationDeliveryStatus({
      preferences,
      providerDelivery,
      registeredDestinationCount,
      deliveryEnabled:
        preferences.enabled && providerDelivery === "available" && registeredDestinationCount > 0,
    });
  }

  /**
   * Authenticated delivery query for Center/settings. Always returns honest
   * provider availability; missing APNs/FCM credentials surface as structured
   * `unavailable`, never silent success. Receipts are host-scoped and may be
   * narrowed by automation, run, or Project identity.
   */
  queryDeliveries(
    input: {
      readonly automationId?: string;
      readonly runId?: string;
      readonly projectId?: string;
    } = {},
  ): AutomationNotificationDeliveryQueryResponse {
    const status = this.status();
    let receipts = this.#deliveries.list();
    if (input.runId !== undefined && input.runId.trim() !== "") {
      receipts = this.#deliveries.listByRunId(input.runId);
    } else if (input.automationId !== undefined && input.automationId.trim() !== "") {
      receipts = this.#deliveries.listByAutomationId(input.automationId);
    }
    if (input.projectId !== undefined && input.projectId.trim() !== "") {
      const projectId = input.projectId;
      receipts = receipts.filter((receipt) => {
        const resolved = this.#resolveAutomationProjectId?.(receipt.automationId);
        return resolved !== undefined && String(resolved) === projectId;
      });
    }
    const newestFirst = [...receipts].sort((left, right) =>
      String(right.recordedAt).localeCompare(String(left.recordedAt)),
    );
    return decodeAutomationNotificationDeliveryQueryResponse({
      status,
      receipts: newestFirst.slice(0, 100),
    });
  }

  /**
   * Observe a run lifecycle transition. Idempotent for (runId, kind).
   * Cancellation cancels in-flight retries without changing run truth.
   */
  observeRunStatusChanged(input: {
    readonly run: AutomationRun;
    readonly definition?: AutomationDefinition;
    readonly previousLifecycle: AutomationRunLifecycle;
    readonly kind?: AutomationNotificationKind;
  }): AutomationNotificationDeliveryReceipt | undefined {
    if (input.run.lifecycle === "cancelled") {
      this.#cancelPendingForRun(input.run.id);
      return undefined;
    }
    const kind =
      input.kind ?? automationNotificationKindForLifecycle(input.run.lifecycle) ?? undefined;
    if (kind === undefined) return undefined;
    return this.#enqueue({
      run: input.run,
      kind,
      ...(input.definition === undefined ? {} : { definition: input.definition }),
    });
  }

  /** Explicit approval-needed signal from ordinary-thread status integration. */
  observeApprovalNeeded(input: {
    readonly run: AutomationRun;
    readonly definition?: AutomationDefinition;
  }): AutomationNotificationDeliveryReceipt | undefined {
    return this.#enqueue({
      run: input.run,
      kind: "approval-needed",
      ...(input.definition === undefined ? {} : { definition: input.definition }),
    });
  }

  #cancelPendingForRun(runId: AutomationRun["id"]): void {
    for (const kind of ["waiting", "approval-needed", "failure", "completion"] as const) {
      const dedupeKey = automationNotificationDedupeKey(runId, kind);
      const existing = this.#deliveries.getByDedupeKey(dedupeKey);
      if (existing !== undefined && existing.outcome === "queued") {
        this.#cancelledDedupeKeys.add(dedupeKey);
        this.#recordReceipt({
          receiptId: existing.receiptId,
          automationId: existing.automationId,
          runId: existing.runId,
          kind: existing.kind,
          dedupeKey: existing.dedupeKey,
          outcome: "cancelled",
          attemptCount: existing.attemptCount,
          destinationCount: existing.destinationCount,
          recordedAt: this.#clock(),
          ...(existing.failureCategory === undefined
            ? {}
            : { failureCategory: existing.failureCategory }),
        });
      } else if (existing === undefined) {
        this.#cancelledDedupeKeys.add(dedupeKey);
      }
    }
  }

  #enqueue(input: {
    readonly run: AutomationRun;
    readonly definition?: AutomationDefinition;
    readonly kind: AutomationNotificationKind;
  }): AutomationNotificationDeliveryReceipt {
    const dedupeKey = automationNotificationDedupeKey(input.run.id, input.kind);
    const existing = this.#deliveries.getByDedupeKey(dedupeKey);
    if (existing !== undefined && TERMINAL_OUTCOMES.has(existing.outcome)) {
      return existing;
    }

    const destinations = this.#standingDestinations().filter((destination) =>
      remotePushPreferenceAllows(destination.preferences, input.kind),
    );
    const admission = admitAutomationNotification({
      preferences: this.#preferences.current(),
      notificationKind: input.kind,
      destinationCount: destinations.length,
      alreadyRecorded: false,
    });
    if (admission.kind === "skip") {
      if (
        existing !== undefined &&
        existing.outcome === admission.outcome &&
        REOPENABLE_OUTCOMES.has(existing.outcome)
      ) {
        return existing;
      }
      return this.#recordReceipt({
        receiptId: this.#receiptId(dedupeKey),
        automationId: input.run.automationId,
        runId: input.run.id,
        kind: input.kind,
        dedupeKey,
        outcome: admission.outcome,
        attemptCount: existing?.attemptCount ?? 0,
        destinationCount: destinations.length,
        recordedAt: this.#clock(),
      });
    }

    const queued = this.#recordReceipt({
      receiptId: this.#receiptId(dedupeKey),
      automationId: input.run.automationId,
      runId: input.run.id,
      kind: input.kind,
      dedupeKey,
      outcome: "queued",
      attemptCount: existing?.attemptCount ?? 0,
      destinationCount: destinations.length,
      recordedAt: this.#clock(),
    });

    void this.#deliver({
      run: input.run,
      ...(input.definition === undefined ? {} : { definition: input.definition }),
      kind: input.kind,
      dedupeKey,
      destinations,
      attemptCount: queued.attemptCount,
    });
    return queued;
  }

  #standingDestinations(): ReadonlyArray<PushTokenRecord> {
    return this.#tokens
      .listDestinations()
      .filter((destination) => this.#hasStanding(destination.hostId, destination.deviceId));
  }

  async #deliver(input: {
    readonly run: AutomationRun;
    readonly definition?: AutomationDefinition;
    readonly kind: AutomationNotificationKind;
    readonly dedupeKey: string;
    readonly destinations: ReadonlyArray<PushTokenRecord>;
    readonly attemptCount: number;
  }): Promise<void> {
    if (this.#inflight.has(input.dedupeKey)) return;
    if (this.#cancelledDedupeKeys.has(input.dedupeKey)) {
      this.#recordReceipt({
        receiptId: this.#receiptId(input.dedupeKey),
        automationId: input.run.automationId,
        runId: input.run.id,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        outcome: "cancelled",
        attemptCount: input.attemptCount,
        destinationCount: input.destinations.length,
        recordedAt: this.#clock(),
      });
      return;
    }

    this.#inflight.add(input.dedupeKey);
    const nextAttempt = input.attemptCount + 1;
    try {
      let deliveredAny = false;
      let lastFailure:
        | { readonly kind: "failed"; readonly retryable: boolean; readonly category: string }
        | undefined;
      for (const destination of input.destinations) {
        if (this.#cancelledDedupeKeys.has(input.dedupeKey)) {
          this.#recordReceipt({
            receiptId: this.#receiptId(input.dedupeKey),
            automationId: input.run.automationId,
            runId: input.run.id,
            kind: input.kind,
            dedupeKey: input.dedupeKey,
            outcome: "cancelled",
            attemptCount: nextAttempt,
            destinationCount: input.destinations.length,
            recordedAt: this.#clock(),
          });
          return;
        }
        // Standing is asked again at send time: a revoke or sign-out that
        // landed after the run was observed leaves no registration to send to.
        const current = this.#tokens.get({
          hostId: destination.hostId,
          deviceId: destination.deviceId,
        });
        if (current === undefined || !this.#hasStanding(current.hostId, current.deviceId)) {
          lastFailure = {
            kind: "failed",
            retryable: false,
            category: "destination-without-standing",
          };
          continue;
        }
        const now = this.#clock();
        const deviceKey = `${current.hostId}\0${current.deviceId}`;
        const rate = admitRemotePushByRate({
          recent: this.#recentSends.get(deviceKey) ?? [],
          now: Date.parse(now),
        });
        this.#recentSends.set(deviceKey, rate.recent);
        if (rate.kind === "rate-limited") {
          this.#recordDeviceDeliveryReceipt({
            destination: current,
            run: input.run,
            kind: input.kind,
            dedupeKey: input.dedupeKey,
            outcome: "rate-limited",
            recordedAt: now,
          });
          lastFailure = { kind: "failed", retryable: false, category: "rate-limited" };
          continue;
        }

        let heldSecrets: HeldSecretSnapshot;
        try {
          heldSecrets = await this.#readHeldSecrets();
        } catch {
          heldSecrets = { status: "unavailable" };
        }
        const stillCurrent = this.#tokens.get({
          hostId: current.hostId,
          deviceId: current.deviceId,
        });
        if (
          stillCurrent === undefined ||
          !this.#hasStanding(stillCurrent.hostId, stillCurrent.deviceId)
        ) {
          lastFailure = {
            kind: "failed",
            retryable: false,
            category: "destination-without-standing",
          };
          continue;
        }

        this.#sequence += 1;
        const message = this.#buildMessage({
          run: input.run,
          ...(input.definition === undefined ? {} : { definition: input.definition }),
          kind: input.kind,
          destination: stillCurrent,
          sequence: this.#sequence,
          occurredAt: now,
          heldSecrets,
        });
        const result = await this.#transport.send({
          destination: {
            deviceId: stillCurrent.deviceId,
            platform: stillCurrent.platform,
            token: stillCurrent.token,
          },
          message,
        });
        if (result.kind === "destination-gone") {
          this.#clearGone(stillCurrent);
          this.#recordDeviceDeliveryReceipt({
            destination: stillCurrent,
            run: input.run,
            kind: input.kind,
            dedupeKey: input.dedupeKey,
            outcome: "destination-gone",
            recordedAt: this.#clock(),
          });
          lastFailure = { kind: "failed", retryable: false, category: "destination-gone" };
          continue;
        }
        if (result.kind === "delivered") {
          deliveredAny = true;
          this.#recordDeviceDeliveryReceipt({
            destination: stillCurrent,
            run: input.run,
            kind: input.kind,
            dedupeKey: input.dedupeKey,
            outcome: "delivered",
            recordedAt: this.#clock(),
          });
          continue;
        }
        this.#recordDeviceDeliveryReceipt({
          destination: stillCurrent,
          run: input.run,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          outcome: "failed",
          failureCategory: FAILURE_CATEGORY.test(result.category)
            ? result.category
            : "transport-error",
          recordedAt: this.#clock(),
        });
        lastFailure = result;
      }

      if (deliveredAny) {
        const receipt = this.#recordReceipt({
          receiptId: this.#receiptId(input.dedupeKey),
          automationId: input.run.automationId,
          runId: input.run.id,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          outcome: "delivered",
          attemptCount: nextAttempt,
          destinationCount: input.destinations.length,
          recordedAt: this.#clock(),
        });
        this.#safeRecordRunRef(input.run, receipt.receiptId, receipt.recordedAt);
        return;
      }

      const decision = nextAutomationNotificationOutcome({
        cancelled: this.#cancelledDedupeKeys.has(input.dedupeKey),
        attemptCount: nextAttempt,
        send:
          lastFailure === undefined
            ? { kind: "failed", retryable: false }
            : { kind: "failed", retryable: lastFailure.retryable },
      });
      this.#recordReceipt({
        receiptId: this.#receiptId(input.dedupeKey),
        automationId: input.run.automationId,
        runId: input.run.id,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        outcome: decision.outcome,
        attemptCount: nextAttempt,
        destinationCount: input.destinations.length,
        recordedAt: this.#clock(),
        ...(lastFailure === undefined ? {} : { failureCategory: lastFailure.category }),
      });

      if (decision.outcome === "queued" && decision.retryAtOffsetMs !== undefined) {
        const delay = decision.retryAtOffsetMs;
        setTimeout(() => {
          void this.#deliver({
            ...input,
            attemptCount: nextAttempt,
          });
        }, delay);
      } else if (decision.outcome === "failed" || decision.outcome === "exhausted") {
        this.#safeRecordRunRef(input.run, this.#receiptId(input.dedupeKey), this.#clock());
      }
    } finally {
      this.#inflight.delete(input.dedupeKey);
    }
  }

  #recordDeviceDeliveryReceipt(input: {
    readonly destination: PushTokenRecord;
    readonly run: AutomationRun;
    readonly kind: AutomationNotificationKind;
    readonly dedupeKey: string;
    readonly outcome: RemotePushDeliveryOutcome;
    readonly failureCategory?: string;
    readonly recordedAt: UtcTimestamp;
  }): void {
    if (this.#journal === undefined || input.run.threadId === undefined) return;
    const aggregateId = deviceReceiptAggregateId(input.destination, input.dedupeKey);
    try {
      const existing = this.#journal.replayAggregate({
        aggregateType: PUSH_DELIVERY_AGGREGATE,
        aggregateId,
        afterVersion: 0,
        limit: 1,
      });
      if (existing.length > 0) return;
      const eventId = this.#uuid();
      const payload = decodeRemotePushDeliveryRecordedV1({
        hostId: input.destination.hostId,
        deviceId: input.destination.deviceId,
        threadId: String(input.run.threadId),
        kind: input.kind,
        outcome: input.outcome,
        ...(input.failureCategory === undefined ? {} : { failureCategory: input.failureCategory }),
        recordedAt: input.recordedAt,
      });
      this.#journal.append({
        aggregate: { aggregateType: PUSH_DELIVERY_AGGREGATE, aggregateId },
        expectedVersion: 0,
        events: [
          {
            eventId,
            eventName: REMOTE_PUSH_DELIVERY_EVENT_NAMES.recorded,
            eventVersion: 1,
            correlationId: eventId,
            actor: { kind: "system", actorId: this.#hostActorId },
            occurredAt: input.recordedAt,
            payload,
          },
        ],
      });
    } catch {
      // Receipt recording never alters run or delivery lifecycle.
    }
  }

  #clearGone(destination: PushTokenRecord): void {
    try {
      this.#tokens.clear({
        hostId: destination.hostId,
        deviceId: destination.deviceId,
        reason: "destination-gone",
        now: this.#clock(),
      });
    } catch {
      // The registration file already dropped it; a failed journal append
      // leaves the next delivery to find nothing to send to.
    }
  }

  #buildMessage(input: {
    readonly run: AutomationRun;
    readonly definition?: AutomationDefinition;
    readonly kind: AutomationNotificationKind;
    readonly destination: PushTokenRecord;
    readonly sequence: number;
    readonly occurredAt: UtcTimestamp;
    readonly heldSecrets: HeldSecretSnapshot;
  }) {
    const rawMode = input.definition?.mode ?? input.run.definitionSnapshot.mode;
    const mode =
      rawMode === "chat" || rawMode === "work" || rawMode === "code" ? rawMode : undefined;
    const displayName =
      input.definition?.displayName ?? input.run.definitionSnapshot.displayName ?? undefined;
    return buildPushAlert({
      source: "automation",
      kind: input.kind,
      hostId: input.destination.hostId as StableHostId,
      computerLabel: this.#computerLabel(),
      threadTitles: input.destination.preferences.threadTitles,
      collapseId: derivePushCollapseId(
        input.destination.collapseKey,
        String(input.run.threadId ?? input.run.id),
      ),
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      heldSecrets: input.heldSecrets,
      ...(input.run.threadId === undefined
        ? {}
        : {
            threadId: String(input.run.threadId),
            ...(mode === undefined ? {} : { mode }),
          }),
      ...(displayName === undefined ? {} : { displayName }),
    });
  }

  #receiptId(dedupeKey: string): string {
    return deterministicAutomationUuid(`automation-notification-receipt:${dedupeKey}`);
  }

  #recordReceipt(
    input: Parameters<AutomationNotificationDeliveryStore["record"]>[0],
  ): AutomationNotificationDeliveryReceipt {
    return this.#deliveries.record(input);
  }

  #safeRecordRunRef(run: AutomationRun, notificationRef: string, recordedAt: UtcTimestamp): void {
    if (this.#recordRunNotificationRef === undefined) return;
    try {
      this.#recordRunNotificationRef({ run, notificationRef, recordedAt });
    } catch {
      // Notification failure / ref append failure never changes run lifecycle.
    }
  }
}
