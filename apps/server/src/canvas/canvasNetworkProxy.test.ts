import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { decodeCanvasId } from "@octant/contracts/canvas";
import {
  CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS,
  CANVAS_NETWORK_MAX_REQUESTS_PER_MINUTE,
  CANVAS_NETWORK_MAX_RESPONSE_BYTES,
  canvasNetworkAddressRefusal,
  type CanvasNetworkReserved,
} from "@octant/domain/canvas-network-policy";
import { afterEach, describe, expect, it } from "vitest";
import {
  CanvasNetworkProxy,
  canvasNetworkProxyResponse,
  pinnedCanvasNetworkConnect,
  type CanvasNetworkConnect,
} from "./canvasNetworkProxy";

const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const otherCanvasId = decodeCanvasId("22222222-2222-4222-8222-222222222222");
const nothingReserved: CanvasNetworkReserved = { addresses: [], hosts: [] };
const PUBLIC = "93.184.216.34";

const text = (body: Uint8Array) => new TextDecoder().decode(body);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

interface Connection {
  readonly url: string;
  readonly addresses: ReadonlyArray<string>;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly body?: string;
}

/** A proxy over a scripted resolver and a transport that records what it was handed. */
function proxyOver(input: {
  readonly resolve?: (hostname: string) => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  readonly respond?: (url: URL, signal: AbortSignal) => Response | Promise<Response>;
  readonly reserved?: CanvasNetworkReserved;
  readonly now?: () => number;
  readonly totalTimeMs?: number;
}) {
  const connections: Connection[] = [];
  const resolved: string[] = [];
  const connect: CanvasNetworkConnect = async (url, connection) => {
    connections.push({
      url: url.toString(),
      addresses: connection.addresses,
      headers: connection.headers,
      method: connection.method,
      ...(connection.body === undefined ? {} : { body: text(connection.body) }),
    });
    return (
      (await input.respond?.(url, connection.signal)) ??
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
    );
  };
  const proxy = new CanvasNetworkProxy({
    reserved: () => input.reserved ?? nothingReserved,
    resolveAll: async (hostname) => {
      resolved.push(hostname);
      return (await input.resolve?.(hostname)) ?? [PUBLIC];
    },
    connect,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.totalTimeMs === undefined ? {} : { totalTimeMs: input.totalTimeMs }),
  });
  return { proxy, connections, resolved };
}

