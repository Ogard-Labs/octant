import { describe, expect, it } from "vitest";
import { decodeHubRelayDevicesReceipt, decodeRelayAddress } from "./hubPublic";

const HUB = "11111111-1111-4111-8111-111111111111";

describe("the relay address a hub names", () => {
  it("is read only as a wss route, so no device or spoke dials the hub unencrypted", () => {
    const named = (relayUrl: string) => ({ hubMemberId: HUB, relayUrl });
    expect(decodeRelayAddress(named("wss://hub.example.com/relay/v1")).relayUrl).toBe(
      "wss://hub.example.com/relay/v1",
    );
    for (const relayUrl of [
      "ws://127.0.0.1:8443/relay/v1",
      "ws://hub.example.com/relay/v1",
      "https://hub.example.com/relay/v1",
    ]) {
      expect(() => decodeRelayAddress(named(relayUrl)), relayUrl).toThrow();
      expect(
        () =>
          decodeHubRelayDevicesReceipt({ status: "recorded", count: 0, relay: named(relayUrl) }),
        relayUrl,
      ).toThrow();
    }
  });
});
