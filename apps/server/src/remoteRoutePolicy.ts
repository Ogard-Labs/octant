const DEFAULT_BODY_BYTES = 1_048_576;
const DEFAULT_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_CONCURRENT_REQUESTS = 32;

const REMOTE_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "x-octant-command-id",
  "x-octant-csrf",
  "x-octant-device-proof",
] as const;

const REMOTE_CONTENT_TYPES = [
  "application/json",
  "application/x-ndjson",
  "application/octet-stream",
] as const;

const LOCAL_ONLY_PREFIXES = [
  "/api/desktop",
  "/api/shell",
  "/api/folders",
  "/api/extensions/lifecycle",
  "/api/extensions/skills",
  "/api/providers/discovery",
  "/api/host-control",
] as const;

export const REMOTE_PROTOCOL_ROUTE_IDS = {
  hello: "remote-protocol-hello",
  pairing: "remote-protocol-pairing",
  pairingStatus: "remote-protocol-pairing-status",
  negotiate: "remote-protocol-negotiate",
} as const;

const DEFAULT_PRE_AUTH_ROUTES: readonly RemoteRouteDefinition[] = [
  {
    id: "health",
    match: { kind: "exact", path: "/health" },
    surface: "pre-auth",
    methods: ["GET", "HEAD"],
    allowQuery: false,
    allowedRequestHeaders: [],
  },
  {
    id: "hosts",
    match: { kind: "exact", path: "/api/hosts" },
    surface: "pre-auth",
    methods: ["GET", "HEAD"],
    allowQuery: false,
    allowedRequestHeaders: [],
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.hello,
    match: { kind: "exact", path: "/api/remote/hello" },
    surface: "pre-auth",
    methods: ["GET", "HEAD"],
    allowQuery: false,
    allowedRequestHeaders: [],
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.pairing,
    match: { kind: "exact", path: "/api/remote/pairing" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.pairingStatus,
    match: { kind: "exact", path: "/api/remote/pairing/status" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: REMOTE_PROTOCOL_ROUTE_IDS.negotiate,
    match: { kind: "exact", path: "/api/remote/negotiate" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 8_192,
  },
  {
    id: "remote-auth-challenge",
    match: { kind: "exact", path: "/api/remote/auth/challenge" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-session",
    match: { kind: "exact", path: "/api/remote/auth/session" },
    surface: "pre-auth",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: ["content-type"],
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 8_192,
  },
];

const DEFAULT_AUTHENTICATED_SERVICE_ROUTES: readonly RemoteRouteDefinition[] = [
  {
    id: "remote-auth-device",
    match: { kind: "exact", path: "/api/remote/auth/device" },
    surface: "authenticated-product",
    methods: ["GET", "HEAD"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-sign-out",
    match: { kind: "exact", path: "/api/remote/auth/sign-out" },
    surface: "authenticated-product",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-rotate-key",
    match: { kind: "exact", path: "/api/remote/auth/rotate-key" },
    surface: "authenticated-product",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-revoke-self",
    match: { kind: "exact", path: "/api/remote/auth/revoke-self" },
    surface: "authenticated-product",
    methods: ["POST"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 4_096,
    maxResponseBytes: 4_096,
  },
  {
    id: "remote-auth-push-token",
    match: { kind: "exact", path: "/api/remote/auth/push-token" },
    surface: "authenticated-product",
    methods: ["PUT", "DELETE"],
    allowQuery: false,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"],
    maxBodyBytes: 8_192,
    maxResponseBytes: 4_096,
  },
];

const DEFAULT_AUTHENTICATED_ROUTE_MATCHES = [
  {
    kind: "exact" as const,
    path: "/api/github/authentication",
    methods: ["GET", "HEAD"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    maxResponseBytes: 4_096,
  },
  {
    kind: "exact" as const,
    path: "/api/github/authentication/commands",
    methods: ["POST"] as const,
    allowedRequestHeaders: REMOTE_REQUEST_HEADERS,
    allowedContentTypes: ["application/json"] as const,
    maxBodyBytes: 16 * 1_024,
    maxResponseBytes: 4_096,
  },
  {
    kind: "exact" as const,
    path: "/api/providers/bootstrap",
    methods: ["GET", "HEAD"] as const,
  },
  {
    kind: "exact" as const,
    path: "/api/code/evidence",
    methods: ["PUT"] as const,
    allowedRequestHeaders: [...REMOTE_REQUEST_HEADERS, "x-octant-code-thread-id"] as const,
    allowedContentTypes: ["text/plain"] as const,
    maxBodyBytes: 64 * 1_024,
  },
  {
    kind: "exact" as const,
    path: "/api/usage/dashboard",
    methods: ["POST"] as const,
  },
  {
    kind: "exact" as const,
    path: "/api/usage/query",
    methods: ["POST"] as const,
  },
  {
    kind: "exact" as const,
    path: "/api/usage/export",
    methods: ["POST"] as const,
  },
  ...[
    "/api/agent-profiles",
    "/api/apple/",
    "/api/automations/",
    "/api/browser/",
    "/api/chat/",
    "/api/code/",
    "/api/computer-use/",
    "/api/context/",
    "/api/work/",
    "/api/extensions/catalog",
    "/api/extensions/inspect",
    "/api/extensions/preview",
    "/api/extensions/snapshot",
    "/api/extensions/state",
    "/api/preview/",
    "/api/canvas/",
    "/api/projects/",
    "/api/theme/",
    "/api/validation/",
    "/api/zen",
  ].map((path) => ({
    kind: "prefix" as const,
    path,
    methods: ["GET", "HEAD", "POST"] as const,
  })),
].map((match) => {
  return {
    id: `product-${match.path.slice(5).replaceAll("/", "-") || "root"}`,
    match: { kind: match.kind, path: match.path },
    surface: "authenticated-product" as const,
    methods: match.methods,
    allowedRequestHeaders:
      "allowedRequestHeaders" in match ? match.allowedRequestHeaders : REMOTE_REQUEST_HEADERS,
    allowedContentTypes:
      "allowedContentTypes" in match ? match.allowedContentTypes : REMOTE_CONTENT_TYPES,
    ...("maxBodyBytes" in match ? { maxBodyBytes: match.maxBodyBytes } : {}),
    allowQuery: match.kind === "prefix",
  };
});

const DEFAULT_AUTHENTICATED_ROUTES: readonly RemoteRouteDefinition[] = [
  ...DEFAULT_AUTHENTICATED_SERVICE_ROUTES,
  ...DEFAULT_AUTHENTICATED_ROUTE_MATCHES,
];

/** The product and remote-auth routes the private listener forwards by default. */
export function listDefaultRemoteAuthenticatedRoutes(): readonly RemoteRouteDefinition[] {
  return DEFAULT_AUTHENTICATED_ROUTES;
}

type RemoteHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
type RemoteRouteSurface = "pre-auth" | "authenticated-product";
type RemoteRouteMatch =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "prefix"; readonly path: string };

export interface RemoteRouteDefinition {
  readonly id: string;
  readonly match: RemoteRouteMatch;
  readonly surface: RemoteRouteSurface;
  readonly methods: readonly RemoteHttpMethod[];
  readonly allowedRequestHeaders?: readonly string[];
  readonly allowedContentTypes?: readonly string[];
  readonly allowQuery?: boolean;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
}

export type RemoteRouteResponse = Response | undefined;

export interface RedactedRemoteRequestFacts {
  readonly method: string;
  readonly surface: "web-assets" | RemoteRouteSurface | "local-only" | "unknown";
  readonly authority: "matched" | "mismatched";
  readonly origin: "absent" | "matched" | "mismatched";
  readonly forwardedHeaders: boolean;
}

export type RemoteRouteDecision =
  | {
      readonly kind: "allow";
      readonly surface: "web-assets" | RemoteRouteSurface;
      readonly route?: RemoteRouteDefinition;
      readonly headers: Headers;
      readonly maxBodyBytes: number;
      readonly maxResponseBytes: number;
      readonly facts: RedactedRemoteRequestFacts;
    }
  | {
      readonly kind: "preflight";
      readonly headers: Headers;
      readonly facts: RedactedRemoteRequestFacts;
    }
  | {
      readonly kind: "reject";
      readonly response: Response;
      readonly facts: RedactedRemoteRequestFacts;
    };

export interface RemoteRoutePolicyOptions {
  readonly origin: string;
  readonly preAuthRoutes?: readonly RemoteRouteDefinition[];
  readonly authenticatedRoutes?: readonly RemoteRouteDefinition[];
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxConcurrentRequests?: number;
}

export interface RemoteRoutePolicy {
  readonly inspect: (request: Request) => RemoteRouteDecision;
  readonly acquire: () => (() => void) | undefined;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
}

export interface RemoteRouteHandlerOptions {
  readonly policy: RemoteRoutePolicy;
  readonly webAssets: (request: Request) => RemoteRouteResponse | Promise<RemoteRouteResponse>;
  readonly preAuth: (
    request: Request,
    route: RemoteRouteDefinition,
    facts?: RemoteRouteFacts,
  ) => RemoteRouteResponse | Promise<RemoteRouteResponse>;
  readonly authenticatedProduct: (
    request: Request,
    route: RemoteRouteDefinition,
    facts?: RemoteRouteFacts,
  ) => RemoteRouteResponse | Promise<RemoteRouteResponse>;
}

/**
 * Transport facts passed through to route handlers by the facts-aware route
 * handler. The gateway derives these from the accepted socket so protocol and
 * authentication handlers receive the trusted source class without reading
 * headers.
 */
export interface RemoteRouteFacts {
  readonly sourceClass: "loopback" | "lan-private" | "tailscale" | "unknown";
  readonly sourceKey: string;
}

export const REMOTE_SECURITY_POLICY = {
  hsts: "max-age=31536000; includeSubDomains",
  csp: "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  nosniff: "nosniff",
  referrer: "no-referrer",
} as const;

export function createRemoteRoutePolicy(options: RemoteRoutePolicyOptions): RemoteRoutePolicy {
  const parsedOrigin = parseRemoteOrigin(options.origin);
  const preAuthRoutes = validateRoutes(
    options.preAuthRoutes ?? DEFAULT_PRE_AUTH_ROUTES,
    "pre-auth",
  );
  const authenticatedRoutes = validateRoutes(
    options.authenticatedRoutes ?? DEFAULT_AUTHENTICATED_ROUTES,
    "authenticated-product",
  );
  const routes = [...preAuthRoutes, ...authenticatedRoutes];
  const maxBodyBytes = boundedPositiveInteger(
    options.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    "remote request body budget",
  );
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
    "remote response stream budget",
  );
  const maxConcurrentRequests = boundedPositiveInteger(
    options.maxConcurrentRequests ?? DEFAULT_CONCURRENT_REQUESTS,
    "remote concurrency budget",
  );
  let activeRequests = 0;

  return {
    maxBodyBytes,
    maxResponseBytes,
    acquire: () => {
      if (activeRequests >= maxConcurrentRequests) return undefined;
      activeRequests += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeRequests -= 1;
      };
    },
    inspect: (request) =>
      inspectRequest(request, parsedOrigin, routes, maxBodyBytes, maxResponseBytes),
  };
}

export function createRemoteRouteHandler(
  options: RemoteRouteHandlerOptions,
): (request: Request, facts?: RemoteRouteFacts) => Promise<Response> {
  return async (request, facts) => {
    const decision = options.policy.inspect(request);
    if (decision.kind === "reject") return decision.response;
    if (decision.kind === "preflight")
      return new Response(null, { status: 204, headers: decision.headers });

    const release = options.policy.acquire();
    if (release === undefined) {
      return rejectionResponse(429, decision.headers);
    }
    let prepared: PreparedRequestResult;
    try {
      prepared = await prepareRequestBody(request, decision.maxBodyBytes);
    } catch {
      release();
      return rejectionResponse(400, decision.headers);
    }
    if (prepared.kind !== "prepared") {
      release();
      return rejectionResponse(prepared.status, decision.headers);
    }
    let response: RemoteRouteResponse;
    try {
      if (decision.surface === "web-assets") {
        response = await options.webAssets(prepared.request);
      } else if (decision.surface === "pre-auth") {
        response = await options.preAuth(
          prepared.request,
          decision.route as RemoteRouteDefinition,
          facts,
        );
      } else {
        response = await options.authenticatedProduct(
          prepared.request,
          decision.route as RemoteRouteDefinition,
          facts,
        );
      }
    } catch {
      release();
      return rejectionResponse(503, decision.headers);
    }
    if (response === undefined) {
      release();
      return rejectionResponse(404, decision.headers);
    }
    return limitResponse(response, decision.headers, decision.maxResponseBytes, release);
  };
}

function inspectRequest(
  request: Request,
  origin: URL,
  routes: readonly RemoteRouteDefinition[],
  defaultMaxBodyBytes: number,
  defaultMaxResponseBytes: number,
): RemoteRouteDecision {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const headerOrigin = request.headers.get("origin");
  const authorityMatched = request.headers.get("host") === origin.host;
  const originMatched = headerOrigin === null || headerOrigin === origin.origin;
  const forwardedHeaders = hasForwardedIdentity(request.headers);
  const pathSurface = classifyPath(url.pathname, routes);
  const facts: RedactedRemoteRequestFacts = {
    method,
    surface: pathSurface,
    authority: authorityMatched ? "matched" : "mismatched",
    origin: headerOrigin === null ? "absent" : originMatched ? "matched" : "mismatched",
    forwardedHeaders,
  };

  if (url.protocol !== "https:" || url.origin !== origin.origin || !authorityMatched) {
    return reject(400, facts);
  }
  if (forwardedHeaders) return reject(400, facts);
  if (!originMatched || headerOrigin === "null") return reject(403, facts);

  const fetchSite = normalizedHeader(request.headers, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return reject(403, facts);
  }

  if (method === "OPTIONS") {
    const route = routes.find((candidate) => matches(candidate.match, url.pathname));
    if (route === undefined || headerOrigin === null || !routeAllowsQuery(route, url)) {
      return reject(404, facts);
    }
    return inspectPreflight(request, route, facts, origin.origin);
  }

  if (pathSurface === "local-only" || pathSurface === "unknown") return reject(404, facts);
  if (pathSurface === "web-assets") {
    if (method !== "GET" && method !== "HEAD") return reject(405, facts);
    if (hasBody(request)) return reject(413, facts);
    return allow(
      "web-assets",
      undefined,
      facts,
      remoteHeaders(headerOrigin === null ? undefined : headerOrigin, []),
      defaultMaxBodyBytes,
      defaultMaxResponseBytes,
    );
  }

  const route = routes.find((candidate) => matches(candidate.match, url.pathname));
  if (route === undefined || !routeAllowsQuery(route, url)) return reject(404, facts);
  if (!route.methods.includes(method as RemoteHttpMethod)) return reject(405, facts);
  const bodyLimit = Math.min(route.maxBodyBytes ?? defaultMaxBodyBytes, defaultMaxBodyBytes);
  if (
    declaredBodyBytes(request) > bodyLimit ||
    (hasBody(request) && (method === "GET" || method === "HEAD"))
  ) {
    return reject(413, facts);
  }
  if (hasBody(request) && !contentTypeAllowed(request, route)) return reject(415, facts);
  return allow(
    route.surface,
    route,
    facts,
    remoteHeaders(
      headerOrigin === null ? undefined : headerOrigin,
      route.allowedRequestHeaders ?? REMOTE_REQUEST_HEADERS,
    ),
    bodyLimit,
    Math.min(route.maxResponseBytes ?? defaultMaxResponseBytes, defaultMaxResponseBytes),
  );
}

function inspectPreflight(
  request: Request,
  route: RemoteRouteDefinition,
  facts: RedactedRemoteRequestFacts,
  origin: string,
): RemoteRouteDecision {
  const requestedMethod = normalizedHeader(
    request.headers,
    "access-control-request-method",
  )?.toUpperCase();
  const requestedHeaders = parseHeaderList(request.headers.get("access-control-request-headers"));
  const allowedHeaders = new Set(
    (route.allowedRequestHeaders ?? REMOTE_REQUEST_HEADERS).map((header) => header.toLowerCase()),
  );
  if (
    requestedMethod === undefined ||
    !route.methods.includes(requestedMethod as RemoteHttpMethod) ||
    requestedHeaders.some((header) => !allowedHeaders.has(header))
  ) {
    return reject(403, facts);
  }
  return {
    kind: "preflight",
    headers: remoteHeaders(origin, [...allowedHeaders].sort(), route.methods),
    facts,
  };
}

function classifyPath(
  pathname: string,
  routes: readonly RemoteRouteDefinition[],
): RedactedRemoteRequestFacts["surface"] {
  if (LOCAL_ONLY_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix)))
    return "local-only";
  const route = routes.find((candidate) => matches(candidate.match, pathname));
  if (route !== undefined) return route.surface;
  if (pathname.startsWith("/api/")) return "unknown";
  return "web-assets";
}

function validateRoutes(
  routes: readonly RemoteRouteDefinition[],
  surface: RemoteRouteSurface,
): readonly RemoteRouteDefinition[] {
  const ids = new Set<string>();
  for (const route of routes) {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(route.id) ||
      ids.has(route.id) ||
      route.surface !== surface ||
      !route.match.path.startsWith("/") ||
      route.match.path.includes("..") ||
      route.match.path.includes("?") ||
      route.match.path.includes("#") ||
      route.match.path === "/api/" ||
      route.methods.length === 0 ||
      !validRouteBudget(route.maxBodyBytes) ||
      !validRouteBudget(route.maxResponseBytes) ||
      (surface === "authenticated-product" && !route.match.path.startsWith("/api/")) ||
      isLocalOnlyMatch(route.match)
    ) {
      throw new Error("Remote route definition is invalid or local-only.");
    }
    ids.add(route.id);
  }
  return routes;
}

function validRouteBudget(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function isLocalOnlyMatch(match: RemoteRouteMatch): boolean {
  return LOCAL_ONLY_PREFIXES.some((prefix) => pathMatchesPrefix(match.path, prefix));
}

function parseRemoteOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("Remote origin is invalid.");
  }
  const effectivePort = origin.port === "" && origin.protocol === "https:" ? "443" : origin.port;
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    effectivePort === ""
  ) {
    throw new Error("Remote origin must be an explicit HTTPS origin.");
  }
  return origin;
}

