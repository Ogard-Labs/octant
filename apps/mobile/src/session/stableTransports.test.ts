import { describe, expect, it } from "vitest";
import type { RemoteSessionBridgeState } from "@octant/client-runtime";
import { createStableTransports, type TransportSlot } from "./stableTransports";

const ready: RemoteSessionBridgeState = { kind: "ready", hostId: "h", displayName: "Host" };
const stale: RemoteSessionBridgeState = { kind: "idle" };

function connection() {
  return { authenticatedFetch: async () => new Response("ok") };
}

function slot(
  hostId: string,
  state: RemoteSessionBridgeState,
  live: ReturnType<typeof connection> | undefined,
): TransportSlot {
  return { registration: { hostId }, bridge: { connection: () => live }, state };
}

describe("stable transports", () => {
  it("keeps the same transports array across emits with unchanged connections", () => {
    const build = createStableTransports();
    const a = connection();
    const first = build([slot("a", ready, a)]);
    const second = build([slot("a", ready, a)]);

    expect(first).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("returns a new array when a host connection is replaced", () => {
    const build = createStableTransports();
    const first = build([slot("a", ready, connection())]);
    const second = build([slot("a", ready, connection())]);

    expect(second).not.toBe(first);
  });

  it("returns a new array when a host stops being usable and when it returns", () => {
    const build = createStableTransports();
    const a = connection();
    const first = build([slot("a", ready, a)]);
    const gone = build([slot("a", stale, a)]);
    const back = build([slot("a", ready, a)]);

    expect(gone).toHaveLength(0);
    expect(back).not.toBe(first);
  });

  it("keeps an untouched host's transport when another host changes", () => {
    const build = createStableTransports();
    const a = connection();
    const first = build([slot("a", ready, a), slot("b", ready, connection())]);
    const second = build([slot("a", ready, a), slot("b", ready, connection())]);

    expect(second[0]).toBe(first[0]);
    expect(second).not.toBe(first);
  });
});
