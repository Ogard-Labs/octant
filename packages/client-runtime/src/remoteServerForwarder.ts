// The local port that shows a dev server of another paired computer on this
// one. It listens on loopback only, routes by the exact page name in `Host`,
// admits a request only with the secret its Open minted, has every request
// signed by the Octant window that holds the grant, and relays it to the
// paired host's proxy route. It holds no key and no authority of its own: the
// host judges every request again against the grant.
//
// It imports Node modules, so the package barrel does not export it and
// browser and phone bundles never load it. The desktop's main process owns its
// lifecycle, its recorded port, and the transport to the host.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  REMOTE_SERVER_PROXY_RELAYED,
  REMOTE_SERVER_PROXY_RELAYED_HEADER,
  type RemoteServerGrant,
} from "@octant/contracts";
import {
  REMOTE_SERVER_FORWARDER_PORTS,
  REMOTE_SERVER_PAGE_ACCESS_COOKIE,
  REMOTE_SERVER_PAGE_ACCESS_HEADER,
  REMOTE_SERVER_PAGE_CLAIM_PATH,
  REMOTE_SERVER_PAGE_MAX_BODY_BYTES,
  judgeRemoteServerPageRequest,
  remoteServerPageAccessCookie,
  remoteServerPageLabelInput,
  remoteServerPageName,
  remoteServerPageResponseHeaders,
  remoteServerPageUpstreamHeaders,
  type RemoteServerRelayHeader,
} from "@octant/domain";

/** What Open hands the forwarder: the paired host and the grant it minted. */
export interface RemoteServerPageTarget {
  readonly hostId: string;
  readonly hostName: string;
  /** The host's private listener origin. */
  readonly listenerOrigin: string;
  readonly grant: RemoteServerGrant;
}

/** One request the forwarder asks a window to sign; the window decides whether it may. */
export interface RemoteServerForwarderSignRequest {
  readonly hostId: string;
  readonly grantId: string;
  readonly method: string;
  readonly pathQuery: string;
  readonly bodyDigest: string;
}

export type RemoteServerForwarderSigning =
  | { readonly status: "signed"; readonly headers: Readonly<Record<string, string>> }
  /**
   * `no-window`: no Octant window holding the grant answered.
   * `refused`: the window would not sign it (the grant is gone from it).
   */
  | { readonly status: "refused"; readonly reason: "no-window" | "refused" };

/** One request on its way to the host's proxy route. */
export interface RemoteServerHostRequest {
  readonly method: string;
  readonly pathQuery: string;
  readonly headers: ReadonlyArray<RemoteServerRelayHeader>;
  readonly body: Uint8Array | undefined;
  readonly signal: AbortSignal;
}

export interface RemoteServerForwarderOptions {
  /** The port the forwarder last held, so pages keep their origin across launches. */
  readonly recordedPort?: number;
  readonly ports?: { readonly first: number; readonly count: number };
  /** Loopback addresses to bind; both families by default. Never anything else. */
  readonly addresses?: ReadonlyArray<"127.0.0.1" | "::1">;
  readonly sign: (
    request: RemoteServerForwarderSignRequest,
  ) => Promise<RemoteServerForwarderSigning>;
  /** Sends one request to the paired host's listener. Rejects when the host cannot be reached. */
  readonly sendToHost: (
    target: { readonly hostId: string; readonly listenerOrigin: string },
    request: RemoteServerHostRequest,
  ) => Promise<Response>;
  readonly now?: () => number;
}

export type RemoteServerForwarderStart =
  | {
      readonly status: "listening";
      readonly port: number;
      /** The recorded port was taken, so pages opened before start with empty storage. */
      readonly moved: boolean;
    }
  | { readonly status: "refused"; readonly reason: "ports-taken"; readonly message: string };

export interface RemoteServerOpenedPage {
  readonly name: string;
  /** `http://<name>:<port>`. */
  readonly pageOrigin: string;
  /** The address the default browser opens once to receive the page's access cookie. */
  readonly claimUrl: () => string;
}

