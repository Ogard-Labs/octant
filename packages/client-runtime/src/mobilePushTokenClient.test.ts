import { describe, expect, it, vi } from "vitest";
import { clearMobilePushToken, registerMobilePushToken } from "./mobilePushTokenClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

describe("mobilePushTokenClient", () => {
  it("registers and clears push tokens over authenticated transport", async () => {
    const fetch = vi.fn(async ({ method }: { method: string }) => {
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
      }),
    ).resolves.toMatchObject({ result: "registered" });
    await expect(clearMobilePushToken(transport)).resolves.toMatchObject({ result: "cleared" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
