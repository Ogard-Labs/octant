import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AutomationNotificationDeliveryRecorded,
  AutomationNotificationPreferences,
  EventActor,
  type AutomationRun,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { PushTokenRecord } from "../remote/pushNotificationTokenStore";
import {
  openSealedPushNotification,
  phoneNotificationKeys,
} from "../remote/pushNotificationSealing.test-support";
import {
  AUTOMATION_NOTIFICATION_PREFERENCES_UPDATED,
  AutomationNotificationPreferencesStore,
} from "./automationNotificationPreferencesStore";
import {
  AUTOMATION_NOTIFICATION_DELIVERY_RECORDED,
  AutomationNotificationDeliveryStore,
} from "./automationNotificationDeliveryStore";
import { AutomationNotificationDeliveryService } from "./automationNotificationDeliveryService";
import {
  createRecordingPushDeliveryTransport,
  createUnavailablePushDeliveryTransport,
} from "./pushDeliveryTransport";
import {
  automationRunFixture,
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
} from "./automationTestFixtures";

const directories: Array<string> = [];
// Phones register under the private listener's host id, not the host's own
// local id; delivery seals under the id the phone paired with.
const hostId = "11111111-1111-4111-8111-111111111111";
const now = AUTOMATION_TEST_NOW;
const deviceKeys = phoneNotificationKeys();

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-automation-notifications-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: AUTOMATION_TEST_IDS.actor,
});

function createJournal(connection = openConnection()) {
  const registry = new EventRegistry()
    .register(AUTOMATION_NOTIFICATION_PREFERENCES_UPDATED, 1, AutomationNotificationPreferences)
    .register(AUTOMATION_NOTIFICATION_DELIVERY_RECORDED, 1, AutomationNotificationDeliveryRecorded);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  return new Journal({ connection, registry, projections, clock: () => now });
}

/** One registered destination, as the host's registration store lists it for delivery. */
function destinationsOf(input: {
  readonly hostId: string;
  readonly deviceId: string;
  readonly platform: PushTokenRecord["platform"];
  readonly token: string;
  readonly now: string;
  readonly threadTitles?: boolean;
}) {
  let record: PushTokenRecord | undefined = {
    hostId: input.hostId,
    deviceId: input.deviceId,
    platform: input.platform,
    token: input.token,
    notificationPublicKey: deviceKeys.publicKey,
    preferences: {
      approvalNeeded: true,
      waiting: true,
      failure: true,
      completion: true,
      threadTitles: input.threadTitles ?? false,
    },
    collapseKey: Buffer.alloc(32, 3).toString("base64url"),
    updatedAt: input.now,
  };
  return {
    listDestinations: (): ReadonlyArray<PushTokenRecord> => (record === undefined ? [] : [record]),
    get: (key: { readonly hostId: string; readonly deviceId: string }) =>
      record !== undefined && record.hostId === key.hostId && record.deviceId === key.deviceId
        ? record
        : undefined,
    clear: () => {
      const had = record !== undefined;
      record = undefined;
      return { result: had ? ("cleared" as const) : ("already-cleared" as const) };
    },
  };
}

const standing = { hasStanding: () => true, computerLabel: () => "Studio Mac" };

