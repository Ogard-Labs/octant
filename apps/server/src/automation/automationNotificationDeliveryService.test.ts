import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AutomationNotificationDeliveryRecorded,
  AutomationNotificationPreferences,
  EventActor,
  RemotePushDeliveryRecordedV1,
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
} from "./pushDeliveryTransport.test-support";
import {
  automationRunFixture,
  AUTOMATION_TEST_IDS,
  AUTOMATION_TEST_NOW,
} from "./automationTestFixtures";

const directories: Array<string> = [];
const hostId = "11111111-1111-4111-8111-111111111111";
const now = AUTOMATION_TEST_NOW;

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
    .register(AUTOMATION_NOTIFICATION_DELIVERY_RECORDED, 1, AutomationNotificationDeliveryRecorded)
    .register("remote.push-delivery-recorded@1", 1, RemotePushDeliveryRecordedV1);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  return {
    connection,
    journal: new Journal({ connection, registry, projections, clock: () => now }),
  };
}

function destinationsOf(
  entries: ReadonlyArray<{
    readonly hostId: string;
    readonly deviceId: string;
    readonly platform: PushTokenRecord["platform"];
    readonly token: string;
    readonly now: string;
    readonly threadTitles?: boolean;
  }>,
) {
  const records: Array<PushTokenRecord> = entries.map((input, idx) => ({
    version: 2,
    hostId: input.hostId,
    deviceId: input.deviceId,
    platform: input.platform,
    token: input.token,
    preferences: {
      approvalNeeded: true,
      waiting: true,
      failure: true,
      completion: true,
      threadTitles: input.threadTitles ?? false,
    },
    collapseKey: Buffer.alloc(32, idx + 3).toString("base64url"),
    updatedAt: input.now,
  }));
  return {
    listDestinations: (): ReadonlyArray<PushTokenRecord> => [...records],
    get: (key: { readonly hostId: string; readonly deviceId: string }) =>
      records.find((r) => r.hostId === key.hostId && r.deviceId === key.deviceId),
    clear: (key: { readonly hostId: string; readonly deviceId: string }) => {
      const idx = records.findIndex((r) => r.hostId === key.hostId && r.deviceId === key.deviceId);
      if (idx === -1) return { result: "already-cleared" as const };
      records.splice(idx, 1);
      return { result: "cleared" as const };
    },
  };
}

