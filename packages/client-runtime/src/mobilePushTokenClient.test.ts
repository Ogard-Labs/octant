import { describe, expect, it, vi } from "vitest";
import {
  clearMobilePushToken,
  readMobilePushStatus,
  registerMobilePushToken,
} from "./mobilePushTokenClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

describe("mobilePushTokenClient", () => {
  it("reads host push availability and recognizes older hosts returning 404 or 405 as update-host", async () => {
    const transportOf = (response: () => Promise<Response>): MobileRemoteTransport => ({
      hostId: "11111111-1111-4111-8111-111111111111",
      authenticatedFetch: response as unknown as MobileRemoteTransport["authenticatedFetch"],
    });

    await expect(
      readMobilePushStatus(
        transportOf(async () =>
          Response.json({ status: "available", platforms: { ios: true, android: false } }),
        ),
      ),
    ).resolves.toEqual({
      status: "ready",
      push: { status: "available", platforms: { ios: true, android: false } },
    });

    await expect(
      readMobilePushStatus(
        transportOf(async () => Response.json({ status: "unavailable", reason: "off" })),
      ),
    ).resolves.toEqual({
      status: "ready",
      push: { status: "unavailable", reason: "off" },
    });

    await expect(
      readMobilePushStatus(
        transportOf(async () => new Response("Method Not Allowed", { status: 405 })),
      ),
    ).resolves.toEqual({ status: "update-host" });

    await expect(
      readMobilePushStatus(transportOf(async () => new Response("Not Found", { status: 404 }))),
    ).resolves.toEqual({ status: "update-host" });
  });

  it("registers v2 push tokens directly and clears them over authenticated transport", async () => {
    const fetch = vi.fn(async ({ method }: { method: string; body?: string }) => {
      if (method === "PUT") {
        return Response.json({
          result: "registered",
          occurredAt: "2026-11-28T12:00:00.000Z",
        });
      }
      return Response.json({
        result: "cleared",
        occurredAt: "2026-11-28T12:01:00.000Z",
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
        preferences: {
          approvalNeeded: true,
          waiting: true,
          failure: true,
          completion: true,
          threadTitles: false,
        },
      }),
    ).resolves.toMatchObject({ result: "registered" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[0]?.body))).toEqual({
      version: 2,
      platform: "ios",
      token: "opaque-token",
      preferences: {
        approvalNeeded: true,
        waiting: true,
        failure: true,
        completion: true,
        threadTitles: false,
      },
    });
    await expect(clearMobilePushToken(transport)).resolves.toMatchObject({ result: "cleared" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
