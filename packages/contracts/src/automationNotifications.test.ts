import { describe, expect, it } from "vitest";
import {
  decodeAutomationNotificationDeliveryQueryResponse,
  decodeAutomationNotificationDeliveryReceipt,
  decodeAutomationNotificationDeliveryStatus,
  decodeAutomationNotificationPreferences,
  decodeUpdateAutomationNotificationPreferences,
  DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES,
} from "./automationNotifications";

const automationId = "aa000000-0000-4000-8000-000000000001";
const runId = "aa000000-0000-4000-8000-000000000010";
const at = "2026-08-11T12:00:00.000Z";

describe("automationNotifications", () => {
  it("defaults preferences to opt-in disabled and accepts preference updates", () => {
    expect(DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES.enabled).toBe(false);
    expect(
      decodeAutomationNotificationPreferences({
        ...DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES,
        updatedAt: at,
      }),
    ).toMatchObject({ enabled: false, waiting: true });

    expect(
      decodeUpdateAutomationNotificationPreferences({
        enabled: true,
        waiting: true,
        approvalNeeded: false,
        failure: true,
        completion: true,
        expectedVersion: 0,
      }),
    ).toMatchObject({ enabled: true, approvalNeeded: false });

    expect(() =>
      decodeUpdateAutomationNotificationPreferences({
        enabled: true,
        waiting: true,
        approvalNeeded: true,
        failure: true,
        completion: true,
        expectedVersion: 0,
        apnsKey: "secret",
      }),
    ).toThrow();
  });

  it("exposes honest delivery status without tokens or credentials", () => {
    const status = decodeAutomationNotificationDeliveryStatus({
      preferences: {
        ...DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES,
        enabled: true,
        updatedAt: at,
      },
      providerDelivery: "unavailable",
      registeredDestinationCount: 2,
      deliveryEnabled: false,
    });
    expect(status.providerDelivery).toBe("unavailable");
    expect(status.registeredDestinationCount).toBe(2);
    expect(JSON.stringify(status)).not.toContain("token");
    expect(JSON.stringify(status)).not.toContain("apns");
    expect(JSON.stringify(status)).not.toContain("fcm");

    expect(() =>
      decodeAutomationNotificationDeliveryStatus({
        ...status,
        pushTokens: ["secret-token"],
      }),
    ).toThrow();
  });

  it("decodes a scoped delivery query without secrets or raw payloads", () => {
    const query = decodeAutomationNotificationDeliveryQueryResponse({
      status: {
        preferences: {
          ...DEFAULT_AUTOMATION_NOTIFICATION_PREFERENCES,
          updatedAt: at,
        },
        providerDelivery: "unavailable",
        registeredDestinationCount: 0,
        deliveryEnabled: false,
      },
      receipts: [
        {
          receiptId: "receipt-opaque-1",
          automationId,
          runId,
          kind: "failure",
          dedupeKey: `${runId}:failure`,
          outcome: "failed",
          attemptCount: 1,
          destinationCount: 0,
          failureCategory: "provider-unavailable",
          recordedAt: at,
        },
      ],
    });
    expect(query.status.providerDelivery).toBe("unavailable");
    expect(query.receipts).toHaveLength(1);
    expect(query.receipts[0]?.failureCategory).toBe("provider-unavailable");
    expect(JSON.stringify(query)).not.toMatch(/token|apns|fcm|ghp_/i);
  });

  it("accepts durable delivery receipts with opaque refs only", () => {
    const receipt = decodeAutomationNotificationDeliveryReceipt({
      receiptId: "receipt-opaque-1",
      automationId,
      runId,
      kind: "completion",
      dedupeKey: `${runId}:completion`,
      outcome: "delivered",
      attemptCount: 1,
      destinationCount: 1,
      recordedAt: at,
    });
    expect(receipt.outcome).toBe("delivered");
    expect(() =>
      decodeAutomationNotificationDeliveryReceipt({
        ...receipt,
        token: "device-push-token",
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationNotificationDeliveryReceipt({
        ...receipt,
        rawDetail: "/Users/example/secret.diff",
      }),
    ).toThrow();
  });
});
