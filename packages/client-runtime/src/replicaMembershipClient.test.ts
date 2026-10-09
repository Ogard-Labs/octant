import { describe, expect, it, vi } from "vitest";
import {
  ReplicaMembershipClientFailure,
  createReplicaMembershipClient,
} from "./replicaMembershipClient";
import { createReplicaSyncStatusClient } from "./replicaSyncStatusClient";

const status = {
  lastPublish: { kind: "not-available" },
  lastPull: { kind: "not-available" },
  queued: { kind: "not-available" },
};
const view = {
  kind: "replica-membership-view",
  computerName: "Studio Mac",
  thisComputer: { kind: "none" },
  members: [],
  joinRequests: [],
  status,
};

describe("replica membership client", () => {
  it("refuses a host that is not this machine", () => {
    expect(() =>
      createReplicaMembershipClient({
        baseUrl: "https://octant.example",
        fetch: vi.fn(),
        windowCapability: "capability",
      }),
    ).toThrow(ReplicaMembershipClientFailure);
  });

  it("reads membership with the window capability", async () => {
    const fetch = vi.fn(async () => Response.json(view));
    const client = createReplicaMembershipClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "capability",
    });
    expect(await client.read()).toEqual(view);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:13773/api/replica-membership/state", {
      method: "GET",
      headers: { "x-octant-window-capability": "capability" },
    });
  });

  it("surfaces the host's refusal message", async () => {
    const client = createReplicaMembershipClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        Response.json({ message: "Replica membership is host-only." }, { status: 403 }),
      ),
      windowCapability: "capability",
    });
    await expect(client.execute({ kind: "pull" })).rejects.toThrow(
      "Replica membership is host-only.",
    );
  });
});

describe("replica sync status client", () => {
  it("reads status from a remote host and says when it is refused", async () => {
    const ready = createReplicaSyncStatusClient({
      baseUrl: "https://octant.example",
      fetch: vi.fn(async () =>
        Response.json({ kind: "replica-sync-status", thisComputer: "none", members: [], status }),
      ),
    });
    expect(await ready.read()).toMatchObject({ status: "ready" });
    const refused = createReplicaSyncStatusClient({
      baseUrl: "https://octant.example",
      fetch: vi.fn(async () => Response.json({ message: "no" }, { status: 403 })),
    });
    expect(await refused.read()).toEqual({ status: "refused" });
  });
});