export interface RemoteServerForwarder {
  readonly start: () => Promise<RemoteServerForwarderStart>;
  /** Serves a granted server under its stable name. The forwarder must be listening. */
  readonly open: (target: RemoteServerPageTarget) => RemoteServerOpenedPage;
  /** The secret Octant's browser adds as a header, for exactly this origin. */
  readonly accessFor: (origin: string) => string | undefined;
  /** Stops serving every page of a host, as when it is removed or the device unpaired. */
  readonly closeHost: (hostId: string) => void;
  readonly stop: () => Promise<void>;
}

const CLAIM_TOKEN_TTL_MS = 2 * 60 * 1_000;
const CLAIM_BODY_BYTES = 256;
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;

interface ServedPage {
  readonly name: string;
  readonly hostId: string;
  hostName: string;
  listenerOrigin: string;
  grant: RemoteServerGrant;
  readonly secret: string;
  readonly claimTokens: Map<string, number>;
}

export function createRemoteServerForwarder(
  options: RemoteServerForwarderOptions,
): RemoteServerForwarder {
  const ports = options.ports ?? REMOTE_SERVER_FORWARDER_PORTS;
  const addresses = options.addresses ?? LOOPBACK_ADDRESSES;
  const now = options.now ?? (() => Date.now());
  const pages = new Map<string, ServedPage>();
  let servers: Server[] = [];
  let port: number | undefined;
  let starting: Promise<RemoteServerForwarderStart> | undefined;

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) refusalPage(response, 500, "Octant could not load this page.");
      else response.destroy();
    });
  };

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const page =
      port === undefined ? undefined : pages.get(hostOnly(request.headers.host ?? "", port));
    if (page === undefined || port === undefined) {
      refusalPage(response, 404, "Octant didn't open a page at this address.");
      return;
    }
    const pageOrigin = `http://${page.name}:${String(port)}`;
    const raw = request.url ?? "/";
    if (!raw.startsWith("/")) {
      refusalPage(response, 400, "Octant could not read this request.");
      return;
    }
    const url = new URL(`${pageOrigin}${raw}`);
    const secFetchSite = single(request.headers["sec-fetch-site"]);
    const origin = single(request.headers.origin);
    if (url.pathname === REMOTE_SERVER_PAGE_CLAIM_PATH) {
      await claim(request, response, page, { pageOrigin, secFetchSite, origin });
      return;
    }
    const presented =
      single(request.headers[REMOTE_SERVER_PAGE_ACCESS_HEADER]) ??
      remoteServerPageAccessCookie(single(request.headers.cookie));
    const admission = judgeRemoteServerPageRequest({
      pageOrigin,
      secFetchSite,
      origin,
      accessPresented: presented !== undefined && sameSecret(presented, page.secret),
    });
    if (admission.status === "refused") {
      refusalPage(
        response,
        403,
        admission.reason === "cross-site"
          ? "Octant refused a request another site sent to this page."
          : "Open this page again from Octant on this computer.",
      );
      return;
    }
    const body = await readBody(request, REMOTE_SERVER_PAGE_MAX_BODY_BYTES);
    if (body === "too-large") {
      refusalPage(
        response,
        413,
        `This upload is over the 8 MB Octant can send to ${page.hostName}.`,
      );
      return;
    }
    const method = (request.method ?? "GET").toUpperCase();
    const grantPath = `/api/server-proxy/${String(page.grant.grantId)}`;
    const pathQuery = `${grantPath}${url.pathname}${url.search}`;
    const signing = await options.sign({
      hostId: page.hostId,
      grantId: String(page.grant.grantId),
      method,
      pathQuery,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
    });
    if (signing.status === "refused") {
      refusalPage(
        response,
        503,
        signing.reason === "no-window"
          ? "Open an Octant window to keep this page connected."
          : accessEnded(page),
      );
      return;
    }
    const aborted = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) aborted.abort();
    });
    let answer: Response;
    try {
      answer = await options.sendToHost(
        { hostId: page.hostId, listenerOrigin: page.listenerOrigin },
        {
          method,
          pathQuery,
          headers: withSignature(
            remoteServerPageUpstreamHeaders({
              headers: headerPairs(request),
              pageOrigin,
              listenerOrigin: page.listenerOrigin,
              grantPath,
            }),
            signing.headers,
          ),
          body: method === "GET" || method === "HEAD" ? undefined : body,
          signal: aborted.signal,
        },
      );
    } catch {
      if (aborted.signal.aborted) return;
      refusalPage(
        response,
        502,
        `Can't reach ${page.hostName}. Check that it's on and on the same network.`,
      );
      return;
    }
    if (answer.headers.get(REMOTE_SERVER_PROXY_RELAYED_HEADER) !== REMOTE_SERVER_PROXY_RELAYED) {
      await hostRefusal(response, answer, page);
      return;
    }
    const headers = remoteServerPageResponseHeaders({
      headers: responsePairs(answer.headers),
      pageOrigin,
      upstreamPort: page.grant.port,
    });
    response.statusCode = answer.status;
    for (const [name, values] of groupHeaders(headers)) response.setHeader(name, values);
    await pipeBody(answer, response, method === "HEAD");
  };

  const claim = async (
    request: IncomingMessage,
    response: ServerResponse,
    page: ServedPage,
    facts: {
      readonly pageOrigin: string;
      readonly secFetchSite: string | undefined;
      readonly origin: string | undefined;
    },
  ): Promise<void> => {
    const judged = judgeRemoteServerPageRequest({ ...facts, accessPresented: true });
    if (judged.status === "refused") {
      refusalPage(response, 403, "Octant refused a request another site sent to this page.");
      return;
    }
    if (request.method === "GET") {
      claimPage(response);
      return;
    }
    // Only the claim page's own script posts here, so the browser names the
    // page's origin; a request without it is not that script.
    if (request.method !== "POST" || facts.origin !== facts.pageOrigin) {
      refusalPage(response, 403, "Open this page again from Octant on this computer.");
      return;
    }
    const body = await readBody(request, CLAIM_BODY_BYTES);
    const token = body === "too-large" ? "" : new TextDecoder().decode(body).trim();
    const expiresAt = page.claimTokens.get(token);
    page.claimTokens.delete(token);
    if (expiresAt === undefined || expiresAt < now()) {
      refusalPage(response, 403, "Open this page again from Octant on this computer.");
      return;
    }
    response.writeHead(204, {
      "cache-control": "no-store",
      "set-cookie": `${REMOTE_SERVER_PAGE_ACCESS_COOKIE}=${page.secret}; Path=/; HttpOnly; SameSite=Strict`,
    });
    response.end();
  };

  const listenAll = async (candidate: number): Promise<"listening" | "in-use"> => {
    const opened: Server[] = [];
    for (const address of addresses) {
      const server = createServer(handle);
      server.on("upgrade", refuseUpgrade);
      const outcome = await listen(server, candidate, address);
      if (outcome === "listening") {
        opened.push(server);
        continue;
      }
      if (outcome === "family-unavailable") continue;
      await Promise.all(opened.map(close));
      return "in-use";
    }
    if (opened.length === 0) return "in-use";
    servers = opened;
    return "listening";
  };

  const startOnce = async (): Promise<RemoteServerForwarderStart> => {
    const last = ports.first + ports.count - 1;
    const recorded =
      options.recordedPort !== undefined &&
      options.recordedPort >= ports.first &&
      options.recordedPort <= last
        ? options.recordedPort
        : undefined;
    const offset = recorded === undefined ? 0 : recorded - ports.first;
    for (let step = 0; step < ports.count; step += 1) {
      const candidate = ports.first + ((offset + step) % ports.count);
      if ((await listenAll(candidate)) === "listening") {
        port = candidate;
        return {
          status: "listening",
          port: candidate,
          moved: recorded !== undefined && candidate !== recorded,
        };
      }
    }
    return {
      status: "refused",
      reason: "ports-taken",
      message: `Octant can't open pages here: its local ports ${String(ports.first)}–${String(last)} are in use.`,
    };
  };

  return {
    start: async () => {
      if (port !== undefined) return { status: "listening", port, moved: false };
      starting ??= startOnce().finally(() => {
        starting = undefined;
      });
      return starting;
    },
    open: (target) => {
      if (port === undefined) throw new Error("The forwarder is not listening.");
      const listening = port;
      const digest = createHash("sha256")
        .update(
          remoteServerPageLabelInput({
            hostId: target.hostId,
            threadId: String(target.grant.threadId),
          }),
        )
        .digest();
      const name = remoteServerPageName({ port: target.grant.port, digest });
      const existing = pages.get(name);
      // Reopening the same server keeps its secret, so Octant's browser and a
      // default browser that already claimed the page keep reaching it.
      const page: ServedPage =
        existing !== undefined && existing.hostId === target.hostId
          ? existing
          : {
              name,
              hostId: target.hostId,
              hostName: target.hostName,
              listenerOrigin: target.listenerOrigin,
              grant: target.grant,
              secret: randomBytes(32).toString("base64url"),
              claimTokens: new Map(),
            };
      page.hostName = target.hostName;
      page.listenerOrigin = target.listenerOrigin;
      page.grant = target.grant;
      pages.set(name, page);
      const pageOrigin = `http://${name}:${String(listening)}`;
      return {
        name,
        pageOrigin,
        claimUrl: () => {
          const token = randomBytes(32).toString("base64url");
          for (const [held, expiresAt] of page.claimTokens) {
            if (expiresAt < now()) page.claimTokens.delete(held);
          }
          page.claimTokens.set(token, now() + CLAIM_TOKEN_TTL_MS);
          return `${pageOrigin}${REMOTE_SERVER_PAGE_CLAIM_PATH}#${token}`;
        },
      };
    },
    accessFor: (origin) => {
      if (port === undefined) return undefined;
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        return undefined;
      }
      if (url.protocol !== "http:" || url.origin !== origin) return undefined;
      return pages.get(hostOnly(url.host, port))?.secret;
    },
    closeHost: (hostId) => {
      for (const [name, page] of pages) if (page.hostId === hostId) pages.delete(name);
    },
    stop: async () => {
      const closing = servers;
      servers = [];
      port = undefined;
      pages.clear();
      await Promise.all(closing.map(close));
    },
  };
}

