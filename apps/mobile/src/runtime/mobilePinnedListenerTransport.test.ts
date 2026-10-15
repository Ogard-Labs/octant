import { describe, expect, it, vi } from "vitest";
import { NO_PINNED_TRANSPORT_COPY, openAppPairingCode } from "@octant/client-runtime";
import { buildPairingCode } from "@octant/domain";
import { mobilePinnedListenerTransport } from "./mobilePinnedListenerTransport";

describe("a pasted pairing code on the phone", () => {
  it("stops before sending anything, since the phone cannot hold a connection to a pin yet", async () => {
    const built = buildPairingCode({
      origin: "https://100.101.102.103:8443",
      ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
      ticketProof: Buffer.alloc(32, 7).toString("base64url"),
      pin: `sha256-${Buffer.alloc(32, 9).toString("base64url")}`,
    });
    if (built.status !== "built") throw new Error(built.reason);
    const platformFetch = vi.spyOn(globalThis, "fetch");

    const opened = await openAppPairingCode({
      code: built.code,
      transport: mobilePinnedListenerTransport,
      webBuildVersion: "0.1.0",
    });

    expect(opened).toEqual({
      status: "refused",
      reason: "no-pinned-transport",
      message: NO_PINNED_TRANSPORT_COPY,
    });
    expect(platformFetch).not.toHaveBeenCalled();
    platformFetch.mockRestore();
  });
});
