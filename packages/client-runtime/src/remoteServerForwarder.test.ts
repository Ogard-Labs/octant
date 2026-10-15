import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteServerGrant } from "@octant/contracts";
import {
  createRemoteServerForwarder,
  type RemoteServerForwarder,
  type RemoteServerForwarderOptions,
  type RemoteServerHostRequest,
  type RemoteServerHostUpgradeRequest,
  type RemoteServerForwarderSignRequest,
} from "./remoteServerForwarder";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const LISTENER = "https://192.168.1.20:9443";
const GRANT = {
  grantId: `rsg_${"ab".repeat(32)}`,
  threadId: "77777777-7777-4777-8777-777777777777",
  port: 5173,
} as RemoteServerGrant;

const started: RemoteServerForwarder[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const forwarder of started.splice(0)) await forwarder.stop();
  for (const blocker of blockers.splice(0)) {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

/** A free block of ports for one test, so parallel suites never share one. */
async function freePorts(count: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const first = 40_000 + Math.floor(Math.random() * 20_000);
    const held: Server[] = [];
    let free = true;
    for (let offset = 0; offset < count && free; offset += 1) {
      const server = createServer();
      free = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen({ port: first + offset, host: "127.0.0.1", exclusive: true }, () =>
          resolve(true),
        );
      });
      if (free) held.push(server);
    }
    await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))));
    if (free) return first;
  }
  throw new Error("No free ports.");
}

async function block(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve()),
  );
  blockers.push(server);
}

interface Harness {
  readonly forwarder: RemoteServerForwarder;
  readonly port: number;
  readonly sent: RemoteServerHostRequest[];
  readonly signed: string[];
  readonly signings: RemoteServerForwarderSignRequest[];
  readonly upgrades: RemoteServerHostUpgradeRequest[];
}

