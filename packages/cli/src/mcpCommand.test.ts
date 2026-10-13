import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { NO_BROWSER_GRANT_MESSAGE, resolveBrowserGrant, runMcpCommand } from "./mcpCommand";

const TOKEN = "grant-token-0123456789-abcdefghijklmnop";
const SECRET_PATH = "/mcp/secret-path-segment-xyz";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type StandInReply = (request: SeenRequest, response: ServerResponse) => void;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A loopback endpoint that records what it was sent and answers as the script says. */
async function standIn(reply: StandInReply) {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      };
      seen.push(entry);
      reply(entry, response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  closers.push(close);
  return {
    seen,
    port,
    environment: {
      OCTANT_BROWSER_MCP_URL: `http://127.0.0.1:${port}${SECRET_PATH}`,
      OCTANT_BROWSER_MCP_TOKEN: TOKEN,
    },
    close,
  };
}

function sendJson(response: ServerResponse, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(200, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sendEvents(response: ServerResponse, ...bodies: unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const body of bodies) response.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  response.end();
}

const BROWSER_TOOL = {
  name: "octant_browser",
  description: "Drive the thread's Browser.",
  inputSchema: { type: "object" },
};

/** An endpoint shaped like the real one: JSON for the handshake, events for tool traffic. */
const browserEndpoint: StandInReply = (request, response) => {
  if (request.method === "DELETE") {
    response.writeHead(200).end();
    return;
  }
  const message = JSON.parse(request.body) as { id?: number; method?: string };
  if (message.method === "initialize") {
    sendJson(
      response,
      { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
      { "mcp-session-id": "session-1" },
    );
  } else if (message.id === undefined) {
    response.writeHead(202).end();
  } else if (message.method === "tools/list") {
    sendEvents(response, { jsonrpc: "2.0", id: message.id, result: { tools: [BROWSER_TOOL] } });
  } else {
    sendEvents(
      response,
      { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
      {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: '{"ok":true}' }], isError: false },
      },
    );
  }
};

function request(id: number | undefined, method: string, params: unknown = {}) {
  return `${JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params })}\n`;
}

const HANDSHAKE = request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "typed-cli", version: "1" },
});

async function run(
  environment: Readonly<Record<string, string | undefined>>,
  input: ReadonlyArray<string> | PassThrough,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runMcpCommand({
    environment,
    input: Array.isArray(input)
      ? (async function* () {
          yield* input;
        })()
      : (input as PassThrough),
    stdout: { write: (chunk) => stdout.push(chunk) },
    stderr: { write: (chunk) => stderr.push(chunk) },
  });
  const frames = stdout
    .join("")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
  return { code, frames, stdout: stdout.join(""), stderr: stderr.join("") };
}

function expectNoSecrets(output: { readonly stdout: string; readonly stderr: string }) {
  for (const text of [output.stdout, output.stderr]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("127.0.0.1");
  }
}

/** Some sandboxes forbid loopback listeners; the tests that need one are skipped there. */
const loopbackAvailable = await standIn(() => undefined).then(
  async (probe) => {
    await probe.close();
    return true;
  },
  () => false,
);

