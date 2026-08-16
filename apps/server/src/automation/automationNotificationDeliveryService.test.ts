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
import { createPushNotificationTokenStore } from "../remote/pushNotificationTokenStore";
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
const hostId = "local";
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
    .register(AUTOMATION_NOTIFICATION_DELIVERY_RECORDED, 1, AutomationNotificationDeliveryRecorded);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  return new Journal({ connection, registry, projections, clock: () => now });
}

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
    const tokens = createPushNotificationTokenStore();
    tokens.register({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "super-secret-apns-token",
      now,
    });
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      hostId,
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
    const payload = transport.sent[0]?.payload;
    expect(payload?.body).toBe("Details available on the host.");
    expect(JSON.stringify(payload)).not.toContain("ghp_");
    expect(JSON.stringify(payload)).not.toContain("/Users/");
    expect(JSON.stringify(payload)).not.toContain("super-secret-apns-token");

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
    const tokens = createPushNotificationTokenStore();
    tokens.register({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "token",
      now,
    });
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      hostId,
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
    const tokens = createPushNotificationTokenStore();
    tokens.register({
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
      hostId,
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

    const tokens = createPushNotificationTokenStore();
    tokens.register({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "token",
      now,
    });
    const transport = createRecordingPushDeliveryTransport();
    const service = new AutomationNotificationDeliveryService({
      hostId,
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
    const tokens = createPushNotificationTokenStore();
    tokens.register({
      hostId,
      deviceId: "device-1",
      platform: "ios",
      token: "token",
      now,
    });
    const service = new AutomationNotificationDeliveryService({
      hostId,
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
});