describe("Canvas network proxy", () => {
  it("fetches a public address and hands back its status, type, and body", async () => {
    const { proxy, connections, resolved } = proxyOver({});
    const outcome = await proxy.fetch(canvasId, "https://api.example.com/data?x=1");
    expect(outcome).toMatchObject({
      status: "fetched",
      httpStatus: 200,
      contentType: "text/plain",
    });
    expect(outcome.status === "fetched" && text(outcome.body)).toBe("hello");
    expect(resolved).toEqual(["api.example.com"]);
    expect(connections).toEqual([
      {
        url: "https://api.example.com/data?x=1",
        addresses: [PUBLIC],
        headers: { accept: "*/*" },
        method: "GET",
      },
    ]);
  });

  it("connects to the addresses it judged and resolves the name once for a connection", async () => {
    const answers = [[PUBLIC], ["127.0.0.1"]];
    const { proxy, connections, resolved } = proxyOver({
      resolve: () => answers.shift() ?? ["127.0.0.1"],
    });
    await expect(proxy.fetch(canvasId, "http://rebinding.example.com/")).resolves.toMatchObject({
      status: "fetched",
    });
    // The transport was handed the judged address; the name was not looked up again for it.
    expect(resolved).toEqual(["rebinding.example.com"]);
    expect(connections.map((connection) => connection.addresses)).toEqual([[PUBLIC]]);
  });

  it("refuses a name that answers public and then private, without connecting", async () => {
    const answers = [[PUBLIC], ["127.0.0.1"]];
    const { proxy, connections } = proxyOver({ resolve: () => answers.shift() ?? ["127.0.0.1"] });
    await proxy.fetch(canvasId, "http://rebinding.example.com/");
    await expect(proxy.fetch(canvasId, "http://rebinding.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "private-address",
    });
    expect(connections).toHaveLength(1);
  });

  it("refuses a name when any address it resolves to is private", async () => {
    const { proxy, connections } = proxyOver({ resolve: () => [PUBLIC, "10.0.0.8"] });
    await expect(proxy.fetch(canvasId, "https://mixed.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "private-address",
    });
    expect(connections).toEqual([]);
  });

  it("refuses a name that resolves to nothing", async () => {
    const { proxy } = proxyOver({ resolve: () => [] });
    await expect(proxy.fetch(canvasId, "https://nowhere.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "unresolvable",
    });
  });

  it("refuses one of this machine's own addresses although it is public", async () => {
    const { proxy, connections } = proxyOver({
      reserved: { addresses: [PUBLIC], hosts: [] },
    });
    await expect(proxy.fetch(canvasId, "https://my-own-name.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "octant-address",
    });
    expect(connections).toEqual([]);
  });

  it.each([
    ["a private address", "http://10.0.0.5/admin"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback by name", "http://localhost/admin"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["another port", "http://public.example.com:8080/"],
    ["another scheme", "ftp://public.example.com/"],
  ])("refuses a redirect from a public host to %s", async (_label, location) => {
    const { proxy, connections } = proxyOver({
      respond: () => new Response(null, { status: 302, headers: { location } }),
    });
    const outcome = await proxy.fetch(canvasId, "https://public.example.com/start");
    expect(outcome.status).toBe("refused");
    expect(connections).toHaveLength(1);
  });

  it("refuses a redirect to a name that resolves to a private address", async () => {
    const { proxy, connections, resolved } = proxyOver({
      resolve: (hostname) => (hostname === "internal.example.com" ? ["192.168.1.10"] : [PUBLIC]),
      respond: () =>
        new Response(null, { status: 307, headers: { location: "https://internal.example.com/" } }),
    });
    await expect(proxy.fetch(canvasId, "https://public.example.com/start")).resolves.toEqual({
      status: "refused",
      reason: "private-address",
    });
    expect(resolved).toEqual(["public.example.com", "internal.example.com"]);
    expect(connections).toHaveLength(1);
  });

  it("follows a redirect that stays public, and stops after five", async () => {
    const followed = proxyOver({
      respond: (url) =>
        url.pathname === "/final"
          ? new Response("landed", { status: 200 })
          : new Response(null, { status: 301, headers: { location: "/final" } }),
    });
    const outcome = await followed.proxy.fetch(canvasId, "https://public.example.com/start");
    expect(outcome.status === "fetched" && text(outcome.body)).toBe("landed");
    expect(followed.resolved).toEqual(["public.example.com", "public.example.com"]);

    const looping = proxyOver({
      respond: () => new Response(null, { status: 302, headers: { location: "/again" } }),
    });
    await expect(looping.proxy.fetch(canvasId, "https://public.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "too-many-redirects",
    });
    expect(looping.connections).toHaveLength(6);
  });

  it("sends nothing but Accept, on the first request and on a redirect", async () => {
    const { proxy, connections } = proxyOver({
      respond: (url) =>
        url.pathname === "/final"
          ? new Response("ok")
          : new Response(null, { status: 302, headers: { location: "/final" } }),
    });
    await proxy.fetch(canvasId, "https://public.example.com/start");
    expect(connections.map((connection) => [connection.method, connection.headers])).toEqual([
      ["GET", { accept: "*/*" }],
      ["GET", { accept: "*/*" }],
    ]);
  });

  it("sends a page's JSON body as JSON, with no header the page chose", async () => {
    const { proxy, connections } = proxyOver({});
    const outcome = await proxy.fetch(canvasId, "https://public.example.com/rpc", {
      resource: "fetch",
      body: json({ ask: 1 }),
    });
    expect(outcome.status).toBe("fetched");
    expect(connections).toEqual([
      {
        url: "https://public.example.com/rpc",
        addresses: [PUBLIC],
        headers: { accept: "*/*", "content-type": "application/json" },
        method: "POST",
        body: '{"ask":1}',
      },
    ]);
  });

  it("sends the body again only where a redirect keeps the method, and judges every hop", async () => {
    const kept = proxyOver({
      respond: (url) =>
        url.pathname === "/final"
          ? new Response("ok")
          : new Response(null, { status: 307, headers: { location: "/final" } }),
    });
    await kept.proxy.fetch(canvasId, "https://public.example.com/start", {
      resource: "fetch",
      body: json({ ask: 1 }),
    });
    expect(kept.connections.map((connection) => [connection.method, connection.body])).toEqual([
      ["POST", '{"ask":1}'],
      ["POST", '{"ask":1}'],
    ]);

    const dropped = proxyOver({
      respond: (url) =>
        url.pathname === "/final"
          ? new Response("ok")
          : new Response(null, { status: 303, headers: { location: "/final" } }),
    });
    await dropped.proxy.fetch(canvasId, "https://public.example.com/start", {
      resource: "fetch",
      body: json({ ask: 1 }),
    });
    expect(dropped.connections.map((connection) => [connection.method, connection.body])).toEqual([
      ["POST", '{"ask":1}'],
      ["GET", undefined],
    ]);
    expect(dropped.connections[1]?.headers).toEqual({ accept: "*/*" });

    // A body is never carried to a private address a redirect names.
    const inward = proxyOver({
      resolve: (hostname) => (hostname === "inside.example.com" ? ["10.0.0.5"] : [PUBLIC]),
      respond: () =>
        new Response(null, { status: 308, headers: { location: "https://inside.example.com/" } }),
    });
    await expect(
      inward.proxy.fetch(canvasId, "https://public.example.com/", {
        resource: "fetch",
        body: json({ secret: true }),
      }),
    ).resolves.toEqual({ status: "refused", reason: "private-address" });
    expect(inward.connections).toHaveLength(1);
  });

  it("passes an image or a font only a response of that type, under the same rule and bounds", async () => {
    const typed = (type: string) =>
      proxyOver({ respond: () => new Response("bytes", { headers: { "content-type": type } }) });
    const image = await typed("image/png").proxy.fetch(canvasId, "https://public.example.com/a", {
      resource: "image",
    });
    expect(image.status === "fetched" && image.contentType).toBe("image/png");
    const font = await typed("font/woff2").proxy.fetch(canvasId, "https://public.example.com/f", {
      resource: "font",
    });
    expect(font.status).toBe("fetched");
    for (const resource of ["image", "font"] as const) {
      await expect(
        typed("text/html").proxy.fetch(canvasId, "https://public.example.com/", { resource }),
      ).resolves.toEqual({ status: "refused", reason: "response-type-not-allowed" });
      const inside = proxyOver({ resolve: () => ["192.168.1.10"] });
      await expect(
        inside.proxy.fetch(canvasId, "https://printer.example.com/logo.png", { resource }),
      ).resolves.toEqual({ status: "refused", reason: "private-address" });
      expect(inside.connections).toEqual([]);
      const large = proxyOver({
        respond: () =>
          new Response("x", {
            headers: {
              "content-type": resource === "image" ? "image/png" : "font/woff2",
              "content-length": String(CANVAS_NETWORK_MAX_RESPONSE_BYTES + 1),
            },
          }),
      });
      await expect(
        large.proxy.fetch(canvasId, "https://public.example.com/", { resource }),
      ).resolves.toEqual({ status: "refused", reason: "response-too-large" });
    }
  });

  it("refuses a response larger than the bound instead of cutting it short", async () => {
    const declared = proxyOver({
      respond: () =>
        new Response("x", {
          headers: { "content-length": String(CANVAS_NETWORK_MAX_RESPONSE_BYTES + 1) },
        }),
    });
    await expect(declared.proxy.fetch(canvasId, "https://big.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "response-too-large",
    });
    const streamed = proxyOver({
      respond: () => new Response(new Uint8Array(CANVAS_NETWORK_MAX_RESPONSE_BYTES + 1)),
    });
    await expect(streamed.proxy.fetch(canvasId, "https://big.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "response-too-large",
    });
  });

  it("gives up on a request that outlasts the time bound", async () => {
    const { proxy } = proxyOver({
      totalTimeMs: 20,
      respond: (_url, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    await expect(proxy.fetch(canvasId, "https://slow.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "timed-out",
    });
  });

  it("gives up on a name lookup that outlasts the time bound, and gives its place back", async () => {
    const { proxy, connections } = proxyOver({
      totalTimeMs: 20,
      resolve: (hostname) =>
        hostname === "stuck.example.com" ? new Promise<ReadonlyArray<string>>(() => {}) : [PUBLIC],
    });
    const stuck = Array.from({ length: CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS }, () =>
      proxy.fetch(canvasId, "https://stuck.example.com/"),
    );
    const outcomes = await Promise.race([
      Promise.all(stuck),
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 500)),
    ]);
    expect(outcomes).toEqual(stuck.map(() => ({ status: "refused", reason: "timed-out" })));
    expect(connections).toEqual([]);
    // Every place the stuck lookups held is free again.
    await expect(proxy.fetch(canvasId, "https://api.example.com/")).resolves.toMatchObject({
      status: "fetched",
    });
  });

  it("connects nowhere for a name that answers after the time bound", async () => {
    let answer: (addresses: ReadonlyArray<string>) => void = () => {};
    const { proxy, connections } = proxyOver({
      totalTimeMs: 20,
      resolve: () =>
        new Promise<ReadonlyArray<string>>((resolve) => {
          answer = resolve;
        }),
    });
    const outcome = await Promise.race([
      proxy.fetch(canvasId, "https://late.example.com/"),
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 500)),
    ]);
    expect(outcome).toEqual({ status: "refused", reason: "timed-out" });
    answer([PUBLIC]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connections).toEqual([]);
  });

  it("refuses a request past the Canvas's concurrent bound, and counts each Canvas alone", async () => {
    const release: Array<() => void> = [];
    const { proxy } = proxyOver({
      respond: () =>
        new Promise<Response>((resolve) => {
          release.push(() => resolve(new Response("done")));
        }),
    });
    const held = Array.from({ length: CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS }, () =>
      proxy.fetch(canvasId, "https://public.example.com/"),
    );
    await expect.poll(() => release.length).toBe(CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS);
    await expect(proxy.fetch(canvasId, "https://public.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "too-many-at-once",
    });
    const other = proxy.fetch(otherCanvasId, "https://public.example.com/");
    await expect.poll(() => release.length).toBe(CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS + 1);
    for (const open of release) open();
    await expect(Promise.all([...held, other])).resolves.toHaveLength(
      CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS + 1,
    );
  });

  it("refuses a request past the Canvas's requests a minute, until the minute passes", async () => {
    let now = 1_000_000;
    const { proxy, connections } = proxyOver({ now: () => now });
    for (let index = 0; index < CANVAS_NETWORK_MAX_REQUESTS_PER_MINUTE; index += 1) {
      await proxy.fetch(canvasId, "https://public.example.com/");
    }
    await expect(proxy.fetch(canvasId, "https://public.example.com/")).resolves.toEqual({
      status: "refused",
      reason: "too-many-requests",
    });
    expect(connections).toHaveLength(CANVAS_NETWORK_MAX_REQUESTS_PER_MINUTE);
    now += 60_001;
    await expect(proxy.fetch(canvasId, "https://public.example.com/")).resolves.toMatchObject({
      status: "fetched",
    });
  });
});