function matches(match: RemoteRouteMatch, pathname: string): boolean {
  return match.kind === "exact" ? pathname === match.path : pathMatchesPrefix(pathname, match.path);
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  const boundary = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === boundary || pathname.startsWith(`${boundary}/`);
}

function routeAllowsQuery(route: RemoteRouteDefinition, url: URL): boolean {
  return route.allowQuery === true || url.search === "";
}

function contentTypeAllowed(request: Request, route: RemoteRouteDefinition): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (route.allowedContentTypes ?? REMOTE_CONTENT_TYPES).includes(mediaType as never);
}

function declaredBodyBytes(request: Request): number {
  const value = request.headers.get("content-length");
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function hasBody(request: Request): boolean {
  return (
    request.body !== null ||
    declaredBodyBytes(request) > 0 ||
    request.headers.has("transfer-encoding")
  );
}

type PreparedRequestResult =
  | { readonly kind: "prepared"; readonly request: Request }
  | { readonly kind: "too-large"; readonly status: 413 }
  | { readonly kind: "aborted"; readonly status: 400 };

async function prepareRequestBody(
  request: Request,
  maxBodyBytes: number,
): Promise<PreparedRequestResult> {
  const declared = declaredBodyBytes(request);
  if (declared > maxBodyBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { kind: "too-large", status: 413 };
  }
  if (request.body === null) return { kind: "prepared", request };
  if (request.bodyUsed) {
    await request.body.cancel().catch(() => undefined);
    return { kind: "aborted", status: 400 };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    await request.body.cancel().catch(() => undefined);
    return { kind: "aborted", status: 400 };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done || next.value === undefined) break;
      if (total + next.value.byteLength > maxBodyBytes) {
        await reader.cancel();
        return { kind: "too-large", status: 413 };
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { kind: "aborted", status: 400 };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const headers = new Headers(request.headers);
    headers.delete("transfer-encoding");
    headers.set("content-length", String(total));
    const boundedInit: RequestInit = { body, headers };
    return { kind: "prepared", request: new Request(request, boundedInit) };
  } catch {
    return { kind: "aborted", status: 400 };
  }
}

function hasForwardedIdentity(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "forwarded" ||
      normalized === "x-real-ip" ||
      normalized === "x-client-cert" ||
      normalized === "x-forwarded-client-cert" ||
      normalized === "ssl-client-cert" ||
      normalized.startsWith("x-forwarded-")
    ) {
      return true;
    }
  }
  return false;
}

function normalizedHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null ? undefined : value.trim().toLowerCase();
}

function parseHeaderList(value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  return value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0);
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid.`);
  return value;
}

function allow(
  surface: "web-assets" | RemoteRouteSurface,
  route: RemoteRouteDefinition | undefined,
  facts: RedactedRemoteRequestFacts,
  headers: Headers,
  maxBodyBytes: number,
  maxResponseBytes: number,
): RemoteRouteDecision {
  return {
    kind: "allow",
    surface,
    ...(route === undefined ? {} : { route }),
    headers,
    maxBodyBytes,
    maxResponseBytes,
    facts,
  };
}

function reject(status: number, facts: RedactedRemoteRequestFacts): RemoteRouteDecision {
  return {
    kind: "reject",
    response: rejectionResponse(status, remoteHeaders(undefined, [])),
    facts,
  };
}

function rejectionResponse(status: number, headers: Headers): Response {
  return Response.json(
    {
      product: "Octant",
      status: "rejected",
      category: "invalid",
      message: "Remote request rejected.",
    },
    { status, headers },
  );
}

function remoteHeaders(
  origin: string | undefined,
  allowedHeaders: readonly string[],
  methods: readonly string[] = [],
): Headers {
  const headers = new Headers({
    "content-security-policy": REMOTE_SECURITY_POLICY.csp,
    "referrer-policy": REMOTE_SECURITY_POLICY.referrer,
    "strict-transport-security": REMOTE_SECURITY_POLICY.hsts,
    vary: "Origin",
    "x-content-type-options": REMOTE_SECURITY_POLICY.nosniff,
  });
  if (origin !== undefined) headers.set("access-control-allow-origin", origin);
  if (allowedHeaders.length > 0)
    headers.set("access-control-allow-headers", allowedHeaders.join(", "));
  if (methods.length > 0) headers.set("access-control-allow-methods", methods.join(", "));
  return headers;
}

function limitResponse(
  response: Response,
  securityHeaders: Headers,
  maxBytes: number,
  release: () => void,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of securityHeaders) headers.set(name, value);
  if (response.body === null) {
    release();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  headers.delete("content-length");
  const reader = response.body.getReader();
  let total = 0;
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done || next.value === undefined) {
          finish();
          controller.close();
          return;
        }
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          await reader.cancel();
          finish();
          controller.close();
          return;
        }
        const chunk =
          next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
        total += chunk.byteLength;
        controller.enqueue(chunk);
        if (total >= maxBytes) {
          await reader.cancel();
          finish();
          controller.close();
        }
      } catch {
        finish();
        controller.error(new Error("Remote response stream exceeded its budget."));
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      finish();
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
