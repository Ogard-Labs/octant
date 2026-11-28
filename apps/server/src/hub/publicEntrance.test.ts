import { checkServerIdentity } from "node:tls";
import { request as httpRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { PUSH_SENDER_ROUTES } from "../push/pushSenderRoutes";
import { HUB_ADMINISTRATION_ROUTES } from "./hubAdministrationRoutes";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";
import { HUB_OWNER_ROUTES } from "./hubOwnerRoutes";
import { PEER_DELEGATION_ROUTES } from "./peerDelegationRoutes";
import {
  PRIVATE_LISTENER_TEST_CERT,
  PRIVATE_LISTENER_TEST_KEY,
} from "../privateListener.test-certs";
import {
  matchPublicRoute,
  startPublicEntrance,
  type PublicEntrance,
  type PublicEntranceHandlers,
  type PublicEntranceRole,
  type PublicRequest,
} from "./publicEntrance";
import { THREAD_MOVE_ROUTES } from "./threadMoveService";

const open: PublicEntrance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((entrance) => entrance.close()));
});

async function boot(
  options: {
    readonly role?: () => PublicEntranceRole;
    readonly handlers?: PublicEntranceHandlers;
    readonly requestsPerMinute?: number;
    readonly forward?: Parameters<typeof startPublicEntrance>[0]["forward"];
  } = {},
): Promise<{ readonly base: string; readonly entrance: PublicEntrance }> {
  const entrance = await startPublicEntrance({
    port: 0,
    role: options.role ?? (() => "serve"),
    handlers: options.handlers ?? {},
    ...(options.requestsPerMinute === undefined
      ? {}
      : { requestsPerMinute: options.requestsPerMinute }),
    ...(options.forward === undefined ? {} : { forward: options.forward }),
  });
  open.push(entrance);
  return { base: `http://127.0.0.1:${entrance.port}`, entrance };
}

/** Every private route the server registers, and the private listener's own surfaces. */
const PRIVATE_PATHS: ReadonlyArray<string> = [
  "/",
  "/index.html",
  "/assets/index.js",
  "/ws",
  "/api/remote/hello",
  "/api/remote/pairing/claim",
  "/api/remote/pairing/status",
  "/api/remote/auth/session",
  "/api/remote/devices",
  "/api/remote/devices/sign-out-others",
  "/api/desktop/listener",
  "/api/hub/public/forward",
  ...Object.values(HUB_LINK_ROUTES),
  ...Object.values(HUB_ADMINISTRATION_ROUTES),
  ...Object.values(HUB_OWNER_ROUTES),
  ...Object.values(PEER_DELEGATION_ROUTES),
  ...Object.values(THREAD_MOVE_ROUTES),
  ...Object.values(PUSH_SENDER_ROUTES),
].map((path) => path.replace(/:[A-Za-z]+/g, "x"));

describe("the route table", () => {
  it("the public listener answers 404 to every private route", async () => {
    // Every feature handler is present, so a 404 here is the table, not a switch.
    const reached: string[] = [];
    const answer = async (request: PublicRequest) => {
      reached.push(request.path);
      return { status: 200, body: "reached" };
    };
    const { base } = await boot({
      handlers: {
        visitorPage: answer,
        visitorAsset: answer,
        visitorOpen: answer,
        visitorStream: answer,
        visitorComments: answer,
        webhook: answer,
      },
    });
    expect(PRIVATE_PATHS.length).toBeGreaterThan(40);
    for (const path of PRIVATE_PATHS) {
      for (const method of ["GET", "POST", "PUT", "HEAD"]) {
        const response = await fetch(`${base}${path}`, {
          method,
          ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
        });
        expect({ path, method, status: response.status }).toEqual({ path, method, status: 404 });
      }
    }
    expect(reached).toEqual([]);
  });

  it("matches only the closed table", () => {
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    expect(matchPublicRoute("GET", `/v/${id}`)).toMatchObject({
      status: "route",
      name: "visitor-page",
    });
    expect(matchPublicRoute("POST", `/hooks/${id}`)).toMatchObject({
      status: "route",
      name: "webhook",
      params: { id },
    });
    expect(matchPublicRoute("GET", "/relay/v1")).toMatchObject({ status: "route", name: "relay" });
    expect(matchPublicRoute("GET", "/healthz")).toMatchObject({ status: "route", name: "health" });
    expect(matchPublicRoute("GET", `/hooks/${id}`)).toEqual({
      status: "method-not-allowed",
      allow: "POST",
    });
    for (const path of [
      `/v/${id}x`,
      `/hooks/${id}/x`,
      "/v/short",
      "/hooks/",
      "/healthz/",
      "/relay",
    ]) {
      expect(matchPublicRoute("GET", path)).toEqual({ status: "not-found" });
    }
  });

  it("answers 405 to HEAD and GET on a hook without reading the body", async () => {
    let reached = false;
    const { entrance } = await boot({
      handlers: {
        webhook: async () => {
          reached = true;
          return { status: 202 };
        },
      },
    });
    for (const method of ["GET", "HEAD", "PUT"]) {
      // The client announces a large body and sends none of it: an answer
      // proves the entrance did not wait to read it.
      const status = await new Promise<{ code: number; allow: string | undefined }>(
        (resolve, reject) => {
          const outgoing = httpRequest({
            host: "127.0.0.1",
            port: entrance.port,
            method,
            path: "/hooks/AAAAAAAAAAAAAAAAAAAAAA",
            headers: { "content-length": String(10 * 1024 * 1024) },
          });
          outgoing.on("response", (response) => {
            response.resume();
            resolve({ code: response.statusCode ?? 0, allow: response.headers.allow });
            outgoing.destroy();
          });
          outgoing.on("error", reject);
          outgoing.flushHeaders();
        },
      );
      expect(status).toEqual({ code: 405, allow: "POST" });
    }
    expect(reached).toBe(false);
  });

  it("answers 404 for a route whose feature is off", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/v/AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
    expect(
      (await fetch(`${base}/hooks/AAAAAAAAAAAAAAAAAAAAAA`, { method: "POST", body: "{}" })).status,
    ).toBe(404);
  });
});