/** The page name a `Host` header names on the forwarder's port, or nothing. */
function hostOnly(host: string, port: number): string {
  const lowered = host.trim().toLowerCase();
  const suffix = `:${String(port)}`;
  return lowered.endsWith(suffix) ? lowered.slice(0, -suffix.length) : "";
}

function single(value: string | ReadonlyArray<string> | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function sameSecret(presented: string, secret: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(secret);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function headerPairs(request: IncomingMessage): ReadonlyArray<RemoteServerRelayHeader> {
  const pairs: RemoteServerRelayHeader[] = [];
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name !== undefined && value !== undefined) pairs.push([name, value]);
  }
  return pairs;
}

function responsePairs(headers: Headers): ReadonlyArray<RemoteServerRelayHeader> {
  const pairs: RemoteServerRelayHeader[] = [];
  headers.forEach((value, name) => {
    if (name !== "set-cookie") pairs.push([name, value]);
  });
  for (const cookie of headers.getSetCookie()) pairs.push(["set-cookie", cookie]);
  return pairs;
}

/**
 * Octant's signed headers replace the page's of the same name, and the proxy
 * session cookie joins the page's own cookies in one `Cookie` header.
 */
function withSignature(
  headers: ReadonlyArray<RemoteServerRelayHeader>,
  signed: Readonly<Record<string, string>>,
): ReadonlyArray<RemoteServerRelayHeader> {
  const signedNames = new Set(Object.keys(signed).map((name) => name.toLowerCase()));
  const merged: RemoteServerRelayHeader[] = [];
  let pageCookies: string | undefined;
  for (const [name, value] of headers) {
    if (name === "cookie") pageCookies = value;
    else if (!signedNames.has(name)) merged.push([name, value]);
  }
  for (const [rawName, value] of Object.entries(signed)) {
    const name = rawName.toLowerCase();
    merged.push([
      name,
      name === "cookie" && pageCookies !== undefined ? `${pageCookies}; ${value}` : value,
    ]);
  }
  if (!signedNames.has("cookie") && pageCookies !== undefined) merged.push(["cookie", pageCookies]);
  return merged;
}

