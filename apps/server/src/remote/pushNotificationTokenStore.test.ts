import { describe, expect, it } from "vitest";
import { createPushNotificationTokenStore } from "./pushNotificationTokenStore";

describe("pushNotificationTokenStore", () => {
  it("registers, idempotently re-registers, and clears per device", () => {
    const store = createPushNotificationTokenStore();
    const base = {
      hostId: "host-a",
      deviceId: "device-1",
      platform: "ios" as const,
      token: "token-a",
      now: "2026-08-05T12:00:00.000Z",
    };
    expect(store.register(base)).toEqual({ result: "registered" });
    expect(store.register(base)).toEqual({ result: "already-registered" });
    expect(store.register({ ...base, token: "token-b" })).toEqual({ result: "registered" });
    expect(store.get({ hostId: "host-a", deviceId: "device-1" })?.token).toBe("token-b");
    expect(store.clear({ hostId: "host-a", deviceId: "device-1" })).toEqual({ result: "cleared" });
    expect(store.clear({ hostId: "host-a", deviceId: "device-1" })).toEqual({
      result: "already-cleared",
    });
    expect(store.get({ hostId: "host-a", deviceId: "device-1" })).toBeUndefined();
  });

  it("isolates tokens across devices on the same host", () => {
    const store = createPushNotificationTokenStore();
    store.register({
      hostId: "host-a",
      deviceId: "phone",
      platform: "ios",
      token: "phone-token",
      now: "2026-08-05T12:00:00.000Z",
    });
    store.register({
      hostId: "host-a",
      deviceId: "tablet",
      platform: "android",
      token: "tablet-token",
      now: "2026-08-05T12:00:00.000Z",
    });
    store.clear({ hostId: "host-a", deviceId: "phone" });
    expect(store.get({ hostId: "host-a", deviceId: "tablet" })?.token).toBe("tablet-token");
    expect(store.listDeviceIdsForHost("host-a")).toEqual(["tablet"]);
  });
});
