import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContextPolicy } from "@octant/contracts";
import type { ReturnTypeOfBrowserSurfaceHost } from "./browserSurfaceHost";

const BODY_LIMIT = 96 * 1_024;
const TOKEN_HEADER = "x-octant-browser-broker-token";
const ROUTES = new Set([
  "/v1/available",
  "/v1/contexts/create",
  "/v1/contexts/inspect-target",
  "/v1/contexts/gone",
  "/v1/contexts/act",
  "/v1/contexts/close",
  "/v1/contexts/close-all",
]);

export interface BrowserRuntimeBroker {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
  readonly fetchForTest: (request: Request, peerAddress?: string) => Promise<Response>;
}

export async function startBrowserRuntimeBroker(
  host: ReturnTypeOfBrowserSurfaceHost,
): Promise<BrowserRuntimeBroker> {
  const token = randomBytes(32).toString("base64url");
  const goneContexts = new Set<string>();
  const removeGoneListener = host.onContextGone((contextId) => goneContexts.add(contextId));
  let brokerUrl: string | undefined;
  const server = createServer((incoming, outgoing) => {
    void handleIncoming(incoming, brokerUrl, token, host, goneContexts).then(
      async (response) => {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => (headers[name] = value));
        outgoing.writeHead(response.status, headers);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      },
      () => {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "browser-broker-unavailable" }));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("Octant Browser runtime broker is unavailable.");
  brokerUrl = `http://127.0.0.1:${address.port}/`;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    url: brokerUrl,
    token,
    close: () => {
      closing ??= (async () => {
        removeGoneListener();
        await host.closeAll();
        await new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => (error === undefined ? resolve() : reject(error)));
          server.closeAllConnections();
        });
      })();
      return closing;
    },
    fetchForTest: (request: Request, peerAddress = "127.0.0.1") =>
      handleBrokerRequest(request, peerAddress, token, host, goneContexts),
  });
}

async function handleIncoming(
  incoming: IncomingMessage,
  brokerUrl: string | undefined,
  token: string,
  host: ReturnTypeOfBrowserSurfaceHost,
  goneContexts: Set<string>,
): Promise<Response> {
  if (brokerUrl === undefined) return failure("unavailable", 503);
  const bytes = await readBody(incoming);
  if (bytes === undefined) return failure("too-large", 413);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const request = new Request(new URL(incoming.url ?? "/", brokerUrl), {
    method: incoming.method ?? "POST",
    headers,
    ...(incoming.method === "GET" || incoming.method === "HEAD"
      ? {}
      : { body: Buffer.from(bytes) }),
  });
  const abort = new AbortController();
  incoming.once("aborted", () => abort.abort(new Error("Browser broker request was cancelled.")));
  return handleBrokerRequest(
    request,
    incoming.socket.remoteAddress ?? "",
    token,
    host,
    goneContexts,
    abort.signal,
  );
}

async function handleBrokerRequest(
  request: Request,
  peerAddress: string,
  token: string,
  host: ReturnTypeOfBrowserSurfaceHost,
  goneContexts: Set<string>,
  signal?: AbortSignal,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isAuthorized(peerAddress, request.headers, token)) return failure("unauthorized", 401);
  if (!ROUTES.has(url.pathname)) return failure("not-found", 404);
  if (request.method !== "POST" || url.search !== "") return failure("invalid-request", 400);
  if (url.pathname === "/v1/available") return Response.json({ available: host.available() });
  if (url.pathname === "/v1/contexts/gone") {
    const contextIds = [...goneContexts];
    goneContexts.clear();
    return Response.json({ contextIds });
  }
  const body = await jsonBody(request);
  if (body === undefined) return failure("invalid-request", 400);
  try {
    if (url.pathname === "/v1/contexts/create") {
      if (!isUuid(body.contextId) || !isOwner(body.owner) || !isPolicy(body.policy)) {
        return failure("invalid-request", 400);
      }
      await host.createContext({
        contextId: body.contextId,
        owner: body.owner,
        policy: body.policy as BrowserContextPolicy,
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/v1/contexts/inspect-target") {
      if (!isUuid(body.contextId) || typeof body.selector !== "string") {
        return failure("invalid-request", 400);
      }
      return Response.json(await host.inspectTarget(body.contextId, body.selector));
    }
    if (url.pathname === "/v1/contexts/act") {
      if (!isUuid(body.contextId) || !isBrowserAction(body.request)) {
        return failure("invalid-request", 400);
      }
      return Response.json(
        signal === undefined
          ? await host.act(body.contextId, body.request)
          : await host.act(body.contextId, body.request, signal),
      );
    }
    if (url.pathname === "/v1/contexts/close") {
      if (!isUuid(body.contextId)) return failure("invalid-request", 400);
      await host.closeContext(body.contextId);
      return Response.json({ ok: true });
    }
    await host.closeAll();
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a native Project window")) {
      return failure("owner-unavailable", 409);
    }
    return failure("browser-operation-failed", 503);
  }
}

function isAuthorized(peerAddress: string, headers: Headers, token: string): boolean {
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peerAddress);
  const expected = createHash("sha256").update(token).digest();
  const actual = createHash("sha256")
    .update(headers.get(TOKEN_HEADER) ?? "")
    .digest();
  return loopback && !headers.has("origin") && timingSafeEqual(expected, actual);
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > BODY_LIMIT) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readBody(incoming: IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    incoming.once("end", () => resolve(size <= BODY_LIMIT ? Buffer.concat(chunks) : undefined));
    incoming.once("error", reject);
  });
}

function isPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.profileMode === "isolated" &&
    Array.isArray(value.allowedOrigins) &&
    value.allowedOrigins.every((origin) => typeof origin === "string") &&
    value.credentialFieldProtection === true &&
    value.maxConcurrentTabs === 1 &&
    typeof value.sessionTimeoutMs === "number"
  );
}

function isOwner(value: unknown): value is { windowId: string; threadId: string } {
  return isRecord(value) && typeof value.windowId === "string" && isUuid(value.threadId);
}

function isBrowserAction(value: unknown): value is {
  kind:
    | "navigate"
    | "click"
    | "type"
    | "press"
    | "scroll"
    | "screenshot"
    | "extract-text"
    | "wait"
    | "close-tab";
  target?: string;
  value?: string;
  point?: { readonly x: number; readonly y: number };
  deltaX?: number;
  deltaY?: number;
} {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(["kind", "target", "value", "point", "deltaX", "deltaY"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (
    ![
      "navigate",
      "click",
      "type",
      "press",
      "scroll",
      "screenshot",
      "extract-text",
      "wait",
      "close-tab",
    ].includes(String(value.kind))
  ) {
    return false;
  }
  return (
    (value.target === undefined ||
      (typeof value.target === "string" && value.target.length <= 4096)) &&
    (value.value === undefined ||
      (typeof value.value === "string" && value.value.length <= 65_536)) &&
    (value.point === undefined || isViewportPoint(value.point)) &&
    (value.deltaX === undefined || isBoundedDelta(value.deltaX)) &&
    (value.deltaY === undefined || isBoundedDelta(value.deltaY))
  );
}

function isViewportPoint(value: unknown): value is { readonly x: number; readonly y: number } {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "x" || key === "y") &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    value.x >= 0 &&
    value.x <= 1 &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    value.y >= 0 &&
    value.y <= 1
  );
}

function isBoundedDelta(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -2000 && value <= 2000;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
