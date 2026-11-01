import { describe, expect, it, vi } from "vitest";
import { createShieldServersClient } from "./shieldServersClient";

const projectId = "8a3f6d4e-1c2b-4a5d-9e8f-7a6b5c4d3e2f";
const view = {
  servers: [],
  project: { projectId, override: null },
  sshAgent: "available",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("shield servers client", () => {
  it("reads a Project's view by asking for that Project", async () => {
    const fetch = vi.fn(async () => json({ view }));
    const client = createShieldServersClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch,
      windowCapability: "capability",
    });

    await expect(client.read(projectId)).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:4100/api/shield/servers?projectId=${projectId}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads the account list without a Project in the address", async () => {
    const fetch = vi.fn(async () => json({ view: { servers: [], sshAgent: "available" } }));
    const client = createShieldServersClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch,
      windowCapability: "capability",
    });

    await client.read();

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/api/shield/servers",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