describe("health", () => {
  it("says only that it is there, and only on the acting hub", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });

  it("answers 503 on a member that cannot reach the acting hub", async () => {
    const { base } = await boot({ role: () => "forward", forward: async () => undefined });
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it("carries a member's request to the acting hub unchanged", async () => {
    const forwarded: Array<{ method: string; path: string; body: string }> = [];
    const { base } = await boot({
      role: () => "forward",
      forward: async (envelope) => {
        forwarded.push({ method: envelope.method, path: envelope.path, body: envelope.body });
        return { status: 202, headers: { "content-type": "application/json" }, body: "e30" };
      },
    });
    const response = await fetch(`${base}/hooks/AAAAAAAAAAAAAAAAAAAAAA`, {
      method: "POST",
      body: '{"a":1}',
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("{}");
    expect(forwarded).toEqual([
      {
        method: "POST",
        path: "/hooks/AAAAAAAAAAAAAAAAAAAAAA",
        body: Buffer.from('{"a":1}').toString("base64"),
      },
    ]);
  });

  it("a member's entrance binds no visitor link, since the live thread cannot follow it there", async () => {
    const forwarded: string[] = [];
    const { base } = await boot({
      role: () => "forward",
      forward: async (envelope) => {
        forwarded.push(envelope.path);
        return { status: 200, headers: {}, body: "" };
      },
    });
    const link = "AAAAAAAAAAAAAAAAAAAAAA";
    for (const [method, path] of [
      ["POST", `/v/${link}/open`],
      ["GET", `/v/${link}/stream`],
      ["POST", `/v/${link}/comments`],
    ] as const) {
      expect((await fetch(`${base}${path}`, { method })).status).toBe(501);
    }
    expect(forwarded).toEqual([]);
  });
});

describe("what a request carries", () => {
  it("the public listener ignores a cookie and a forwarded header", async () => {
    let seen: PublicRequest | undefined;
    const { base } = await boot({
      handlers: {
        webhook: async (request) => {
          seen = request;
          return { status: 202, headers: { "set-cookie": "session=1" } };
        },
      },
    });
    const response = await fetch(`${base}/hooks/AAAAAAAAAAAAAAAAAAAAAA`, {
      method: "POST",
      body: "{}",
      headers: {
        cookie: "octant-session=abc",
        authorization: "Bearer token",
        forwarded: "for=127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost",
        "x-real-ip": "127.0.0.1",
        "webhook-id": "msg_1",
      },
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(seen?.principal).toEqual({ kind: "webhook", endpointId: "AAAAAAAAAAAAAAAAAAAAAA" });
    const names = [...(seen?.headers.keys() ?? [])];
    for (const name of [
      "cookie",
      "authorization",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-real-ip",
    ]) {
      expect(names).not.toContain(name);
    }
    expect(seen?.headers.get("webhook-id")).toBe("msg_1");
  });

  it("sends the same hardening headers on every answer", async () => {
    const { base } = await boot();
    for (const path of ["/healthz", "/nope"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
  });

  it("puts the content security policy on every page", async () => {
    const { base } = await boot({
      handlers: {
        visitorPage: async () => ({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<!doctype html>",
        }),
      },
    });
    const response = await fetch(`${base}/v/AAAAAAAAAAAAAAAAAAAAAA`);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("refuses requests beyond the whole entrance's rate", async () => {
    const { base } = await boot({ requestsPerMinute: 3 });
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await fetch(`${base}/healthz`)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("closes when the host's role says so", async () => {
    let role: PublicEntranceRole = "serve";
    const { base } = await boot({ role: () => role });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    role = "closed";
    expect((await fetch(`${base}/healthz`)).status).toBe(404);
  });
});

describe("streaming answers", () => {
  const LINK = "AAAAAAAAAAAAAAAAAAAAAA";

  function streamingHandlers() {
    const seen: { aborted: boolean; cancelled: boolean } = { aborted: false, cancelled: false };
    const handlers: PublicEntranceHandlers = {
      visitorStream: async (request) => {
        request.signal.addEventListener("abort", () => {
          seen.aborted = true;
        });
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new TextEncoder().encode("data: 1\n\n")),
            cancel: () => {
              seen.cancelled = true;
            },
          }),
        };
      },
    };
    return { seen, handlers };
  }

  it("a streaming answer ends when the visitor disconnects, not before", async () => {
    const { seen, handlers } = streamingHandlers();
    const { base } = await boot({ handlers });
    const leave = new AbortController();
    const response = await fetch(`${base}/v/${LINK}/stream`, { signal: leave.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    expect(seen.aborted).toBe(false);
    leave.abort();
    await expect.poll(() => seen.aborted).toBe(true);
  });

  it("a stream request forwarded by a member is refused and its stream cancelled", async () => {
    const { seen, handlers } = streamingHandlers();
    const { entrance } = await boot({ handlers });
    const reply = await entrance.dispatchForwarded({
      method: "GET",
      path: `/v/${LINK}/stream`,
      headers: {},
      body: "",
    });
    expect(reply.status).toBe(501);
    expect(seen.cancelled).toBe(true);
  });
});

describe("relayed connections", () => {
  it("closing the entrance ends an open relay instead of waiting for the device to leave", async () => {
    const entrance = await startPublicEntrance({
      port: 0,
      role: () => "serve",
      handlers: {
        // A relay that keeps its upgraded socket open, as an idle tunnel does.
        relay: (_request, socket) => {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
          );
        },
      },
    });
    const device = await new Promise<{
      readonly socket: Duplex;
      readonly ended: Promise<void>;
    }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: entrance.port,
        path: "/relay/v1",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      request.on("upgrade", (_response, socket) => {
        socket.on("error", () => undefined);
        resolve({
          socket,
          ended: new Promise<void>((done) => socket.on("close", () => done())),
        });
      });
      request.on("error", reject);
      request.end();
    });
    try {
      const closed = await Promise.race([
        entrance.close().then(() => "closed" as const),
        new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 2_000)),
      ]);
      expect(closed).toBe("closed");
      await device.ended;
    } finally {
      // A stalled close fails above and would otherwise leave the device's socket open.
      device.socket.destroy();
    }
  });
});

describe("a front on another machine", () => {
  async function bootTailnet(admits: (remoteAddress: string | undefined) => boolean) {
    // The test machine has no Tailscale address; the bind address and the
    // peer check are the listener's inputs, and the service picks them.
    const entrance = await startPublicEntrance({
      port: 0,
      role: () => "serve",
      handlers: {},
      tailnet: {
        address: "127.0.0.1",
        tls: { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
        admits,
      },
    });
    open.push(entrance);
    return entrance;
  }

  const health = (port: number) =>
    new Promise<number | "refused">((resolve) => {
      const request = httpsGet(
        {
          host: "127.0.0.1",
          port,
          path: "/healthz",
          ca: PRIVATE_LISTENER_TEST_CERT,
          // The chain is verified against the fixture; its certificate names
          // the address it was issued for, so the identity is checked there.
          checkServerIdentity: (_host, certificate) =>
            checkServerIdentity("192.168.1.20", certificate),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", () => resolve("refused"));
    });

  it("a connection from an unlisted address is refused before TLS", async () => {
    const seen: Array<string | undefined> = [];
    const entrance = await bootTailnet((remoteAddress) => {
      seen.push(remoteAddress);
      return false;
    });
    expect(await health(entrance.port)).toBe("refused");
    expect(seen).toHaveLength(1);
  });

  it("a connection from a listed front is served over TLS", async () => {
    const entrance = await bootTailnet((remoteAddress) => remoteAddress === "127.0.0.1");
    expect(await health(entrance.port)).toBe(200);
  });

  it("closing the entrance ends a listed front's connection that never finishes TLS", async () => {
    const admitted = Promise.withResolvers<void>();
    const entrance = await startPublicEntrance({
      port: 0,
      role: () => "serve",
      handlers: {},
      tailnet: {
        address: "127.0.0.1",
        tls: { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
        admits: () => {
          admitted.resolve();
          return true;
        },
      },
    });
    // TCP only: no TLS byte ever follows.
    const front = connect({ host: "127.0.0.1", port: entrance.port });
    front.on("error", () => undefined);
    const ended = new Promise<void>((done) => front.on("close", () => done()));
    try {
      await admitted.promise;
      const closed = await Promise.race([
        entrance.close().then(() => "closed" as const),
        new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 2_000)),
      ]);
      expect(closed).toBe("closed");
      await ended;
    } finally {
      front.destroy();
    }
  });
});