describe("Canvas network proxy answers", () => {
  it("passes on the status, type, and body, and nothing else of the response", async () => {
    const { proxy } = proxyOver({
      respond: () =>
        new Response("<script>alert(1)</script>", {
          status: 404,
          headers: {
            "content-type": "text/html",
            "set-cookie": "session=1",
            "x-powered-by": "elsewhere",
            location: "https://elsewhere.example.com/",
          },
        }),
    });
    const response = canvasNetworkProxyResponse(
      await proxy.fetch(canvasId, "https://public.example.com/"),
    );
    expect(response.status).toBe(404);
    expect(Object.fromEntries(response.headers)).toEqual({
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-disposition": "attachment",
      // Fetched markup is never a document on the host's origin.
      "content-security-policy": "sandbox; default-src 'none'",
      "content-type": "text/html",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    await expect(response.text()).resolves.toBe("<script>alert(1)</script>");
  });

  it("answers a refusal with a reason the page can read, under the same headers", async () => {
    const response = canvasNetworkProxyResponse({ status: "refused", reason: "private-address" });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({ refused: "private-address" });
  });
});

describe("the proxy's own transport", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function listen(): Promise<{
    readonly port: number;
    readonly seen: IncomingHttpHeaders[];
    readonly bodies: string[];
  }> {
    const seen: IncomingHttpHeaders[] = [];
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(`${request.method ?? ""} ${Buffer.concat(chunks).toString()}`);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("reached");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    return {
      port: typeof address === "object" && address !== null ? address.port : 0,
      seen,
      bodies,
    };
  }

  it("connects to the address it was handed, never resolving the name, and sends no credential", async () => {
    const target = await listen();
    // The name exists nowhere, so only the handed address can have reached the listener.
    const connect = pinnedCanvasNetworkConnect(() => undefined);
    const response = await connect(new URL(`http://no-such-name.invalid:${target.port}/x`), {
      addresses: ["127.0.0.1"],
      headers: { accept: "*/*" },
      method: "GET",
      signal: new AbortController().signal,
    });
    await expect(response.text()).resolves.toBe("reached");
    expect(target.seen).toHaveLength(1);
    const names = Object.keys(target.seen[0] ?? {}).sort();
    expect(names.filter((name) => name !== "connection")).toEqual(["accept", "host"]);
    expect(target.seen[0]?.host).toBe(`no-such-name.invalid:${target.port}`);
  });

  it("sends a JSON body with its length and nothing else the page could choose", async () => {
    const target = await listen();
    const connect = pinnedCanvasNetworkConnect(() => undefined);
    const response = await connect(new URL(`http://no-such-name.invalid:${target.port}/rpc`), {
      addresses: ["127.0.0.1"],
      headers: { accept: "*/*", "content-type": "application/json" },
      method: "POST",
      body: json({ ask: 1 }),
      signal: new AbortController().signal,
    });
    await expect(response.text()).resolves.toBe("reached");
    expect(target.bodies).toEqual(['POST {"ask":1}']);
    const names = Object.keys(target.seen[0] ?? {}).sort();
    expect(names.filter((name) => name !== "connection")).toEqual([
      "accept",
      "content-length",
      "content-type",
      "host",
    ]);
  });

  it("judges the handed address again where the socket opens", async () => {
    const target = await listen();
    const connect = pinnedCanvasNetworkConnect((address) =>
      canvasNetworkAddressRefusal(address, nothingReserved),
    );
    await expect(
      connect(new URL(`http://no-such-name.invalid:${target.port}/x`), {
        addresses: ["127.0.0.1"],
        headers: { accept: "*/*" },
        method: "GET",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(target.seen).toEqual([]);
  });
});