async function harness(
  overrides: Partial<RemoteServerForwarderOptions> & {
    readonly answer?: (request: RemoteServerHostRequest) => Response | Promise<Response>;
  } = {},
): Promise<Harness> {
  const first = await freePorts(3);
  const sent: RemoteServerHostRequest[] = [];
  const signed: string[] = [];
  const signings: RemoteServerForwarderSignRequest[] = [];
  const upgrades: RemoteServerHostUpgradeRequest[] = [];
  const forwarder = createRemoteServerForwarder({
    ports: { first, count: 3 },
    addresses: ["127.0.0.1"],
    sign: async (request) => {
      signed.push(request.pathQuery);
      signings.push(request);
      return {
        status: "signed",
        headers: {
          cookie: "__Secure-octant-server-proxy-session=proxy-1",
          "x-octant-device-proof": "proof",
          origin: LISTENER,
          "sec-fetch-site": "same-origin",
        },
      };
    },
    sendToHost: async (_target, request) => {
      sent.push(request);
      return (
        (await overrides.answer?.(request)) ??
        new Response("hello from the dev server", {
          headers: { "x-octant-server-proxy": "relayed", "content-type": "text/plain" },
        })
      );
    },
    upgradeToHost: async (_target, request) => {
      upgrades.push(request);
      return {
        status: "answered",
        response: Response.json(
          { kind: "remote-server-proxy-refused", reason: "grant-closed" },
          { status: 410 },
        ),
      };
    },
    ...overrides,
  });
  started.push(forwarder);
  const start = await forwarder.start();
  if (start.status !== "listening") throw new Error("Forwarder did not start.");
  return { forwarder, port: start.port, sent, signed, signings, upgrades };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function get(
  port: number,
  host: string,
  init: {
    readonly path?: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: init.path ?? "/",
        method: init.method ?? "GET",
        headers: { host, ...init.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    // Written before `end`, the body goes chunked with no declared length, so
    // the forwarder has to count it as it arrives.
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

function opened(forwarder: RemoteServerForwarder) {
  const page = forwarder.open({
    hostId: HOST_ID,
    hostName: "Studio Mac",
    listenerOrigin: LISTENER,
    grant: GRANT,
  });
  const access = forwarder.accessFor(page.pageOrigin) ?? "";
  return { page, host: new URL(page.pageOrigin).host, access };
}

describe("the desktop's forwarder for another computer's dev server", () => {
  it("relays a page's request through the grant with Octant's proof and returns the dev server's answer", async () => {
    const { forwarder, port, sent, signed } = await harness();
    const { page, host, access } = opened(forwarder);
    const reply = await get(port, host, {
      path: "/src/main.ts?v=1",
      headers: {
        "x-octant-page-access": access,
        "sec-fetch-site": "same-origin",
        cookie: "theme=dark",
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("hello from the dev server");
    expect(reply.headers["x-octant-server-proxy"]).toBeUndefined();
    expect(signed).toEqual([`/api/server-proxy/${GRANT.grantId}/src/main.ts?v=1`]);
    const headers = new Map(sent[0]?.headers);
    expect(headers.get("cookie")).toBe("theme=dark; __Secure-octant-server-proxy-session=proxy-1");
    expect(headers.get("origin")).toBe(LISTENER);
    expect(headers.has("x-octant-page-access")).toBe(false);
    expect(headers.has("host")).toBe(false);
    expect(page.name).toMatch(/^5173-[a-z2-7]{16}\.octant\.localhost$/);
  });

  it("listens on loopback only", async () => {
    const { forwarder, port } = await harness();
    const { host, access } = opened(forwarder);
    const reply = await get(port, host, { headers: { "x-octant-page-access": access } });
    expect(reply.status).toBe(200);
    // Nothing answers on this computer's other addresses at that port.
    const { networkInterfaces } = await import("node:os");
    const external = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
    if (external === undefined) return;
    await expect(
      new Promise((resolve, reject) => {
        const request = httpRequest(
          { host: external.address, port, path: "/", headers: { host } },
          resolve,
        );
        request.on("error", reject);
        request.end();
      }),
    ).rejects.toThrow();
  });

  it("refuses an unknown name, a request without the page's secret, and a sibling name's request", async () => {
    const { forwarder, port, signed } = await harness();
    const { host, access } = opened(forwarder);
    const unknown = await get(port, `5173-aaaaaaaaaaaaaaaa.octant.localhost:${String(port)}`, {
      headers: { "x-octant-page-access": access },
    });
    expect(unknown.status).toBe(404);
    const without = await get(port, host);
    expect(without.status).toBe(403);
    expect(without.body).toContain("Open this page again from Octant");
    const wrong = await get(port, host, { headers: { "x-octant-page-access": "guess" } });
    expect(wrong.status).toBe(403);
    for (const site of ["same-site", "cross-site"]) {
      const sibling = await get(port, host, {
        headers: {
          cookie: `octant-page-access=${access}`,
          "sec-fetch-site": site,
        },
      });
      expect(sibling.status).toBe(403);
    }
    const otherOrigin = await get(port, host, {
      method: "POST",
      body: "{}",
      headers: {
        cookie: `octant-page-access=${access}`,
        origin: `http://3000-zzzzzzzzzzzzzzzz.octant.localhost:${String(port)}`,
      },
    });
    expect(otherOrigin.status).toBe(403);
    expect(signed).toEqual([]);
  });

  it("gives Octant's browser the secret for the page's exact origin only", async () => {
    const { forwarder, port } = await harness();
    const { page, access } = opened(forwarder);
    expect(access).not.toBe("");
    expect(forwarder.accessFor(`${page.pageOrigin}/`)).toBeUndefined();
    expect(forwarder.accessFor(page.pageOrigin.replace("http:", "https:"))).toBeUndefined();
    expect(forwarder.accessFor(`http://${page.name}:${String(port + 1)}`)).toBeUndefined();
    expect(forwarder.accessFor(`http://localhost:${String(port)}`)).toBeUndefined();
  });

  it("turns a one-time claim into the default browser's access cookie", async () => {
    const { forwarder, port } = await harness();
    const { page, host, access } = opened(forwarder);
    const claimUrl = new URL(page.claimUrl());
    const token = claimUrl.hash.slice(1);
    const claimPage = await get(port, host, { path: claimUrl.pathname });
    expect(claimPage.status).toBe(200);
    expect(claimPage.body).not.toContain(token);
    const claimed = await get(port, host, {
      path: claimUrl.pathname,
      method: "POST",
      body: token,
      headers: { origin: page.pageOrigin, "sec-fetch-site": "same-origin" },
    });
    expect(claimed.status).toBe(204);
    expect(claimed.headers["set-cookie"]).toEqual([
      `octant-page-access=${access}; Path=/; HttpOnly; SameSite=Strict`,
    ]);
    const replayed = await get(port, host, {
      path: claimUrl.pathname,
      method: "POST",
      body: token,
      headers: { origin: page.pageOrigin, "sec-fetch-site": "same-origin" },
    });
    expect(replayed.status).toBe(403);
    const withCookie = await get(port, host, {
      headers: { cookie: `octant-page-access=${access}`, "sec-fetch-site": "none" },
    });
    expect(withCookie.status).toBe(200);
  });

  it("moves to the next port when the recorded one is taken, and refuses when every one is", async () => {
    const first = await freePorts(3);
    await block(first);
    const forwarder = createRemoteServerForwarder({
      ports: { first, count: 3 },
      recordedPort: first,
      addresses: ["127.0.0.1"],
      sign: async () => ({ status: "refused", reason: "no-window" }),
      sendToHost: async () => new Response(),
      upgradeToHost: async () => Promise.reject(new Error("No host.")),
    });
    started.push(forwarder);
    expect(await forwarder.start()).toEqual({ status: "listening", port: first + 1, moved: true });
    await forwarder.stop();

    await block(first + 1);
    await block(first + 2);
    const crowded = createRemoteServerForwarder({
      ports: { first, count: 3 },
      addresses: ["127.0.0.1"],
      sign: async () => ({ status: "refused", reason: "no-window" }),
      sendToHost: async () => new Response(),
      upgradeToHost: async () => Promise.reject(new Error("No host.")),
    });
    started.push(crowded);
    expect(await crowded.start()).toEqual({
      status: "refused",
      reason: "ports-taken",
      message: `Octant can't open pages here: its local ports ${String(first)}–${String(first + 2)} are in use.`,
    });
  });

  it("says an Octant window must be open when no window signs", async () => {
    const { forwarder, port, sent } = await harness({
      sign: async () => ({ status: "refused", reason: "no-window" }),
    });
    const { host, access } = opened(forwarder);
    const reply = await get(port, host, { headers: { "x-octant-page-access": access } });
    expect(reply.status).toBe(503);
    expect(reply.body).toContain("Open an Octant window to keep this page connected.");
    expect(sent).toEqual([]);
  });

  it("shows the host's refusals as the page's failure copy", async () => {
    const cases: ReadonlyArray<readonly [Response | Error, number, string]> = [
      [
        Response.json({ reasonCode: "revoked" }, { status: 401 }),
        403,
        "This computer no longer has access to Studio Mac.",
      ],
      [
        Response.json(
          { kind: "remote-server-proxy-refused", reason: "grant-closed", message: "closed" },
          { status: 404 },
        ),
        410,
        "The server on port 5173 stopped or changed.",
      ],
      [
        new Response("{}", { status: 503, headers: { "retry-after": "1" } }),
        503,
        "Studio Mac is busy with other requests from this computer.",
      ],
      [new TypeError("fetch failed"), 502, "Can't reach Studio Mac."],
    ];
    for (const [answer, status, copy] of cases) {
      const { forwarder, port } = await harness({
        answer: () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      });
      const { host, access } = opened(forwarder);
      const reply = await get(port, host, { headers: { "x-octant-page-access": access } });
      expect(reply.status).toBe(status);
      expect(reply.body).toContain(copy);
    }
  });

  it("refuses a body over 8 MiB before signing it", async () => {
    const { forwarder, port, signed } = await harness();
    const { host, access } = opened(forwarder);
    const reply = await get(port, host, {
      method: "POST",
      body: "x".repeat(8 * 1_024 * 1_024 + 1),
      headers: { "x-octant-page-access": access, "content-type": "text/plain" },
    });
    expect(reply.status).toBe(413);
    expect(signed).toEqual([]);
  });

  it("signs a page's WebSocket upgrade as a bodiless GET under its grant and answers the host's refusal", async () => {
    const { forwarder, port, signings, upgrades } = await harness();
    const { host, access } = opened(forwarder);
    const reply = await get(port, host, {
      path: "/hmr?token=1",
      headers: {
        "x-octant-page-access": access,
        origin: `http://${host}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    expect(reply.status).toBe(410);
    const path = `/api/server-proxy/${GRANT.grantId}/hmr?token=1`;
    expect(signings).toEqual([
      {
        hostId: HOST_ID,
        grantId: GRANT.grantId,
        method: "GET",
        pathQuery: path,
        bodyDigest: createHash("sha256").digest("hex"),
      },
    ]);
    expect(upgrades).toHaveLength(1);
    const headers = new Map(upgrades[0]?.headers);
    expect(upgrades[0]?.pathQuery).toBe(path);
    expect(headers.get("upgrade")).toBe("websocket");
    expect(headers.get("connection")).toBe("Upgrade");
    expect(headers.get("sec-websocket-key")).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(headers.get("origin")).toBe(LISTENER);
    expect(headers.get("x-octant-device-proof")).toBe("proof");
    expect(headers.has("x-octant-page-access")).toBe(false);
  });

  it("refuses a WebSocket upgrade without the page's secret before signing it", async () => {
    const { forwarder, port, signed, upgrades } = await harness();
    const { host } = opened(forwarder);
    const reply = await get(port, host, {
      path: "/hmr",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    expect(reply.status).toBe(403);
    expect(signed).toEqual([]);
    expect(upgrades).toEqual([]);
  });

  it("stops serving a host's pages when the host is closed", async () => {
    const { forwarder, port } = await harness();
    const { host, access } = opened(forwarder);
    forwarder.closeHost(HOST_ID);
    const reply = await get(port, host, { headers: { "x-octant-page-access": access } });
    expect(reply.status).toBe(404);
  });
});