const standing = {
  hasStanding: () => true,
  computerLabel: () => "Studio Mac",
  readHeldSecrets: async () => ({ status: "ready" as const, values: [] }),
};

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
  it("drops planted secrets and failure detail from v2 push messages and never exposes tokens in receipts or status", async () => {
    const { journal } = createJournal();
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
    const tokens = destinationsOf([
      {
        hostId,
        deviceId: "22222222-2222-4222-8222-222222222222",
        platform: "ios",
        token: "super-secret-apns-token",
        now,
        threadTitles: true,
      },
    ]);
    const heldSecret = "automation-canary-secret-4123";
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      readHeldSecrets: async () => ({ status: "ready", values: [heldSecret] }),
      preferences,
      deliveries,
      tokens,
      transport,
      clock: () => now as never,
    });

    const base = automationRunFixture();
    const run = notifiableRun({
      lifecycle: "failed",
      definitionSnapshot: {
        ...base.definitionSnapshot,
        displayName: `Rotate ${heldSecret} nightly`,
      },
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
    const message = transport.sent[0]?.message;
    expect(message).toMatchObject({
      type: "alert",
      alert: {
        version: 2,
        kind: "failure",
        hostId,
        title: "Automation failed",
        body: "On Studio Mac",
      },
    });
    for (const leaked of [heldSecret, "ghp_", "/Users/", "super-secret-apns-token"]) {
      expect(JSON.stringify(message)).not.toContain(leaked);
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

  it("omits mode when an automation fails before creating its thread so phone parsers keep the alert", async () => {
    const { journal } = createJournal();
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
    const tokens = destinationsOf([
      {
        hostId,
        deviceId: "22222222-2222-4222-8222-222222222222",
        platform: "ios",
        token: "apns-token-pre-thread",
        now,
        threadTitles: true,
      },
    ]);
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens,
      transport,
      clock: () => now as never,
    });

    const base = automationRunFixture();
    const failedBeforeThread: AutomationRun = {
      ...base,
      lifecycle: "failed",
      failure: {
        reason: "thread-creation-failed",
        message: "Repository could not be opened",
      },
    };
    expect(failedBeforeThread.threadId).toBeUndefined();

    service.observeRunStatusChanged({
      run: failedBeforeThread,
      previousLifecycle: "dispatching",
    });

    await vi.waitFor(() => {
      expect(transport.sent.length).toBe(1);
    });
    const sent = transport.sent[0]?.message;
    expect(sent?.type).toBe("alert");
    if (sent?.type === "alert") {
      expect(sent.alert.kind).toBe("failure");
      expect(sent.alert.threadId).toBeUndefined();
      expect(sent.alert.mode).toBeUndefined();
      expect(sent.alert.title).toBe(
        `Automation failed: ${failedBeforeThread.definitionSnapshot.displayName}`,
      );
    }
  });

  it("delivers to all standing phones and records remote.push-delivery-recorded@1 per device when the run has a threadId", async () => {
    const { connection, journal } = createJournal();
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
    const phone1 = "22222222-2222-4222-8222-222222222222";
    const phone2 = "33333333-3333-4333-8333-333333333333";
    const tokens = destinationsOf([
      { hostId, deviceId: phone1, platform: "ios", token: "tok-1", now, threadTitles: false },
      { hostId, deviceId: phone2, platform: "android", token: "tok-2", now, threadTitles: true },
    ]);
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens,
      transport,
      journal,
      uuid,
      hostActorId: AUTOMATION_TEST_IDS.actor,
      clock: () => now as never,
    });

    const run = notifiableRun({ lifecycle: "completed" });
    service.observeRunStatusChanged({ run, previousLifecycle: "running" });

    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(transport.sent.map((entry) => entry.destination.deviceId)).toEqual([phone1, phone2]);
    expect(transport.sent[0]?.message).toMatchObject({
      type: "alert",
      alert: { title: "Automation completed" },
    });
    expect(transport.sent[1]?.message).toMatchObject({
      type: "alert",
      alert: { title: `Automation completed: ${run.definitionSnapshot.displayName}` },
    });

    const pushReceipts = (
      connection
        .prepare(
          "SELECT payload_json FROM event_journal WHERE event_name = 'remote.push-delivery-recorded@1' ORDER BY global_sequence",
        )
        .all() as ReadonlyArray<{ readonly payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    expect(pushReceipts).toHaveLength(2);
    expect(pushReceipts.map((r) => [r.deviceId, r.threadId, r.kind, r.outcome])).toEqual([
      [phone1, String(run.threadId), "completion", "delivered"],
      [phone2, String(run.threadId), "completion", "delivered"],
    ]);
  });

  it("skips disabled preferences and duplicates without mutating run lifecycle", async () => {
    const { journal } = createJournal();
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
    const tokens = destinationsOf([
      {
        hostId,
        deviceId: "22222222-2222-4222-8222-222222222222",
        platform: "ios",
        token: "token",
        now,
      },
    ]);
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
    const skipped = service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    expect(skipped?.outcome).toBe("skipped-preference");

    preferences.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const first = service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    expect(first?.outcome).toBe("queued");
    await vi.waitFor(() => {
      expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.outcome).toBe("delivered");
    });
    const duplicate = service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    expect(duplicate?.outcome).toBe("delivered");
    expect(duplicate?.receiptId).toBe(first?.receiptId);
  });

  it("reports unavailable provider delivery honestly and sends nothing to a device without standing", async () => {
    const { journal } = createJournal();
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
    const service = new AutomationNotificationDeliveryService({
      ...standing,
      preferences,
      deliveries,
      tokens: destinationsOf([
        {
          hostId,
          deviceId: "22222222-2222-4222-8222-222222222222",
          platform: "ios",
          token: "token",
          now,
        },
      ]),
      transport: createUnavailablePushDeliveryTransport(),
      clock: () => now as never,
    });
    expect(service.status().providerDelivery).toBe("unavailable");
    const run = notifiableRun({ lifecycle: "completed" });
    service.observeRunStatusChanged({ run, previousLifecycle: "running" });
    await vi.waitFor(() => {
      expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.outcome).toBe("failed");
    });
    expect(deliveries.getByDedupeKey(`${run.id}:completion`)?.failureCategory).toBe(
      "provider-unavailable",
    );

    const { journal: journal2 } = createJournal();
    const uuid2 = sharedUuid();
    const preferences2 = new AutomationNotificationPreferencesStore({
      journal: journal2,
      uuid: uuid2,
      actor,
      clock: () => now,
    });
    preferences2.update({
      enabled: true,
      waiting: true,
      approvalNeeded: true,
      failure: true,
      completion: true,
      expectedVersion: 0 as never,
    });
    const deliveries2 = new AutomationNotificationDeliveryStore({
      journal: journal2,
      uuid: uuid2,
      actor,
      clock: () => now,
    });
    const transport2 = createRecordingPushDeliveryTransport();
    let active = true;
    const service2 = new AutomationNotificationDeliveryService({
      hasStanding: () => {
        const was = active;
        active = false;
        return was;
      },
      computerLabel: () => "Studio Mac",
      readHeldSecrets: async () => ({ status: "ready", values: [] }),
      preferences: preferences2,
      deliveries: deliveries2,
      tokens: destinationsOf([
        {
          hostId,
          deviceId: "22222222-2222-4222-8222-222222222222",
          platform: "ios",
          token: "t",
          now,
        },
      ]),
      transport: transport2,
      clock: () => now as never,
    });
    service2.observeRunStatusChanged({ run, previousLifecycle: "running" });
    await vi.waitFor(() => {
      expect(deliveries2.getByDedupeKey(`${run.id}:completion`)?.outcome).toBe("failed");
    });
    expect(deliveries2.getByDedupeKey(`${run.id}:completion`)?.failureCategory).toBe(
      "destination-without-standing",
    );
    expect(transport2.sent).toHaveLength(0);
  });
});