describe("octant mcp without a Browser grant", () => {
  it.skipIf(!loopbackAvailable)(
    "answers the handshake with no tools and says why on stderr",
    async () => {
      const endpoint = await standIn(browserEndpoint);

      const output = await run({}, [
        HANDSHAKE,
        request(undefined, "notifications/initialized"),
        request(2, "tools/list"),
        request(3, "tools/call", { name: "octant_browser", arguments: {} }),
      ]);

      expect(output.code).toBe(1);
      expect(output.frames[0]).toMatchObject({
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          instructions: NO_BROWSER_GRANT_MESSAGE,
        },
      });
      expect(output.frames[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      expect(output.frames[2]).toMatchObject({ id: 3, result: { isError: true } });
      expect(output.stderr).toContain("This terminal has no Browser grant");
      expect(output.stderr).toContain("switched on for one thread terminal");
      expect(endpoint.seen).toEqual([]);
    },
  );

  it.each([
    ["the address is missing", { OCTANT_BROWSER_MCP_TOKEN: TOKEN }],
    ["the token is missing", { OCTANT_BROWSER_MCP_URL: `http://127.0.0.1:1${SECRET_PATH}` }],
    ["both are empty", { OCTANT_BROWSER_MCP_URL: "", OCTANT_BROWSER_MCP_TOKEN: "  " }],
  ])("lists no tools when %s", async (_name, environment) => {
    const output = await run(environment, [HANDSHAKE, request(2, "tools/list")]);

    expect(output.frames[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(output.stderr).toContain("no Browser grant");
    expectNoSecrets(output);
  });

  it.skipIf(!loopbackAvailable).each([
    [
      "a name that resolves to loopback",
      (port: number) => `http://localhost:${port}${SECRET_PATH}`,
    ],
    ["a secure scheme", (port: number) => `https://127.0.0.1:${port}${SECRET_PATH}`],
    [
      "a credential that names another host",
      (port: number) => `http://127.0.0.1:${port}@example.test:80${SECRET_PATH}`,
    ],
    ["another loopback address", (port: number) => `http://127.0.0.2:${port}${SECRET_PATH}`],
    ["a private network address", (port: number) => `http://10.0.0.5:${port}${SECRET_PATH}`],
    ["an address without a port", () => `http://127.0.0.1${SECRET_PATH}`],
    ["an address without a path", (port: number) => `http://127.0.0.1:${port}/`],
    ["something that is not an address", () => "not an address"],
  ])("never sends the token to %s", async (_name, address) => {
    const endpoint = await standIn(browserEndpoint);

    const output = await run(
      { OCTANT_BROWSER_MCP_URL: address(endpoint.port), OCTANT_BROWSER_MCP_TOKEN: TOKEN },
      [HANDSHAKE, request(2, "tools/list")],
    );

    expect(endpoint.seen).toEqual([]);
    expect(output.frames[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(output.code).toBe(1);
    expectNoSecrets(output);
  });

  it("resolves only a plain loopback address with a port and a path", () => {
    expect(
      resolveBrowserGrant({
        OCTANT_BROWSER_MCP_URL: `http://127.0.0.1:4100${SECRET_PATH}`,
        OCTANT_BROWSER_MCP_TOKEN: TOKEN,
      }),
    ).toMatchObject({ kind: "granted", endpoint: { port: 4100, path: SECRET_PATH } });
  });
});

describe.skipIf(!loopbackAvailable)("octant mcp with a Browser grant", () => {
  it("lists the host's tools and relays a call with the bearer token and the protocol the endpoint expects", async () => {
    const endpoint = await standIn(browserEndpoint);

    const output = await run(endpoint.environment, [
      HANDSHAKE,
      request(undefined, "notifications/initialized"),
      request(2, "tools/list"),
      request(3, "tools/call", { name: "octant_browser", arguments: { operation: "help" } }),
    ]);

    expect(output.code).toBe(0);
    expect(output.frames.find((frame) => frame["id"] === 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [BROWSER_TOOL] },
    });
    expect(
      output.frames.find((frame) => frame["method"] === "notifications/progress"),
    ).toBeDefined();
    expect(output.frames.find((frame) => frame["id"] === 3)).toMatchObject({
      result: { isError: false },
    });
    const posts = endpoint.seen.filter((seen) => seen.method === "POST");
    expect(posts.map((seen) => JSON.parse(seen.body).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    for (const seen of posts) {
      expect(seen.url).toBe(SECRET_PATH);
      expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen.headers.host).toBe(`127.0.0.1:${endpoint.port}`);
      expect(seen.headers.origin).toBeUndefined();
      expect(seen.headers.accept).toBe("application/json, text/event-stream");
    }
    expect(posts[0]?.headers["mcp-session-id"]).toBeUndefined();
    expect(posts[2]?.headers["mcp-session-id"]).toBe("session-1");
    expect(posts[2]?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(JSON.parse(posts[3]?.body ?? "{}").params).toEqual({
      name: "octant_browser",
      arguments: { operation: "help" },
    });
    expectNoSecrets(output);
  });

  it("releases its session on the endpoint when the caller is done", async () => {
    const endpoint = await standIn(browserEndpoint);

    await run(endpoint.environment, [HANDSHAKE]);

    const last = endpoint.seen.at(-1);
    expect(last?.method).toBe("DELETE");
    expect(last?.headers["mcp-session-id"]).toBe("session-1");
    expect(last?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("answers a line that is not a message without ending the session", async () => {
    const endpoint = await standIn(browserEndpoint);

    const output = await run(endpoint.environment, [
      HANDSHAKE,
      "not json\n",
      request(2, "tools/list"),
    ]);

    expect(output.frames.map((frame) => frame["id"])).toEqual([1, null, 2]);
    expect(output.frames[1]).toMatchObject({ error: { code: -32700 } });
    expect(endpoint.seen.filter((seen) => seen.method === "POST")).toHaveLength(2);
  });

  it("ends the command when the host answers a call unauthorized", async () => {
    const endpoint = await standIn((seen, response) => {
      const message = JSON.parse(seen.body || "{}") as { id?: number; method?: string };
      if (message.method === "tools/call") {
        sendEvents(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: '{"error":"unauthorized"}' }], isError: true },
        });
        return;
      }
      browserEndpoint(seen, response);
    });
    const input = new PassThrough();
    const finished = run(endpoint.environment, input);

    input.write(HANDSHAKE);
    input.write(request(2, "tools/call", { name: "octant_browser", arguments: {} }));
    const output = await finished;
    input.write(request(3, "tools/list"));

    expect(output.code).toBe(1);
    expect(output.frames.at(-1)).toMatchObject({
      id: 2,
      result: { isError: true, content: [{ text: '{"error":"unauthorized"}' }] },
    });
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    expect(output.stderr).toContain("ended this terminal's Browser grant");
    expect(endpoint.seen.filter((seen) => seen.body.includes("tools/list"))).toEqual([]);
    expectNoSecrets(output);
  });

  it.each([404, 401])("treats an HTTP %s from the host as the grant being over", async (status) => {
    const endpoint = await standIn((seen, response) => {
      if (seen.body.includes("tools/call")) {
        response.writeHead(status).end();
        return;
      }
      browserEndpoint(seen, response);
    });

    const output = await run(endpoint.environment, [
      HANDSHAKE,
      request(2, "tools/call", { name: "octant_browser", arguments: {} }),
    ]);

    expect(output.code).toBe(1);
    expect(output.frames.at(-1)).toMatchObject({
      id: 2,
      result: { isError: true, content: [{ text: '{"error":"unauthorized"}' }] },
    });
    expect(output.stderr).toContain("ended this terminal's Browser grant");
    expectNoSecrets(output);
  });

  it("treats a host that stopped listening as the grant being over, once", async () => {
    const endpoint = await standIn(browserEndpoint);
    const input = new PassThrough();
    const finished = run(endpoint.environment, input);
    input.write(HANDSHAKE);
    // The handshake is answered before the endpoint goes away, as when the person switches the grant off.
    for (let attempt = 0; attempt < 200 && endpoint.seen.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await endpoint.close();
    input.write(request(2, "tools/call", { name: "octant_browser", arguments: {} }));
    input.write(request(3, "tools/list"));

    const output = await finished;

    expect(output.code).toBe(1);
    expect(output.frames.find((frame) => frame["id"] === 2)).toMatchObject({
      result: { isError: true, content: [{ text: '{"error":"unauthorized"}' }] },
    });
    expect(output.stderr.trim().split("\n")).toHaveLength(1);
    expect(output.stderr).toContain("no longer answering");
    expectNoSecrets(output);
  });

  it("answers a request the host could not take without ending the session", async () => {
    const endpoint = await standIn((seen, response) => {
      if (seen.body.includes("tools/list")) {
        response.writeHead(500).end();
        return;
      }
      browserEndpoint(seen, response);
    });

    const output = await run(endpoint.environment, [
      HANDSHAKE,
      request(2, "tools/list"),
      request(3, "tools/call", { name: "octant_browser", arguments: {} }),
    ]);

    expect(output.code).toBe(0);
    expect(output.frames.find((frame) => frame["id"] === 2)).toMatchObject({
      error: { code: -32603 },
    });
    expect(output.frames.find((frame) => frame["id"] === 3)).toMatchObject({
      result: { isError: false },
    });
  });
});
