import { describe, expect, it, vi } from "vitest";
import { clearMobilePushToken, registerMobilePushToken } from "./mobilePushTokenClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

describe("mobilePushTokenClient", () => {
  it("registers and clears push tokens over authenticated transport", async () => {
    const fetch = vi.fn(async ({ method }: { method: string; body?: string }) => {
      if (method === "PUT") {
        return Response.json({
          result: "registered",
          occurredAt: "2026-08-05T12:00:00.000Z",
        });
      }
      return Response.json({
        result: "cleared",
        occurredAt: "2026-08-05T12:01:00.000Z",
      });
    });
    const transport = {
      hostId: "11111111-1111-4111-8111-111111111111",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    await expect(
      registerMobilePushToken({
        transport,
        platform: "ios",
        token: "opaque-token",
        notificationPublicKey: "MJaD3ARvNKlDGKOdP1uw2ORQnq9V7CJeVRT9Xg09h3E",
        preferences: {
          approvalNeeded: true,
          waiting: true,
          failure: true,
          completion: true,
          threadTitles: false,
        },
      }),
    ).resolves.toMatchObject({ result: "registered" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[0]?.body))).toMatchObject({
      notificationPublicKey: "MJaD3ARvNKlDGKOdP1uw2ORQnq9V7CJeVRT9Xg09h3E",
      preferences: { threadTitles: false },
    });
    await expect(clearMobilePushToken(transport)).resolves.toMatchObject({ result: "cleared" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
