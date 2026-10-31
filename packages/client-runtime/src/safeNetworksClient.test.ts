import { describe, expect, it, vi } from "vitest";
import { createSafeNetworksClient, SafeNetworksClientFailure } from "./safeNetworksClient";

const projectId = "8a3f6d4e-1c2b-4a5d-9e8f-7a6b5c4d3e2f";
const view = {
  account: [{ kind: "private-network", tag: "local-network" }],
  project: { projectId, override: null },
  refused: [
    {
      host: "registry.npmjs.org",
      port: 443,
      runtime: "codex",
      requests: 2,
      lastRefusedAt: "2026-10-31T12:00:00.000Z",
    },
  ],
  enforced: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("safe networks client", () => {
  it("reads a Project's view with the window's capability", async () => {
    const fetch = vi.fn(async () => json({ view }));
    const client = createSafeNetworksClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch,
      windowCapability: "capability",
    });
    await expect(client.read(projectId)).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:4100/api/access/safe-networks?projectId=${projectId}`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-octant-window-capability": "capability" }),
      }),
    );
  });

  it("returns a refused change as a value and throws for an unauthorized one", async () => {
    const refusal = {
      kind: "safe-networks-refused",
      reason: "covers-link-local",
      message: "That range reaches link-local addresses.",
      placeIndex: 0,
    };
    const client = createSafeNetworksClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: vi
        .fn()
        .mockResolvedValueOnce(json(refusal, 409))
        .mockResolvedValueOnce(json({ error: "Safe network request is unauthorized." }, 401)),
      windowCapability: "capability",
    });
    const command = {
      kind: "set-places",
      scope: { kind: "account" },
      places: [{ kind: "range", range: "169.254.0.0/16" }],
    } as const;
    await expect(client.command(command)).resolves.toEqual(refusal);
    await expect(client.command(command)).rejects.toBeInstanceOf(SafeNetworksClientFailure);
  });
});
