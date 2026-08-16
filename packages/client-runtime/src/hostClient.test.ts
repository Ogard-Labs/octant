import { describe, expect, it, vi } from "vitest";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { createHostClient, HostClientFailure } from "./hostClient";

describe("HostClient", () => {
  it("loads the authoritative host observation", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        hosts: [
          {
            hostId: "local",
            displayName: "This Mac",
            health: "healthy",
            capabilities: ["chat", "work", "code"],
          },
        ],
      }),
    );
    const client = createHostClient({ baseUrl: "http://127.0.0.1:4310", fetch });

    await expect(client.list()).resolves.toEqual([
      expect.objectContaining({ hostId: LOCAL_HOST_ID, health: "healthy" }),
    ]);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4310/api/hosts", { method: "GET" });
  });

  it("rejects malformed host observations", async () => {
    const client = createHostClient({
      baseUrl: "http://127.0.0.1:4310",
      fetch: vi.fn(async () => Response.json({ hosts: [{ hostId: "local" }] })),
    });

    await expect(client.list()).rejects.toBeInstanceOf(HostClientFailure);
  });
});
