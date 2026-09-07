import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOfficialOpenCodeClient } from "./openCodeDriver";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("official OpenCode client routing", () => {
  it("routes the beta health request through its attested API prefix", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return new Response(JSON.stringify({ healthy: true, version: "0.0.0-beta-18721" }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode2 v0.0.0-beta-18721",
        url: new URL("http://127.0.0.1:41721/"),
      },
      "/tmp/project",
    );

    await expect(client.health()).resolves.toEqual({
      healthy: true,
      version: "opencode2 v0.0.0-beta-18721",
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/health");
    expect(requests[0]!.headers.get("authorization")).toBe("Basic redacted");
    expect(requests[0]!.headers.get("x-opencode-directory")).toBeNull();
  });

  it("keeps legacy health routing unchanged when no beta attestation exists", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return new Response(JSON.stringify({ healthy: true, version: "1.18.29" }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        url: new URL("http://127.0.0.1:41722/"),
      },
      "/tmp/project",
    );

    await expect(client.health()).resolves.toEqual({ healthy: true, version: "1.18.29" });
    expect(new URL(requests[0]!.url).pathname).toBe("/global/health");
  });

  it("refuses beta provider catalog access until the v2 model contract is mapped", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode2 v0.0.0-beta-18721",
        url: new URL("http://127.0.0.1:41724/"),
      },
      "/tmp/project",
    );

    await expect(client.providers()).rejects.toMatchObject({ category: "incompatible" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses beta session creation when the API cannot carry Octant permission rules", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode2 v0.0.0-beta-18721",
        url: new URL("http://127.0.0.1:41724/"),
      },
      "/tmp/project",
    );

    await expect(
      client.createSession({
        permission: [
          { permission: "*", pattern: "*", action: "ask" },
          { permission: "external_directory", pattern: "*", action: "deny" },
        ],
      }),
    ).rejects.toMatchObject({ category: "incompatible" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
