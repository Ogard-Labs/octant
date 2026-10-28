import { RelayGrantV1 } from "@octant/contracts/hosted-relay";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  chooseRemotePath,
  DIRECT_PATH_CONNECT_TIMEOUT_MS,
  type RelayPathRecord,
} from "./hostedRelayPathPolicy";

const grant = Schema.decodeUnknownSync(RelayGrantV1)({
  relayOrigin: "https://relay.example.org",
  routeId: "q3V0Yb6Hc8bE1pVmJx0T4d2Gf5aN9sK7wL1uR3yZ0cE",
});

const pinnedWithGrant: RelayPathRecord = {
  trust: { kind: "pinned" },
  grant,
  relayTurnedOff: false,
};

describe("remote path choice", () => {
  it("uses the direct private path whenever it connects, even with a grant", () => {
    expect(chooseRemotePath(pinnedWithGrant, { status: "connected" })).toEqual({ path: "direct" });
  });

  it("keeps waiting on the direct path for three seconds before considering the relay", () => {
    expect(DIRECT_PATH_CONNECT_TIMEOUT_MS).toBe(3_000);
    expect(chooseRemotePath(pinnedWithGrant, { status: "connecting", elapsedMs: 0 })).toEqual({
      path: "direct-pending",
      remainingMs: 3_000,
    });
    expect(chooseRemotePath(pinnedWithGrant, { status: "connecting", elapsedMs: 2_999 })).toEqual({
      path: "direct-pending",
      remainingMs: 1,
    });
  });

  it("falls back to the grant's relay once the direct path fails or runs out of time", () => {
    expect(chooseRemotePath(pinnedWithGrant, { status: "unreachable" })).toEqual({
      path: "relay",
      grant,
    });
    expect(chooseRemotePath(pinnedWithGrant, { status: "connecting", elapsedMs: 3_000 })).toEqual({
      path: "relay",
      grant,
    });
  });

  it("never uses a relay for an origin without pinned trust", () => {
    const record: RelayPathRecord = { ...pinnedWithGrant, trust: { kind: "platform" } };
    expect(chooseRemotePath(record, { status: "unreachable" })).toEqual({
      path: "none",
      reason: "no-pinned-trust",
    });
  });

  it("never uses a relay for an origin the host gave no grant", () => {
    const record: RelayPathRecord = { trust: { kind: "pinned" }, relayTurnedOff: false };
    expect(chooseRemotePath(record, { status: "unreachable" })).toEqual({
      path: "none",
      reason: "no-grant",
    });
  });

  it("never uses a relay the person turned off for that host on this device", () => {
    const record: RelayPathRecord = { ...pinnedWithGrant, relayTurnedOff: true };
    expect(chooseRemotePath(record, { status: "unreachable" })).toEqual({
      path: "none",
      reason: "relay-turned-off",
    });
  });

  it("does not fall back to the relay when the direct path reached a host that failed pinned trust", () => {
    expect(chooseRemotePath(pinnedWithGrant, { status: "trust-refused" })).toEqual({
      path: "none",
      reason: "direct-refused",
    });
  });
});
