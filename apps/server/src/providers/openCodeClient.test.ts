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

  it("creates, reads, prompts, and interrupts a 2.x session without sending permission rules", async () => {
    const requests: Request[] = [];
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/api/event") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: "e1",
                      type: "session.next.text.delta",
                      data: {
                        sessionID: "ses_1",
                        delta: "hello",
                        assistantMessageID: "m",
                        textID: "t",
                      },
                    })}\n\n`,
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (request.method === "POST" && url.pathname === "/api/session/ses_1/interrupt") {
          return new Response(null, { status: 204 });
        }
        const sessionBody = {
          data: {
            id: "ses_1",
            projectID: "project",
            title: "turn",
            location: { directory: "/tmp/project" },
            model: { id: "gpt-5", providerID: "openai" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
          },
        };
        const body = url.pathname.startsWith("/api/session")
          ? sessionBody
          : { data: { id: "ses_1" } };
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
        url: new URL("http://127.0.0.1:41727/"),
      },
      "/tmp/project",
    );
    const permission = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ] as const;

    await expect(
      client.createSession({
        permission: [...permission],
        model: { providerId: "openai", modelId: "gpt-5" },
      }),
    ).resolves.toEqual({
      id: "ses_1",
      directory: "/tmp/project",
      model: { id: "gpt-5", providerID: "openai" },
    });
    await expect(client.getSession("ses_1")).resolves.toMatchObject({ id: "ses_1" });
    await client.prompt({
      sessionId: "ses_1",
      providerId: "openai",
      modelId: "gpt-5",
      prompt: "hello",
      permission: [...permission],
    });
    const controller = new AbortController();
    const events = await client.subscribe(controller.signal);
    const first = await events[Symbol.asyncIterator]().next();
    controller.abort();
    await client.abort("ses_1");

    expect(first.value).toMatchObject({
      type: "session.next.text.delta",
      properties: { delta: "hello", sessionID: "ses_1" },
    });
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/api/session"],
      ["GET", "/api/session/ses_1"],
      ["POST", "/api/session/ses_1/model"],
      ["POST", "/api/session/ses_1/prompt"],
      ["GET", "/api/event"],
      ["POST", "/api/session/ses_1/interrupt"],
    ]);
    expect(JSON.stringify(await requests[0]?.json())).not.toContain("permission");
    expect(await requests[2]?.json()).toEqual({
      model: { providerID: "openai", id: "gpt-5" },
    });
    expect(await requests[3]?.json()).toEqual({
      text: "hello",
      resume: true,
    });
    expect(
      requests.every((request) => request.headers.get("authorization") === "Basic redacted"),
    ).toBe(true);
  });

  it("replies to 2.x approvals with the decision body 2.0.22 requires and answers a question at its form", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        return new Response(null, { status: 204 });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.0.22",
        url: new URL("http://127.0.0.1:41728/"),
      },
      "/tmp/project",
    );

    await client.replyPermission("ses_1", "req-1", "once");
    await client.replyPermission("ses_1", "req-2", "reject");
    await client.replyQuestion("ses_1", "frm_1", ["Yes", "Later"]);

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/api/session/ses_1/permission/req-1/reply"],
      ["POST", "/api/session/ses_1/permission/req-2/reply"],
      ["POST", "/api/session/ses_1/form/frm_1/reply"],
    ]);
    // Each question is the form field keyed by its position.
    expect(await requests[2]?.json()).toEqual({ answer: { q0: "Yes", q1: "Later" } });
    // 2.0.22 answers the SDK's `{reply}` body with 400.
    expect(await requests[0]?.json()).toEqual({ decision: "once" });
    expect(await requests[1]?.json()).toEqual({ decision: "reject" });
    expect(requests[0]?.headers.get("x-opencode-directory")).toBe("%2Ftmp%2Fproject");
  });

  it("registers app-managed MCP servers through the 2.x runtime MCP route and waits until connected", async () => {
    const requests: Request[] = [];
    let listReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        const path = new URL(request.url).pathname;
        if (request.method === "PUT" && path === "/api/experimental/mcp/octant-bridge") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "GET" && path === "/api/mcp") {
          listReads += 1;
          // 2.0.22 answers the add with 204 while the server is still
          // pending; its tools join the session only once it is connected.
          const status = listReads < 2 ? "pending" : "connected";
          return Response.json({
            location: { directory: "/tmp/project" },
            data: [{ name: "octant-bridge", status: { status } }],
          });
        }
        if (request.method === "DELETE" && path === "/api/experimental/mcp/octant-bridge") {
          return new Response(null, { status: 204 });
        }
        // 2.0.22 serves its web UI on `/mcp` and answers `POST /mcp` with 405.
        return new Response(null, { status: 405 });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.0.22",
        url: new URL("http://127.0.0.1:41729/"),
      },
      "/tmp/project",
    );

    await client.addMcpServer({ name: "octant-bridge", url: "http://127.0.0.1:9999/mcp/token" });
    await client.disconnectMcpServer("octant-bridge");

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["PUT", "/api/experimental/mcp/octant-bridge"],
      ["GET", "/api/mcp"],
      ["GET", "/api/mcp"],
      ["DELETE", "/api/experimental/mcp/octant-bridge"],
    ]);
    // Code Mode would hide the bridge's tools behind OpenCode's own `execute`
    // tool; registering them directly keeps each call an `octant-*` action.
    expect(await requests[0]?.json()).toEqual({
      config: {
        type: "remote",
        url: "http://127.0.0.1:9999/mcp/token",
        oauth: false,
        codemode: false,
      },
    });
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Basic redacted");
      expect(request.headers.get("x-opencode-directory")).toBe("%2Ftmp%2Fproject");
      expect(new URL(request.url).searchParams.get("location[directory]")).toBe("/tmp/project");
    }
  });

  it("refuses a 2.x app-tool registration that OpenCode reports as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        if (request.method === "PUT") return new Response(null, { status: 204 });
        return Response.json({
          location: { directory: "/tmp/project" },
          data: [{ name: "octant-bridge", status: { status: "failed", error: "refused" } }],
        });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.0.22",
        url: new URL("http://127.0.0.1:41732/"),
      },
      "/tmp/project",
    );

    await expect(
      client.addMcpServer({ name: "octant-bridge", url: "http://127.0.0.1:9999/mcp/token" }),
    ).rejects.toThrow("did not connect");
  });

  it("deletes a 2.x session through the v2 session route", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        return new Response(null, { status: 204 });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.0.22",
        url: new URL("http://127.0.0.1:41731/"),
      },
      "/tmp/project",
    );
    await client.deleteSession("ses_1");
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["DELETE", "/api/session/ses_1"],
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe("Basic redacted");
    expect(requests[0]?.headers.get("x-opencode-directory")).toBe("%2Ftmp%2Fproject");
  });

  it("lists a folder's 2.x sessions, finds the message after a fork's anchor across pages, and forks before it", async () => {
    const requests: Request[] = [];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname === "/api/session")
          return json({
            data: [
              {
                id: "ses_person",
                title: "Fix the build",
                location: { directory: "/tmp/project" },
                time: { created: 1, updated: 1_700_000_000_000 },
              },
              {
                id: "ses_child",
                parentID: "ses_person",
                location: { directory: "/tmp/project" },
                time: { created: 1, updated: 2 },
              },
              { id: "ses_broken" },
            ],
            cursor: {},
          });
        if (url.pathname === "/api/session/ses_person/message")
          return url.searchParams.get("cursor") === null
            ? json({ data: [{ id: "msg_5" }, { id: "msg_4" }], cursor: { next: "page-2" } })
            : json({ data: [{ id: "msg_3" }, { id: "msg_2" }], cursor: {} });
        if (url.pathname === "/api/session/ses_person/fork")
          return json({ data: { id: "ses_fork", location: { directory: "/tmp/project" } } });
        return new Response(null, { status: 404 });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.2.0",
        url: new URL("http://127.0.0.1:41732/"),
      },
      "/tmp/project",
    );
    expect(await client.listSessions?.()).toEqual([
      {
        id: "ses_person",
        directory: "/tmp/project",
        title: "Fix the build",
        updated: 1_700_000_000_000,
      },
      { id: "ses_child", directory: "/tmp/project", updated: 2, parentId: "ses_person" },
    ]);
    expect(await client.messageAfter?.("ses_person", "msg_3")).toEqual({
      status: "found",
      next: "msg_4",
    });
    expect(await client.messageAfter?.("ses_person", "msg_5")).toEqual({ status: "found" });
    expect(await client.messageAfter?.("ses_person", "msg_gone")).toEqual({ status: "missing" });
    expect(await client.forkSession?.("ses_person", "msg_4")).toEqual({
      id: "ses_fork",
      directory: "/tmp/project",
    });
    const list = new URL(requests[0]?.url ?? "");
    expect([
      list.pathname,
      list.searchParams.get("directory"),
      list.searchParams.get("order"),
    ]).toEqual(["/api/session", "/tmp/project", "desc"]);
    const fork = requests.at(-1);
    expect([fork?.method, new URL(fork?.url ?? "").pathname]).toEqual([
      "POST",
      "/api/session/ses_person/fork",
    ]);
    expect(await fork?.json()).toEqual({ before: "msg_4" });
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Basic redacted");
      expect(request.headers.get("x-opencode-directory")).toBe("%2Ftmp%2Fproject");
    }
  });

  it("forks a 1.x session through its own fork route, before the named message", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        return new Response(
          JSON.stringify({
            id: "ses_fork",
            slug: "s",
            projectID: "p",
            directory: "/tmp/project",
            title: "t (fork #1)",
            version: "1",
            time: { created: 1, updated: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const client = makeOfficialOpenCodeClient(
      { authorization: "Basic redacted", pid: 1, url: new URL("http://127.0.0.1:41733/") },
      "/tmp/project",
    );
    expect(await client.forkSession?.("ses_source", "msg_3")).toMatchObject({
      id: "ses_fork",
      directory: "/tmp/project",
    });
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/session/ses_source/fork"],
    ]);
    expect(await requests[0]?.json()).toEqual({ messageID: "msg_3" });
  });

  it("sends a flat prompt body to the 2.x session prompt route", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        return new Response(JSON.stringify({ data: { id: "ses_1" } }), {
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
        url: new URL("http://127.0.0.1:41730/"),
      },
      "/tmp/project",
    );
    const permission = [{ permission: "*", pattern: "*", action: "ask" }] as const;
    await client.prompt({
      sessionId: "ses_1",
      providerId: "openai",
      modelId: "gpt-5",
      prompt: "hello",
      permission: [...permission],
    });
    const promptRequest = requests.find(
      (request) => new URL(request.url).pathname === "/api/session/ses_1/prompt",
    );
    expect(promptRequest).toBeDefined();
    // The body is flat `{text, resume}` — not the nested `{prompt:{text}, resume}`
    // the pinned SDK sends, which OpenCode 2.0.22 rejects with 400.
    expect(await promptRequest?.json()).toEqual({ text: "hello", resume: true });
    expect(promptRequest?.headers.get("authorization")).toBe("Basic redacted");
    expect(promptRequest?.headers.get("x-opencode-directory")).toBe("%2Ftmp%2Fproject");
  });

  it("lists OpenCode 2's own commands at the Project root and drops an entry it cannot send", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        // The `GET /api/command` answer as 2.2.0 shapes it: the location,
        // then `Command.Info` entries (`name`, optional `description`).
        return new Response(
          JSON.stringify({
            location: { directory: "/tmp/project" },
            data: [
              { name: "init", description: "guided AGENTS.md setup" },
              {
                name: "review",
                description: "review changes [commit|branch|pr], defaults to uncommitted",
              },
              { name: "docs:summarize" },
              { name: "two words", description: "not sendable as /name" },
              { description: "no name" },
              "init",
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.2.0",
        url: new URL("http://127.0.0.1:41732/"),
      },
      "/tmp/project",
    );
    await expect(client.commands?.()).resolves.toEqual([
      { name: "init", description: "guided AGENTS.md setup" },
      { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
      { name: "docs:summarize" },
    ]);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/command");
    expect(url.searchParams.get("location[directory]")).toBe("/tmp/project");
    expect(requests[0]?.headers.get("authorization")).toBe("Basic redacted");
  });

  it("refuses a command list larger than Octant reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ name: "init", description: "x".repeat(300_000) }] }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.2.0",
        url: new URL("http://127.0.0.1:41733/"),
      },
      "/tmp/project",
    );
    await expect(client.commands?.()).rejects.toThrow("more commands than Octant reads");
  });

  it("runs a chosen OpenCode 2 command through its command route after admitting the turn's context", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push(request.clone());
        return new URL(request.url).pathname.endsWith("/command")
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ data: {} }), {
              headers: { "content-type": "application/json" },
            });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.2.0",
        url: new URL("http://127.0.0.1:41734/"),
      },
      "/tmp/project",
    );
    await client.command?.({
      sessionId: "ses_1",
      providerId: "openai",
      modelId: "gpt-5",
      name: "review",
      arguments: "main",
      context: "<octant-context>standing</octant-context>",
    });
    const sent = requests.filter((request) => request.method === "POST");
    expect(sent.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/session/ses_1/model",
      "/api/session/ses_1/prompt",
      "/api/session/ses_1/command",
    ]);
    expect(await sent[1]?.json()).toEqual({
      text: "<octant-context>standing</octant-context>",
      resume: false,
    });
    expect(await sent[2]?.json()).toEqual({ name: "review", text: "main" });
    expect(sent[2]?.headers.get("x-opencode-directory")).toBe("%2Ftmp%2Fproject");
  });

  it("says a turn's context was left queued when the command route fails after admitting it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        return new URL(request.url).pathname.endsWith("/command")
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify({ data: {} }), {
              headers: { "content-type": "application/json" },
            });
      }),
    );
    const client = makeOfficialOpenCodeClient(
      {
        authorization: "Basic redacted",
        pid: 1,
        runtime: "beta",
        version: "opencode v2.2.0",
        url: new URL("http://127.0.0.1:41734/"),
      },
      "/tmp/project",
    );
    const run = (context?: string) =>
      client.command?.({
        sessionId: "ses_1",
        providerId: "openai",
        modelId: "gpt-5",
        name: "review",
        arguments: "main",
        ...(context === undefined ? {} : { context }),
      });
    await expect(run("<octant-context>standing</octant-context>")).rejects.toMatchObject({
      contextAdmitted: true,
    });
    await expect(run()).rejects.toMatchObject({ contextAdmitted: false });
  });

  it("offers no command route on a 1.x runtime, whose route answers only after the run ends", () => {
    const client = makeOfficialOpenCodeClient(
      { authorization: "Basic redacted", pid: 1, url: new URL("http://127.0.0.1:41735/") },
      "/tmp/project",
    );
    expect(client.commands).toBeUndefined();
    expect(client.command).toBeUndefined();
  });
});