function groupHeaders(
  headers: ReadonlyArray<RemoteServerRelayHeader>,
): ReadonlyMap<string, string | string[]> {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of headers) {
    const values = grouped.get(name) ?? [];
    values.push(value);
    grouped.set(name, values);
  }
  return new Map(
    [...grouped].map(([name, values]) => [name, values.length === 1 ? (values[0] ?? "") : values]),
  );
}

async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Uint8Array | "too-large"> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return "too-large";
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > limit) {
      request.resume();
      return "too-large";
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function pipeBody(answer: Response, response: ServerResponse, head: boolean): Promise<void> {
  const body = answer.body;
  if (body === null || head) {
    await body?.cancel();
    response.end();
    return;
  }
  const reader = body.getReader();
  response.on("close", () => {
    void reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value)) {
        await new Promise<void>((resolve) => {
          response.once("drain", resolve);
          response.once("close", resolve);
        });
      }
    }
    response.end();
  } catch {
    // The host cut the response short (a revoked grant, an idle dev server):
    // the page sees a truncated response rather than one that looks complete.
    response.destroy();
  }
}

async function hostRefusal(
  response: ServerResponse,
  answer: Response,
  page: ServedPage,
): Promise<void> {
  const body = (await answer.json().catch(() => ({}))) as {
    readonly reasonCode?: unknown;
    readonly kind?: unknown;
    readonly reason?: unknown;
  };
  if (answer.status === 401) {
    refusalPage(
      response,
      403,
      body.reasonCode === "revoked" || body.reasonCode === "expired"
        ? `This computer no longer has access to ${page.hostName}. Pair it again to open servers there.`
        : accessEnded(page),
    );
    return;
  }
  if (body.kind === "remote-server-proxy-refused") {
    refusalPage(
      response,
      410,
      `The server on port ${String(page.grant.port)} stopped or changed. Open it again from Running services.`,
    );
    return;
  }
  if (answer.status === 413) {
    refusalPage(response, 413, `This upload is over the 8 MB Octant can send to ${page.hostName}.`);
    return;
  }
  if (answer.status === 429 || answer.status === 503) {
    const retryAfter = answer.headers.get("retry-after");
    refusalPage(
      response,
      503,
      `${page.hostName} is busy with other requests from this computer. Try again in a moment.`,
      retryAfter === null ? {} : { "retry-after": retryAfter },
    );
    return;
  }
  refusalPage(
    response,
    502,
    `Can't reach ${page.hostName}. Check that it's on and on the same network.`,
  );
}

