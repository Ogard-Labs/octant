import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContextPolicy, BrowserProfileClearScope } from "@octant/contracts";
import {
  BROWSER_RESIZE_BOUNDS,
  BrowserActionKind,
  BrowserObservationPart,
  decodeBrowserWaitFor,
  decodeImportedCookie,
  MAX_BROWSER_UPLOAD_FILES,
  decodeStoredBrowserProfile,
  MAX_BROWSER_TABS_PER_CONTEXT,
  MAX_COOKIES_PER_IMPORT_BATCH,
} from "@octant/contracts";
import type { BrowserProfileStore } from "./browserProfileStore";
import {
  BrowserNavigationBlockedError,
  BrowserTargetStaleError,
  BrowserWaitTimedOutError,
  type BrowserSurfaceAction,
  type ReturnTypeOfBrowserSurfaceHost,
} from "./browserSurfaceHost";

const BODY_LIMIT = 96 * 1_024;
const TOKEN_HEADER = "x-octant-browser-broker-token";
const ROUTES = new Set([
  "/v1/available",
  "/v1/contexts/create",
  "/v1/contexts/inspect-target",
  "/v1/contexts/gone",
  "/v1/contexts/act",
  "/v1/contexts/peek",
  "/v1/contexts/close",
  "/v1/contexts/close-all",
  "/v1/profiles/list",
  "/v1/profiles/clear",
  "/v1/extensions/sync",
  "/v1/profiles/import-cookies",
]);
/** A batch of cookies is larger than any other request, and is bounded by count too. */
const IMPORT_BODY_LIMIT = 2 * 1_024 * 1_024;

export interface BrowserRuntimeBroker {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
  readonly fetchForTest: (request: Request, peerAddress?: string) => Promise<Response>;
}

export async function startBrowserRuntimeBroker(
  host: ReturnTypeOfBrowserSurfaceHost,
  profiles?: BrowserProfileStore,
): Promise<BrowserRuntimeBroker> {
  const token = randomBytes(32).toString("base64url");
  const goneContexts = new Set<string>();
  const removeGoneListener = host.onContextGone((contextId) => goneContexts.add(contextId));
  let brokerUrl: string | undefined;
  const server = createServer((incoming, outgoing) => {
    void handleIncoming(incoming, brokerUrl, token, host, goneContexts, profiles).then(
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
      handleBrokerRequest(request, peerAddress, token, host, goneContexts, profiles),
  });
}

async function handleIncoming(
  incoming: IncomingMessage,
  brokerUrl: string | undefined,
  token: string,
  host: ReturnTypeOfBrowserSurfaceHost,
  goneContexts: Set<string>,
  profiles: BrowserProfileStore | undefined,
): Promise<Response> {
  if (brokerUrl === undefined) return failure("unavailable", 503);
  const bytes = await readBody(incoming, bodyLimitFor(incoming.url));
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
    profiles,
    abort.signal,
  );
}

async function handleBrokerRequest(
  request: Request,
  peerAddress: string,
  token: string,
  host: ReturnTypeOfBrowserSurfaceHost,
  goneContexts: Set<string>,
  profiles: BrowserProfileStore | undefined,
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
    if (url.pathname === "/v1/profiles/list") {
      if (profiles === undefined) return failure("profiles-unavailable", 409);
      return Response.json({ profiles: await profiles.list() });
    }
    if (url.pathname === "/v1/profiles/clear") {
      if (profiles === undefined) return failure("profiles-unavailable", 409);
      const target = storedProfileOf(body.profile);
      if (target === undefined || !isClearScope(body.scope)) {
        return failure("invalid-request", 400);
      }
      await profiles.clear(target, body.scope);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/v1/extensions/sync") {
      if (profiles === undefined) return failure("profiles-unavailable", 409);
      const target = storedProfileOf(body.profile);
      const wanted = enabledExtensionsOf(body.extensions);
      if (target === undefined || wanted === undefined) return failure("invalid-request", 400);
      await profiles.syncExtensions(target, wanted);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/v1/profiles/import-cookies") {
      if (profiles === undefined) return failure("profiles-unavailable", 409);
      const target = storedProfileOf(body.profile);
      const cookies = importedCookiesOf(body.cookies);
      if (target === undefined || cookies === undefined) return failure("invalid-request", 400);
      return Response.json(await profiles.importCookies(target, cookies));
    }
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
    if (url.pathname === "/v1/contexts/peek") {
      if (!isUuid(body.contextId)) return failure("invalid-request", 400);
      return Response.json(await host.peek(body.contextId));
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
    if (error instanceof BrowserWaitTimedOutError) {
      return Response.json(
        { error: "wait-timed-out", message: error.message.slice(0, 1024) },
        { status: 422 },
      );
    }
    if (error instanceof BrowserTargetStaleError) {
      return Response.json({ error: "target-stale" }, { status: 422 });
    }
    if (error instanceof BrowserNavigationBlockedError) {
      return Response.json({ error: "navigation-blocked", url: error.url }, { status: 422 });
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
    if (bytes.byteLength > bodyLimitFor(new URL(request.url).pathname)) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function bodyLimitFor(path: string | undefined): number {
  return path?.split("?")[0] === "/v1/profiles/import-cookies" ? IMPORT_BODY_LIMIT : BODY_LIMIT;
}

function readBody(incoming: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= limit) chunks.push(chunk);
    });
    incoming.once("end", () => resolve(size <= limit ? Buffer.concat(chunks) : undefined));
    incoming.once("error", reject);
  });
}

function isPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.profileMode === "isolated" &&
    (value.profile === undefined || storedOrPrivateProfile(value.profile)) &&
    Array.isArray(value.allowedOrigins) &&
    value.allowedOrigins.every((origin) => typeof origin === "string") &&
    value.credentialFieldProtection === true &&
    Number.isInteger(value.maxConcurrentTabs) &&
    (value.maxConcurrentTabs as number) >= 1 &&
    (value.maxConcurrentTabs as number) <= MAX_BROWSER_TABS_PER_CONTEXT &&
    typeof value.sessionTimeoutMs === "number"
  );
}

function storedOrPrivateProfile(value: unknown): boolean {
  if (isRecord(value) && value.kind === "private" && Object.keys(value).length === 1) return true;
  return storedProfileOf(value) !== undefined;
}

/** The folders to load, each an absolute path under a folder the host named by id. */
function enabledExtensionsOf(value: unknown) {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const wanted: Array<{ id: string; path: string; contentHash: string }> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !/^[0-9a-f]{32}$/.test(entry.id) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("/") ||
      entry.path.includes("\0") ||
      typeof entry.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.contentHash)
    ) {
      return undefined;
    }
    wanted.push({ id: entry.id, path: entry.path, contentHash: entry.contentHash });
  }
  return wanted;
}

function importedCookiesOf(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_COOKIES_PER_IMPORT_BATCH) return undefined;
  try {
    return value.map((cookie: unknown) => decodeImportedCookie(cookie));
  } catch {
    return undefined;
  }
}

function storedProfileOf(value: unknown) {
  try {
    return decodeStoredBrowserProfile(value);
  } catch {
    return undefined;
  }
}

function isClearScope(value: unknown): value is BrowserProfileClearScope {
  return value === "cookies" || value === "all";
}

function isOwner(value: unknown): value is { windowId: string; threadId: string } {
  return isRecord(value) && typeof value.windowId === "string" && isUuid(value.threadId);
}

function isBrowserAction(value: unknown): value is BrowserSurfaceAction {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "kind",
    "target",
    "value",
    "point",
    "deltaX",
    "deltaY",
    "expected",
    "include",
    "destination",
    "destinationExpected",
    "files",
    "tabId",
    "waitFor",
    "viewport",
    "diagnosticsSince",
    "diagnosticsWarnings",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (!(BrowserActionKind.literals as ReadonlyArray<unknown>).includes(value.kind)) return false;
  return (
    (value.target === undefined ||
      (typeof value.target === "string" && value.target.length <= 4096)) &&
    (value.value === undefined ||
      (typeof value.value === "string" && value.value.length <= 65_536)) &&
    (value.point === undefined || isViewportPoint(value.point)) &&
    (value.deltaX === undefined || isBoundedDelta(value.deltaX)) &&
    (value.deltaY === undefined || isBoundedDelta(value.deltaY)) &&
    (value.expected === undefined || isExpectedElement(value.expected)) &&
    (value.destination === undefined ||
      (typeof value.destination === "string" && value.destination.length <= 4096)) &&
    (value.destinationExpected === undefined || isExpectedElement(value.destinationExpected)) &&
    (value.files === undefined ||
      (Array.isArray(value.files) &&
        value.files.length >= 1 &&
        value.files.length <= MAX_BROWSER_UPLOAD_FILES &&
        value.files.every(
          (file) => typeof file === "string" && file.length <= 4096 && file.startsWith("/"),
        ))) &&
    (value.waitFor === undefined || isWaitFor(value.waitFor)) &&
    (value.diagnosticsSince === undefined ||
      (Number.isSafeInteger(value.diagnosticsSince) && (value.diagnosticsSince as number) >= 0)) &&
    (value.diagnosticsWarnings === undefined || typeof value.diagnosticsWarnings === "boolean") &&
    (value.viewport === undefined || isViewportSize(value.viewport)) &&
    (value.tabId === undefined ||
      (typeof value.tabId === "string" && /^t[1-9][0-9]{0,3}$/.test(value.tabId))) &&
    (value.include === undefined ||
      (Array.isArray(value.include) &&
        value.include.length <= 3 &&
        value.include.every((part) =>
          (BrowserObservationPart.literals as ReadonlyArray<unknown>).includes(part),
        )))
  );
}

function isWaitFor(value: unknown): boolean {
  try {
    decodeBrowserWaitFor(value);
    return true;
  } catch {
    return false;
  }
}

function isViewportSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "width" || key === "height") &&
    Number.isInteger(value.width) &&
    Number.isInteger(value.height) &&
    (value.width as number) >= BROWSER_RESIZE_BOUNDS.minWidth &&
    (value.width as number) <= BROWSER_RESIZE_BOUNDS.maxWidth &&
    (value.height as number) >= BROWSER_RESIZE_BOUNDS.minHeight &&
    (value.height as number) <= BROWSER_RESIZE_BOUNDS.maxHeight
  );
}

function isExpectedElement(value: unknown): value is { role: string; name: string; url: string } {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "role" || key === "name" || key === "url") &&
    typeof value.url === "string" &&
    value.url.length <= 4096 &&
    typeof value.role === "string" &&
    value.role.length <= 64 &&
    typeof value.name === "string" &&
    value.name.length <= 512
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
