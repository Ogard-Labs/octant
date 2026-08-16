import {
  decodeAutomationNotificationDeliveryQueryResponse,
  decodeAutomationNotificationDeliveryStatus,
  type AutomationDefinition,
  type AutomationId,
  type AutomationNotificationDeliveryQueryResponse,
  type AutomationNotificationDeliveryReceipt,
  type AutomationNotificationDeliveryStatus,
  type AutomationNotificationKind,
  type AutomationNotificationPayloadV1,
  type AutomationRun,
  type AutomationRunLifecycle,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  admitAutomationNotification,
  automationNotificationDedupeKey,
  nextAutomationNotificationOutcome,
} from "@octant/domain/automation-notification-policy";
import {
  automationNotificationKindForLifecycle,
  buildRedactedAutomationPushNotification,
} from "@octant/domain/push-notification-policy";
import type { PushNotificationTokenStore } from "../remote/pushNotificationTokenStore";
import type { AutomationNotificationDeliveryStore } from "./automationNotificationDeliveryStore";
import type { AutomationNotificationPreferencesStore } from "./automationNotificationPreferencesStore";
import type { PushDeliveryTransport } from "./pushDeliveryTransport";
import { deterministicAutomationUuid } from "./automationRunIdentity";

export interface AutomationNotificationDeliveryServiceOptions {
  readonly hostId: string;
  readonly preferences: Pick<AutomationNotificationPreferencesStore, "current">;
  readonly deliveries: Pick<
    AutomationNotificationDeliveryStore,
    "getByDedupeKey" | "record" | "list" | "listByRunId" | "listByAutomationId"
  >;
  readonly tokens: Pick<PushNotificationTokenStore, "listDestinationsForHost">;
  readonly transport: PushDeliveryTransport;
  readonly clock: () => UtcTimestamp;
  readonly uuid?: () => string;
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

/**
 * Host-side Automation notification delivery. Observes run lifecycle truth,
 * builds redacted payloads via the shared domain policy, delivers to registered
 * device destinations, and journals durable receipts. Notification failure
 * never mutates run or ordinary-thread lifecycle.
 */
export class AutomationNotificationDeliveryService {
  readonly #hostId: string;
  readonly #preferences: AutomationNotificationDeliveryServiceOptions["preferences"];
  readonly #deliveries: AutomationNotificationDeliveryServiceOptions["deliveries"];
  readonly #tokens: AutomationNotificationDeliveryServiceOptions["tokens"];
  readonly #transport: PushDeliveryTransport;
  readonly #clock: () => UtcTimestamp;
  readonly #uuid: () => string;
  readonly #recordRunNotificationRef:
    | AutomationNotificationDeliveryServiceOptions["recordRunNotificationRef"]
    | undefined;
  readonly #resolveAutomationProjectId:
    | AutomationNotificationDeliveryServiceOptions["resolveAutomationProjectId"]
    | undefined;
  readonly #cancelledDedupeKeys = new Set<string>();
  readonly #inflight = new Set<string>();

  constructor(options: AutomationNotificationDeliveryServiceOptions) {
    this.#hostId = options.hostId;
    this.#preferences = options.preferences;
    this.#deliveries = options.deliveries;
    this.#tokens = options.tokens;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#uuid = options.uuid ?? (() => deterministicAutomationUuid(`notif:${Date.now()}`));
    this.#recordRunNotificationRef = options.recordRunNotificationRef;
    this.#resolveAutomationProjectId = options.resolveAutomationProjectId;
  }

  status(): AutomationNotificationDeliveryStatus {
    const preferences = this.#preferences.current();
    const providerDelivery = this.#transport.providerDelivery();
    const registeredDestinationCount = this.#tokens.listDestinationsForHost(this.#hostId).length;
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

    const destinations = this.#tokens.listDestinationsForHost(this.#hostId);
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

    const payload = this.#buildPayload(input);
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
      dedupeKey,
      payload,
      destinations,
      attemptCount: queued.attemptCount,
    });
    return queued;
  }

  async #deliver(input: {
    readonly run: AutomationRun;
    readonly dedupeKey: string;
    readonly payload: AutomationNotificationPayloadV1;
    readonly destinations: ReadonlyArray<{
      readonly deviceId: string;
      readonly platform: "ios" | "android";
      readonly token: string;
    }>;
    readonly attemptCount: number;
  }): Promise<void> {
    if (this.#inflight.has(input.dedupeKey)) return;
    if (this.#cancelledDedupeKeys.has(input.dedupeKey)) {
      this.#recordReceipt({
        receiptId: this.#receiptId(input.dedupeKey),
        automationId: input.run.automationId,
        runId: input.run.id,
        kind: input.payload.kind,
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
      let lastFailure:
        | { readonly kind: "failed"; readonly retryable: boolean; readonly category: string }
        | undefined;
      for (const destination of input.destinations) {
        if (this.#cancelledDedupeKeys.has(input.dedupeKey)) {
          this.#recordReceipt({
            receiptId: this.#receiptId(input.dedupeKey),
            automationId: input.run.automationId,
            runId: input.run.id,
            kind: input.payload.kind,
            dedupeKey: input.dedupeKey,
            outcome: "cancelled",
            attemptCount: nextAttempt,
            destinationCount: input.destinations.length,
            recordedAt: this.#clock(),
          });
          return;
        }
        const result = await this.#transport.send({
          destination: {
            deviceId: destination.deviceId,
            platform: destination.platform,
            token: destination.token,
          },
          payload: input.payload,
        });
        if (result.kind === "delivered") {
          const receipt = this.#recordReceipt({
            receiptId: this.#receiptId(input.dedupeKey),
            automationId: input.run.automationId,
            runId: input.run.id,
            kind: input.payload.kind,
            dedupeKey: input.dedupeKey,
            outcome: "delivered",
            attemptCount: nextAttempt,
            destinationCount: input.destinations.length,
            recordedAt: this.#clock(),
          });
          this.#safeRecordRunRef(input.run, receipt.receiptId, receipt.recordedAt);
          return;
        }
        lastFailure = result;
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
        kind: input.payload.kind,
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

  #buildPayload(input: {
    readonly run: AutomationRun;
    readonly definition?: AutomationDefinition;
    readonly kind: AutomationNotificationKind;
  }): AutomationNotificationPayloadV1 {
    const mode =
      input.definition?.mode === "work" || input.definition?.mode === "code"
        ? input.definition.mode
        : input.run.definitionSnapshot.mode === "work" ||
            input.run.definitionSnapshot.mode === "code"
          ? input.run.definitionSnapshot.mode
          : undefined;
    const displayName =
      input.definition?.displayName ?? input.run.definitionSnapshot.displayName ?? undefined;
    return buildRedactedAutomationPushNotification({
      kind: input.kind,
      hostId: this.#hostId,
      automationId: input.run.automationId,
      automationRunId: input.run.id,
      ...(mode === undefined ? {} : { mode }),
      ...(input.run.threadId === undefined ? {} : { threadId: input.run.threadId }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(input.run.failure === undefined ? {} : { rawDetail: input.run.failure.message }),
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