function accessEnded(page: ServedPage): string {
  return `This page's access to ${page.hostName} ended. Open it again from Running services.`;
}

const PAGE_STYLE =
  "body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#1d1d1f;background:#fff}p{max-width:32rem;padding:0 16px}@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f}}";

/** A page the forwarder answers itself; it runs no script and loads nothing. */
function refusalPage(
  response: ServerResponse,
  status: number,
  message: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    ...extra,
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Octant</title><style>${PAGE_STYLE}</style><p>${escapeHtml(message)}</p>`,
  );
}

/**
 * The default browser's one step to the access cookie: the token rides in the
 * fragment, which no request carries, and the page's own script posts it back
 * once, then leaves for the page.
 */
function claimPage(response: ServerResponse): void {
  const nonce = randomBytes(16).toString("base64");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'`,
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Octant</title><style>${PAGE_STYLE}</style><p id="m">Opening…</p>` +
      `<script nonce="${nonce}">const t=location.hash.slice(1);history.replaceState(null,"",location.pathname);` +
      `fetch(${JSON.stringify(REMOTE_SERVER_PAGE_CLAIM_PATH)},{method:"POST",body:t,headers:{"content-type":"text/plain"}})` +
      `.then(r=>{if(r.ok)location.replace("/");else document.getElementById("m").textContent="Open this page again from Octant on this computer."})` +
      `.catch(()=>{document.getElementById("m").textContent="Open this page again from Octant on this computer."});</script>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The host's proxy route does not carry WebSocket upgrades yet, so the page's
 * hot-reload socket is refused here rather than left hanging.
 */
function refuseUpgrade(_request: IncomingMessage, socket: Socket): void {
  socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function listen(
  server: Server,
  port: number,
  address: string,
): Promise<"listening" | "in-use" | "family-unavailable"> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve("in-use");
      else if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") {
        resolve("family-unavailable");
      } else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: address, exclusive: true, ipv6Only: address === "::1" });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
