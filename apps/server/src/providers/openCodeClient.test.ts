import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOfficialOpenCodeClient } from "./openCodeDriver";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("official OpenCode client routing", () => {
  it("preserves the complete session policy without the deprecated prompt tools field", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        return new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      { authorization: "Basic redacted", pid: 1, url: new URL("http://127.0.0.1:41722/") },
      "/tmp/project",
    );
    const permission = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "*_*", pattern: "*", action: "deny" },
      { permission: "octant-owned_*", pattern: "*", action: "allow" },
    ] as const;
    await client.prompt({
      sessionId: "session-1",
      providerId: "provider",
      modelId: "model",
      prompt: "hello",
      permission: [...permission],
    });
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["PATCH", "/session/session-1"],
      ["POST", "/session/session-1/prompt_async"],
    ]);
    expect(await requests[0]?.json()).toEqual({ permission });
    expect(await requests[1]?.json()).not.toHaveProperty("tools");
  });

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

  it("lists beta providers and models from the recorded v2 catalogue", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        const url = new URL(request.url);
        const body =
          url.pathname === "/api/provider"
            ? {
                location: { directory: "/tmp/project" },
                data: [{ id: "openai", name: "OpenAI", activation: "enabled" }],
              }
            : {
                location: { directory: "/tmp/project" },
                data: [
                  {
                    id: "gpt-5",
                    providerID: "openai",
                    name: "GPT-5",
                    capabilities: {
                      tools: true,
                      input: ["text", "image"],
                      output: ["text", "reasoning"],
                    },
                    status: "active",
                    enabled: true,
                    limit: { context: 100_000, output: 8_000 },
                  },
                ],
              };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.0.22",
        url: new URL("http://127.0.0.1:41724/"),
      },
      "/tmp/project",
    );

    await expect(client.providers()).resolves.toMatchObject({
      connected: ["openai"],
      all: [
        {
          id: "openai",
          models: {
            "gpt-5": {
              id: "gpt-5",
              name: "GPT-5",
              capabilities: { reasoning: true, input: { text: true, image: true } },
              limit: { context: 100_000 },
            },
          },
        },
      ],
    });
    expect(requests.map((request) => new URL(request.url).pathname).sort()).toEqual([
      "/api/model",
      "/api/provider",
    ]);
    expect(
      requests.every((request) => request.headers.get("authorization") === "Basic redacted"),
    ).toBe(true);
    expect(JSON.stringify(await client.providers())).not.toContain("private");
  });

  it("lists models when the 2.x provider route is empty and skips a disabled provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        const body =
          url.pathname === "/api/provider"
            ? {
                location: { directory: "/tmp/project" },
                data: [{ id: "hidden", name: "Hidden", activation: "disabled" }],
              }
            : {
                location: { directory: "/tmp/project" },
                data: [
                  {
                    id: "visible",
                    providerID: "openai",
                    name: "Visible",
                    capabilities: { tools: false, input: ["text"], output: ["text"] },
                    enabled: true,
                    limit: { context: 8_000, output: 1_000 },
                  },
                  {
                    id: "secret",
                    providerID: "hidden",
                    name: "Secret",
                    capabilities: { tools: false, input: ["text"], output: ["text"] },
                    enabled: true,
                    limit: { context: 8_000, output: 1_000 },
                  },
                ],
              };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.0.22",
        url: new URL("http://127.0.0.1:41725/"),
      },
      "/tmp/project",
    );
    await expect(client.providers()).resolves.toMatchObject({
      connected: ["openai"],
      all: [{ id: "openai", models: { visible: { name: "Visible" } } }],
    });
  });

  it("waits for the 2.x catalogue when the first read is empty", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        const ready = reads >= 2;
        if (url.pathname === "/api/model") reads += 1;
        const body = ready
          ? {
              location: { directory: "/tmp/project" },
              data:
                url.pathname === "/api/provider"
                  ? [{ id: "openai", name: "OpenAI", activation: "enabled" }]
                  : [
                      {
                        id: "gpt-5",
                        providerID: "openai",
                        name: "GPT-5",
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        enabled: true,
                        limit: { context: 8_000, output: 1_000 },
                      },
                    ],
            }
          : { location: { directory: "/tmp/project" }, data: [] };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.0.22",
        url: new URL("http://127.0.0.1:41726/"),
      },
      "/tmp/project",
    );
    await expect(client.providers()).resolves.toMatchObject({ connected: ["openai"] });
    expect(reads).toBeGreaterThan(1);
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