function sharedUuid() {
  let counter = 0;
  return () => {
    counter += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${counter.toString(16).padStart(12, "0")}`;
  };
}

function notifiableRun(
  overrides: Partial<AutomationRun> & {
    readonly lifecycle: AutomationRun["lifecycle"];
  },
): AutomationRun {
  const base = automationRunFixture();
  const threadId = "aa000000-0000-4000-8000-0000000000d0" as AutomationRun["threadId"];
  return {
    ...base,
    threadId,
    dispatchIntent: {
      firstTurnRequestId: base.firstTurnRequestId,
      threadId: threadId!,
      authoritySnapshot: base.authoritySnapshot,
      promptDigest: "automation-prompt-digest" as never,
      recordedAt: now as never,
    },
    firstTurnAcceptance: {
      firstTurnRequestId: base.firstTurnRequestId,
      runtimeReceipt: "runtime-receipt-1" as never,
      acceptedAt: now as never,
    },
    ...overrides,
  } as AutomationRun;
}

describe("AutomationNotificationDeliveryService", () => {
  it("scrubs hostile secrets from payloads and never exposes tokens in receipts or status", async () => {
    const journal = createJournal();
    const uuid = sharedUuid();
    const preferences = new AutomationNotificationPreferencesStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const deliveries = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    const tokens = destinationsOf({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "super-secret-apns-token",
      now,
    });
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens,
      transport,
      clock: () => now as never,
    });

    const run = notifiableRun({
      lifecycle: "failed",
      failure: {
        reason: "thread-creation-failed",
        message: "Provider rejected ghp_exampletoken with /Users/example/secret.diff",
      },
    });
    const receipt = service.observeRunStatusChanged({
      run,
      previousLifecycle: "dispatching",
    });
    expect(receipt?.outcome).toBe("queued");

    await vi.waitFor(() => {
      expect(transport.sent.length).toBe(1);
    });
    const envelope = transport.sent[0]?.envelope;
    if (envelope === undefined) throw new Error("expected a sealed envelope");
    expect(envelope.alert).toEqual({ title: "Octant", body: "A paired computer has an update" });
    const payload = openSealedPushNotification({
      envelope,
      recipient: deviceKeys.privateKey,
      hostId,
      deviceId: "device-1",
    });
    expect(payload).toMatchObject({ hostId, title: "Automation failed", body: "On Studio Mac" });
    for (const leaked of ["ghp_", "/Users/", "super-secret-apns-token"]) {
      expect(JSON.stringify(payload)).not.toContain(leaked);
      expect(JSON.stringify(envelope)).not.toContain(leaked);
    }

    const status = service.status();
    expect(status.providerDelivery).toBe("available");
    expect(status.registeredDestinationCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain("super-secret");
    expect(JSON.stringify(status)).not.toMatch(/apns|fcm|token/i);

    const delivered = deliveries.getByDedupeKey(`${run.id}:failure`);
    expect(delivered?.outcome).toBe("delivered");
    expect(JSON.stringify(delivered)).not.toContain("super-secret");
  });

  it("skips disabled preferences and duplicates without mutating run lifecycle", async () => {
    const journal = createJournal();
    const uuid = sharedUuid();
    const preferences = new AutomationNotificationPreferencesStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    const deliveries = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    const tokens = destinationsOf({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "token",
      now,
    });
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens,
      transport,
      clock: () => now as never,
    });
    const run = notifiableRun({ lifecycle: "completed" });
    const lifecycleBefore = run.lifecycle;

    const skipped = service.observeRunStatusChanged({
      run,
      previousLifecycle: "running",
    });
    expect(skipped?.outcome).toBe("skipped-preference");
    expect(run.lifecycle).toBe(lifecycleBefore);

    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const first = service.observeRunStatusChanged({
      run,
      previousLifecycle: "running",
    });
    expect(first?.outcome).toBe("queued");
    await vi.waitFor(() => {
      expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.outcome).toBe("delivered");
    });
    const duplicate = service.observeRunStatusChanged({
      run,
      previousLifecycle: "running",
    });
    expect(duplicate?.outcome).toBe("delivered");
    expect(duplicate?.receiptId).toBe(first?.receiptId);
    expect(run.lifecycle).toBe("completed");
  });

  it("bounds retry then exhausts without changing run truth when transport fails", async () => {
    const journal = createJournal();
    const uuid = sharedUuid();
    const preferences = new AutomationNotificationPreferencesStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const deliveries = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    const tokens = destinationsOf({
      hostId,
      deviceId: "device-1",
      platform: "android",
      token: "fcm-token",
      now,
    });
    const transport = createRecordingPushDeliveryTransport({
      send: async () => ({ kind: "failed", retryable: false, category: "provider-rejected" }),
    });
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens,
      transport,
      clock: () => now as never,
    });
    const run = notifiableRun({ lifecycle: "waiting" });
    service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    await vi.waitFor(() => {
      expect(deliveries.getByDedupeKey(`${run.id}:waiting`)?.outcome).toBe("failed");
    });
    expect(run.lifecycle).toBe("waiting");
  });

  it("rebuilds durable receipts after restart so duplicates stay idempotent", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    const uuid = sharedUuid();
    const preferences = new AutomationNotificationPreferencesStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const deliveries = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    deliveries.record({
      receiptId: "receipt-opaque-restart",
      automationId: AUTOMATION_TEST_IDS.automation as never,
      runId: AUTOMATION_TEST_IDS.run as never,
      kind: "completion",
      dedupeKey: `${AUTOMATION_TEST_IDS.run}:completion`,
      outcome: "delivered",
      attemptCount: 1,
      destinationCount: 1,
      recordedAt: now as never,
    });

    const rebuilt = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    expect(rebuilt.getByDedupeKey(`${AUTOMATION_TEST_IDS.run}:completion`)?.outcome).toBe(
      "delivered",
    );

    const tokens = destinationsOf({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "token",
      now,
    });
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries: rebuilt,
      tokens,
      transport,
      clock: () => now as never,
    });
    const run = notifiableRun({ lifecycle: "completed" });
    const again = service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    expect(again?.outcome).toBe("delivered");
    expect(transport.sent).toHaveLength(0);
  });

  it("reports unavailable provider delivery honestly when credentials are absent", async () => {
    const journal = createJournal();
    const uuid = sharedUuid();
    const preferences = new AutomationNotificationPreferencesStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const deliveries = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    const tokens = destinationsOf({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "token",
      now,
    });
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens,
      transport: createUnavailablePushDeliveryTransport(),
      clock: () => now as never,
      resolveAutomationProjectId: (automationId) =>
        String(automationId) === AUTOMATION_TEST_IDS.automation
          ? AUTOMATION_TEST_IDS.project
          : undefined,
    });
    const status = service.status();
    expect(status.providerDelivery).toBe("unavailable");
    expect(status.deliveryEnabled).toBe(false);
    expect(status.preferences.enabled).toBe(true);

    const run = notifiableRun({ lifecycle: "completed" });
    service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    await vi.waitFor(() => {
      expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.outcome).toBe("failed");
    });
    expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.failureCategory).toBe(
      "provider-unavailable",
    );

    const query = service.queryDeliveries({
      automationId: AUTOMATION_TEST_IDS.automation,
      projectId: AUTOMATION_TEST_IDS.project,
    });
    expect(query.status.providerDelivery).toBe("unavailable");
    expect(query.status.deliveryEnabled).toBe(false);
    expect(query.receipts.some((receipt) => receipt.outcome === "delivered")).toBe(false);
    expect(query.receipts[0]?.failureCategory).toBe("provider-unavailable");
    expect(JSON.stringify(query)).not.toMatch(/token|apns|fcm/i);

    expect(
      service.queryDeliveries({
        automationId: AUTOMATION_TEST_IDS.automation,
        projectId: "bb000000-0000-4000-8000-000000000099",
      }).receipts,
    ).toHaveLength(0);
  });

  it("delivers to a phone registered under the listener's host id and seals under that id", async () => {
    const journal = createJournal();
    const uuid = sharedUuid();
    const preferences = new AutomationNotificationPreferencesStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const deliveries = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens: destinationsOf({
        hostId,
        deviceId: "device-1",
        platform: "ios",
        token: "token",
        now,
        threadTitles: true,
      }),
      transport,
      clock: () => now as never,
    });
    expect(service.status().registeredDestinationCount).toBe(1);

    const run = notifiableRun({ lifecycle: "completed" });
    service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    await vi.waitFor(() => {
      expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.outcome).toBe("delivered");
    });
    const envelope = transport.sent[0]?.envelope;
    if (envelope === undefined) throw new Error("expected a sealed envelope");
    const opened = openSealedPushNotification({
      envelope,
      recipient: deviceKeys.privateKey,
      hostId,
      deviceId: "device-1",
    }) as { readonly hostId: string; readonly title: string };
    expect(opened.hostId).toBe(hostId);
    // The phone opted in to titles, so the automation's name may show.
    expect(opened.title).toBe(`Automation completed: ${run.definitionSnapshot.displayName}`);
  });

  it("sends nothing to a device that lost its standing after the run was observed", async () => {
    const journal = createJournal();
    const uuid = sharedUuid();
    const preferences = new AutomationNotificationPreferencesStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const deliveries = new AutomationNotificationDeliveryStore({
      journal,
      uuid,
      actor,
      clock: () => now,
    });
    const transport = createRecordingPushDeliveryTransport();
    let active = true;
    const service = new AutomationNotificationDeliveryService({
      // Standing holds when the run is observed and is gone at send time.
      hasStanding: () => {
        const was = active;
        active = false;
        return was;
      },
      computerLabel: () => "Studio Mac",
      preferences,
      deliveries,
      tokens: destinationsOf({ hostId, deviceId: "device-1", platform: "ios", token: "t", now }),
      transport,
      clock: () => now as never,
    });
    const run = notifiableRun({ lifecycle: "completed" });
    expect(service.observeRunStatusChanged({ run, previousLifecycle: "running" })?.outcome).toBe(
      "queued",
    );
    await vi.waitFor(() => {
      expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.outcome).toBe("failed");
    });
    expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.failureCategory).toBe(
      "destination-without-standing",
    );
    expect(transport.sent).toHaveLength(0);
  });
});
