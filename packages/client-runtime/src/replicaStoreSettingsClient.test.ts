import { describe, expect, it, vi } from "vitest";
import {
  ReplicaStoreSettingsClientFailure,
  createReplicaStoreSettingsClient,
} from "./replicaStoreSettingsClient";

const view = {
  kind: "replica-store-settings-view",
  store: { kind: "none" },
  syncOn: false,
  version: 0,
  hostId: "local",
  mode: "work",
  credentialStore: "available",
};

describe("replica store settings client", () => {
  it("refuses a host that is not this machine", () => {
    expect(() =>
      createReplicaStoreSettingsClient({
        baseUrl: "https://octant.example",
        fetch: vi.fn(),
        windowCapability: "capability",
      }),
    ).toThrow(ReplicaStoreSettingsClientFailure);
  });

  it("reads the sync settings with the window capability", async () => {
    const fetch = vi.fn(async () => Response.json(view));
    const client = createReplicaStoreSettingsClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "capability",
    });

    expect(await client.read()).toEqual(view);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:13773/api/replica-store/settings", {
      method: "GET",
      headers: { "x-octant-window-capability": "capability" },
    });
  });

  it("surfaces the host's refusal message", async () => {
    const client = createReplicaStoreSettingsClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        Response.json({ message: "Sync settings are host-only." }, { status: 403 }),
      ),
      windowCapability: "capability",
    });

    await expect(client.execute({ schemaVersion: 1, kind: "test-connection" })).rejects.toThrow(
      "Sync settings are host-only.",
    );
  });
});
