import { describe, expect, it, vi } from "vitest";
import {
  clearMobilePushToken,
  registerMobilePushToken,
  requestMobilePushCapability,
} from "./mobilePushTokenClient";
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

describe("asking the push gateway for a capability", () => {
  const input = {
    gatewayUrl: "https://push.example.test",
    platform: "ios" as const,
    token: "a".repeat(64),
    hostKeyFingerprint: "f".repeat(64),
  };

  it("posts the platform, token, and host fingerprint and returns the capability", async () => {
    const capability = `v1.k1.${"C".repeat(64)}`;
    const calls: Array<{ readonly url: string; readonly body: string }> = [];
    const answering = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return Response.json({ capability });
    };
    await expect(
      requestMobilePushCapability({ ...input, fetch: answering as typeof globalThis.fetch }),
    ).resolves.toEqual({ status: "issued", capability });
    expect(calls[0]?.url).toBe("https://push.example.test/v1/capabilities");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      platform: "ios",
      token: input.token,
      hostKeyFingerprint: input.hostKeyFingerprint,
    });
  });

  it("returns the gateway's refusal code, and an unreachable gateway as unreachable", async () => {
    const refusing = async () => Response.json({ code: "unavailable" }, { status: 503 });
    await expect(
      requestMobilePushCapability({ ...input, fetch: refusing as typeof globalThis.fetch }),
    ).resolves.toEqual({ status: "refused", code: "unavailable" });
    const failing = async () => {
      throw new TypeError("network");
    };
    await expect(
      requestMobilePushCapability({ ...input, fetch: failing as typeof globalThis.fetch }),
    ).resolves.toEqual({ status: "unreachable" });
  });
});
