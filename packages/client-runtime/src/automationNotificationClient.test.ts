import { describe, expect, it, vi } from "vitest";
import {
  AutomationNotificationClientFailure,
  createAutomationNotificationClient,
} from "./automationNotificationClient";

describe("createAutomationNotificationClient", () => {
  it("reads honest delivery status without inventing secrets", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/automation-notifications/status");
      return Response.json({
        status: {
          preferences: {
            enabled: true,
            waiting: true,
            approvalNeeded: true,
            failure: true,
            completion: true,
            version: 1,
            updatedAt: "2026-08-11T12:00:00.000Z",
          },
          providerDelivery: "unavailable",
          registeredDestinationCount: 0,
          deliveryEnabled: false,
        },
      });
    });
    const client = createAutomationNotificationClient({
      baseUrl: "http://127.0.0.1:4310",
      fetch: fetchImpl as typeof fetch,
    });
    const status = await client.status();
    expect(status.providerDelivery).toBe("unavailable");
    expect(status.deliveryEnabled).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/token|apns|fcm/i);
  });

  it("queries scoped delivery receipts and retries once on reconnect", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      attempts += 1;
      expect(String(input)).toContain("/api/automation-notifications/deliveries");
      expect(String(input)).toContain("automationId=aa000000-0000-4000-8000-000000000001");
      expect(String(input)).toContain("projectId=aa000000-0000-4000-8000-000000000020");
      if (attempts === 1) throw new TypeError("network down");
      return Response.json({
        status: {
          preferences: {
            enabled: true,
            waiting: true,
            approvalNeeded: true,
            failure: true,
            completion: true,
            version: 1,
            updatedAt: "2026-08-11T12:00:00.000Z",
          },
          providerDelivery: "unavailable",
          registeredDestinationCount: 0,
          deliveryEnabled: false,
        },
        receipts: [
          {
            receiptId: "receipt-opaque-1",
            automationId: "aa000000-0000-4000-8000-000000000001",
            runId: "aa000000-0000-4000-8000-000000000010",
            kind: "completion",
            dedupeKey: "aa000000-0000-4000-8000-000000000010:completion",
            outcome: "failed",
            attemptCount: 1,
            destinationCount: 0,
            failureCategory: "provider-unavailable",
            recordedAt: "2026-08-11T12:00:00.000Z",
          },
        ],
      });
    });
    const client = createAutomationNotificationClient({
      baseUrl: "http://127.0.0.1:4310",
      fetch: fetchImpl as typeof fetch,
      maxAttempts: 2,
    });
    const query = await client.deliveries({
      automationId: "aa000000-0000-4000-8000-000000000001",
      projectId: "aa000000-0000-4000-8000-000000000020",
    });
    expect(attempts).toBe(2);
    expect(query.status.providerDelivery).toBe("unavailable");
    expect(query.receipts[0]?.outcome).toBe("failed");
    expect(query.receipts[0]?.failureCategory).toBe("provider-unavailable");
    expect(JSON.stringify(query)).not.toMatch(/token|apns|fcm/i);
  });

  it("maps unauthorized preference updates", async () => {
    const client = createAutomationNotificationClient({
      baseUrl: "http://127.0.0.1:4310",
      fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
    });
    await expect(
      client.update({
        enabled: true,
        waiting: true,
        approvalNeeded: true,
        failure: true,
        completion: true,
        expectedVersion: 0 as never,
      }),
    ).rejects.toBeInstanceOf(AutomationNotificationClientFailure);
  });
});
