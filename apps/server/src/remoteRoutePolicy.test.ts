import { describe, expect, it, vi } from "vitest";
import {
  createRemoteRouteHandler,
  createRemoteRoutePolicy,
  type RemoteRouteDefinition,
  type RemoteRouteResponse,
} from "./remoteRoutePolicy";

const origin = "https://octant.example:8443";
const authority = "octant.example:8443";

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", authority);
  return new Request(`${origin}${path}`, { ...init, headers });
}

function policy(overrides: Partial<Parameters<typeof createRemoteRoutePolicy>[0]> = {}) {
  return createRemoteRoutePolicy({
    origin,
    maxBodyBytes: 16,
    maxResponseBytes: 32,
    maxConcurrentRequests: 2,
    ...overrides,
  });
}

function handler(overrides: Partial<Parameters<typeof createRemoteRouteHandler>[0]> = {}) {
  const webAssets = vi.fn(async () => Response.json({ asset: true }));
  const preAuth = vi.fn(async () => Response.json({ hello: true }));
  const authenticatedProduct = vi.fn(async () => Response.json({ product: true }));
  const route = createRemoteRouteHandler({
    policy: policy(),
    webAssets,
    preAuth,
    authenticatedProduct,
    ...overrides,
  });
  return { route, webAssets, preAuth, authenticatedProduct };
}

describe("remote route policy", () => {
  it("accepts canonical HTTPS default port 443 while rejecting wrong authority", () => {
    const defaultOrigin = "https://octant.example";
    const requestFor = (url: string, host: string, requestOrigin: string) =>
      new Request(url, {
        headers: {
          host,
          origin: requestOrigin,
          "sec-fetch-site": "same-origin",
        },
      });

    expect(() => createRemoteRoutePolicy({ origin: defaultOrigin })).not.toThrow();
    expect(() => createRemoteRoutePolicy({ origin: "https://octant.example:443" })).not.toThrow();
    expect(() => createRemoteRoutePolicy({ origin: "http://octant.example:443" })).toThrow();
    expect(() => createRemoteRoutePolicy({ origin: "https://octant.example/route" })).toThrow();

    const policyFor443 = createRemoteRoutePolicy({ origin: defaultOrigin });
    expect(
      policyFor443.inspect(
        requestFor("https://octant.example/health", "octant.example", defaultOrigin),
      ),
    ).toMatchObject({ kind: "allow", surface: "pre-auth" });
    expect(
      policyFor443.inspect(
        requestFor("https://octant.example:443/health", "octant.example", defaultOrigin),
      ),
    ).toMatchObject({ kind: "allow", surface: "pre-auth" });
    expect(
      policyFor443.inspect(
        requestFor("https://octant.example:8443/health", "octant.example:8443", defaultOrigin),
      ),
    ).toMatchObject({ kind: "reject" });
    expect(
      policyFor443.inspect(
        requestFor("https://octant.example/health", "octant.example:8443", defaultOrigin),
      ),
    ).toMatchObject({ kind: "reject" });
  });

  it("dispatches only the bounded web, pre-auth, and authenticated product surfaces", async () => {
    const fixture = handler();

    const assetResponse = await fixture.route(request("/"));
    const healthResponse = await fixture.route(request("/health"));
    expect(assetResponse.status).toBe(200);
    expect(healthResponse.status).toBe(200);
    await assetResponse.arrayBuffer();
    await healthResponse.arrayBuffer();
    const productResponse = await fixture.route(
      request("/api/chat/bootstrap", {
        headers: { origin, "sec-fetch-site": "same-origin" },
      }),
    );
    expect(productResponse.status).toBe(200);
    await productResponse.arrayBuffer();
    expect(fixture.webAssets).toHaveBeenCalledOnce();
    expect(fixture.preAuth).toHaveBeenCalledOnce();
    expect(fixture.authenticatedProduct).toHaveBeenCalledOnce();
  });

  it("refuses framing of the served document through a response header", async () => {
    // The document carries the same policy in a `meta` element, but user agents
    // ignore `frame-ancestors` there by specification, so the header is the only
    // thing that actually refuses the frame. Web assets are the surface that
    // serves that document, and the other header cases here cover a preflight
    // and a product route instead.
    const fixture = handler();

    const response = await fixture.route(request("/"));

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(fixture.webAssets).toHaveBeenCalledOnce();
    await response.arrayBuffer();
  });

  it("admits bounded Code prompt evidence uploads to the authenticated product surface", async () => {
    const fixture = handler();
    const response = await fixture.route(
      request("/api/code/evidence", {
        method: "PUT",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "text/plain; charset=utf-8",
          "x-octant-code-thread-id": "60000000-0000-4000-8000-000000000001",
        },
        body: "Start Code",
      }),
    );

    expect(response.status).toBe(200);
    expect(fixture.authenticatedProduct).toHaveBeenCalledOnce();
  });

  it("admits bounded Automation Center reads and commands to the product surface", async () => {
    const fixture = handler();
    const list = await fixture.route(
      request("/api/automations/list?mode=all", {
        headers: { origin, "sec-fetch-site": "same-origin" },
      }),
    );
    const command = await fixture.route(
      request("/api/automations/commands", {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    const deleted = await fixture.route(
      request("/api/automations/commands", {
        method: "DELETE",
        headers: { origin, "sec-fetch-site": "same-origin" },
      }),
    );

    expect(list.status).toBe(200);
    expect(command.status).toBe(200);
    // Non-catalogued methods are rejected before reaching product dispatch.
    expect(deleted.status).toBe(405);
    expect(fixture.authenticatedProduct).toHaveBeenCalledTimes(2);
  });

  it("admits only the bounded GitHub authentication routes to the remote product surface", async () => {
    const fixture = handler();
    const snapshot = await fixture.route(
      request("/api/github/authentication", {
        headers: { origin, "sec-fetch-site": "same-origin" },
      }),
    );
    const command = await fixture.route(
      request("/api/github/authentication/commands", {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    const mutation = await fixture.route(
      request("/api/github/authentication", {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    const unknown = await fixture.route(
      request("/api/github/anything-else", {
        headers: { origin, "sec-fetch-site": "same-origin" },
      }),
    );

    expect(snapshot.status).toBe(200);
    expect(command.status).toBe(200);
    expect(mutation.status).toBe(405);
    expect(unknown.status).toBe(404);
    expect(fixture.authenticatedProduct).toHaveBeenCalledTimes(2);
  });

  it("keeps development bootstrap, desktop, and unknown API routes before product dispatch", async () => {
    const fixture = handler();

    for (const path of [
      "/api/shell/local-session",
      "/api/shell/launch-session",
      "/api/desktop/launch-sessions",
      "/api/desktop/window-authorities",
      "/api/host-control/status",
      "/api/host-control/lifecycle",
      "/api/host-control/backup",
      "/api/host-control/restore",
      "/api/host-control/thread-retention",
      "/api/host-control/thread-purge",
      "/api/host-control/data-map",
      "/api/missing",
    ]) {
      expect((await fixture.route(request(path, { method: "POST" }))).status).toBe(404);
    }

    expect(fixture.webAssets).not.toHaveBeenCalled();
    expect(fixture.preAuth).not.toHaveBeenCalled();
    expect(fixture.authenticatedProduct).not.toHaveBeenCalled();
  });

  it("exposes provider bootstrap read-only while keeping provider administration local-only", async () => {
    const fixture = handler();
    const bootstrap = await fixture.route(request("/api/providers/bootstrap"));
    const bootstrapMutation = await fixture.route(
      request("/api/providers/bootstrap", {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    await bootstrapMutation.arrayBuffer();
    const blocked: Response[] = [];
    for (const path of [
      "/api/providers/commands",
      "/api/providers/discovery/scan",
      "/api/providers/instance-1/packaged-smoke-turn",
      "/api/providers/instance-1/probe",
      "/api/providers/bootstrap?windowId=forbidden",
    ]) {
      const response = await fixture.route(
        request(path, {
          method: "POST",
          headers: {
            origin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      await response.arrayBuffer();
      blocked.push(response);
    }

    expect(bootstrap.status).toBe(200);
    await bootstrap.arrayBuffer();
    expect(bootstrapMutation.status).toBe(405);
    expect(blocked.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    expect(fixture.authenticatedProduct).toHaveBeenCalledOnce();
  });

  it("rejects authority confusion and forwarded identity before dispatch", async () => {
    const fixture = handler();

    const alternateHost = await fixture.route(
      request("/api/chat/bootstrap", {
        headers: { host: "other.example:8443", origin, "sec-fetch-site": "same-origin" },
      }),
    );
    const forwarded = await fixture.route(
      request("/api/chat/bootstrap", {
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          forwarded: "host=octant.example:8443",
        },
      }),
    );
    const crossSite = await fixture.route(
      request("/api/chat/bootstrap", {
        headers: { origin: "https://evil.example:8443", "sec-fetch-site": "cross-site" },
      }),
    );

    expect(alternateHost.status).toBe(400);
    expect(forwarded.status).toBe(400);
    expect(crossSite.status).toBe(403);
    expect(fixture.authenticatedProduct).not.toHaveBeenCalled();
  });

  it("allows only exact-origin preflight and never enables credentialed wildcard CORS", async () => {
    const fixture = handler();
    const response = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "OPTIONS",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, x-octant-csrf",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-octant-csrf");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(fixture.authenticatedProduct).not.toHaveBeenCalled();
  });

  it("routes the exact challenge/session boundary as bounded pre-auth POST routes", async () => {
    const fixture = handler();
    for (const path of ["/api/remote/auth/challenge", "/api/remote/auth/session"]) {
      const response = await fixture.route(
        request(path, {
          method: "POST",
          headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect(fixture.preAuth).toHaveBeenCalledTimes(2);

    const withQuery = await fixture.route(
      request("/api/remote/auth/challenge?ticket=1", {
        method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(withQuery.status).toBe(404);
    const withGet = await fixture.route(
      request("/api/remote/auth/session", { headers: { origin } }),
    );
    expect(withGet.status).toBe(405);
    const withText = await fixture.route(
      request("/api/remote/auth/challenge", {
        method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin", "content-type": "text/plain" },
        body: "x",
      }),
    );
    expect(withText.status).toBe(415);
    expect(fixture.preAuth).toHaveBeenCalledTimes(2);
  });

  it("allows only the single proof envelope header in authenticated preflight", async () => {
    const fixture = handler();
    const response = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "OPTIONS",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "content-type, x-octant-device-proof, x-octant-csrf, x-octant-command-id",
        },
      }),
    );
    expect(response.status).toBe(204);
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).toContain("x-octant-device-proof");
    expect(allowed).not.toContain("x-octant-request-nonce");
    expect(allowed).not.toContain("x-octant-request-timestamp");

    for (const legacy of ["x-octant-request-nonce", "x-octant-request-timestamp"]) {
      const rejected = await fixture.route(
        request("/api/chat/bootstrap", {
          method: "OPTIONS",
          headers: {
            origin,
            "sec-fetch-site": "same-origin",
            "access-control-request-method": "POST",
            "access-control-request-headers": `content-type, ${legacy}`,
          },
        }),
      );
      expect(rejected.status).toBe(403);
    }
  });

  it("rejects oversized requests and prevents a rejected response from leaking raw headers", async () => {
    const fixture = handler();
    const response = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-length": "17",
          "x-octant-private-header": "do-not-echo",
        },
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain("do-not-echo");
    expect(fixture.authenticatedProduct).not.toHaveBeenCalled();
  });

  it("bounds a Request.body even when Content-Length is absent", async () => {
    const fixture = handler();
    const response = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "POST",
        body: "0123456789abcdef0",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(413);
    expect(fixture.authenticatedProduct).not.toHaveBeenCalled();
  });

  it("rejects a streamed body when its actual bytes exceed the budget", async () => {
    const fixture = handler();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789abcdef0"));
        controller.close();
      },
    });
    const response = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "POST",
        body,
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    expect(fixture.authenticatedProduct).not.toHaveBeenCalled();
  });

  it("rejects a streamed body that exceeds an under-declared Content-Length", async () => {
    const fixture = handler();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789abcdef0"));
        controller.close();
      },
    });
    const response = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "POST",
        body,
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-length": "4",
          "content-type": "application/json",
        },
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    expect(fixture.authenticatedProduct).not.toHaveBeenCalled();
  });

  it("forwards an exact-boundary body through a bounded Request with security headers intact", async () => {
    const authenticatedProduct = vi.fn(async (received: Request) => {
      expect(received.headers.get("host")).toBe(authority);
      expect(received.headers.get("origin")).toBe(origin);
      expect(received.headers.get("x-octant-csrf")).toBe("csrf-proof");
      expect(received.headers.get("content-length")).toBe("16");
      expect(received.headers.get("transfer-encoding")).toBeNull();
      expect(await received.text()).toBe("0123456789abcdef");
      return Response.json({ product: true });
    });
    const route = createRemoteRouteHandler({
      policy: policy({ maxConcurrentRequests: 1 }),
      webAssets: async () => undefined,
      preAuth: async () => undefined,
      authenticatedProduct,
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789abcdef"));
        controller.close();
      },
    });
    const response = await route(
      request("/api/chat/bootstrap", {
        method: "POST",
        body,
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-length": "4",
          "transfer-encoding": "chunked",
          "content-type": "application/json",
          "x-octant-csrf": "csrf-proof",
        },
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(200);
    expect(authenticatedProduct).toHaveBeenCalledOnce();
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("releases the concurrency slot after request-body overflow", async () => {
    const fixture = handler({
      policy: policy({ maxConcurrentRequests: 1 }),
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789abcdef0"));
        controller.close();
      },
    });
    const rejected = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "POST",
        body,
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    const accepted = await fixture.route(request("/api/chat/bootstrap"));

    expect(rejected.status).toBe(413);
    expect(accepted.status).toBe(200);
    expect(fixture.authenticatedProduct).toHaveBeenCalledOnce();
  });

  it("releases the concurrency slot when request-body consumption aborts", async () => {
    const fixture = handler({
      policy: policy({ maxConcurrentRequests: 1 }),
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body aborted");
      },
    });
    const rejected = await fixture.route(
      request("/api/chat/bootstrap", {
        method: "POST",
        body,
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    const accepted = await fixture.route(request("/api/chat/bootstrap"));

    expect(rejected.status).toBe(400);
    expect(accepted.status).toBe(200);
  });

  it("rejects unsafe route registrations instead of allowing a local route by configuration", () => {
    expect(() =>
      createRemoteRoutePolicy({
        origin,
        authenticatedRoutes: [
          {
            id: "desktop-admin",
            match: { kind: "prefix", path: "/api/desktop/" },
            surface: "authenticated-product",
            methods: ["POST"],
          },
        ],
      }),
    ).toThrow("local-only");
    expect(() =>
      createRemoteRoutePolicy({
        origin,
        authenticatedRoutes: [
          {
            id: "host-control",
            match: { kind: "prefix", path: "/api/host-control" },
            surface: "authenticated-product",
            methods: ["POST"],
          },
        ],
      }),
    ).toThrow("local-only");
  });

  it("rejects invalid route budgets and clamps valid oversized budgets", () => {
    const baseRoute: Omit<RemoteRouteDefinition, "maxBodyBytes" | "maxResponseBytes"> = {
      id: "custom",
      match: { kind: "exact", path: "/api/custom" },
      surface: "authenticated-product",
      methods: ["GET", "POST"],
    };
    for (const field of ["maxBodyBytes", "maxResponseBytes"] as const) {
      for (const value of [Number.NaN, 0, -1]) {
        expect(() =>
          createRemoteRoutePolicy({
            origin,
            authenticatedRoutes: [{ ...baseRoute, [field]: value }],
          }),
        ).toThrow("invalid");
      }
    }

    const boundedPolicy = createRemoteRoutePolicy({
      origin,
      maxBodyBytes: 16,
      maxResponseBytes: 32,
      authenticatedRoutes: [
        {
          ...baseRoute,
          maxBodyBytes: 64,
          maxResponseBytes: 64,
        },
      ],
    });
    const bodyDecision = boundedPolicy.inspect(
      request("/api/custom", {
        method: "POST",
        headers: { "content-length": "17", "content-type": "application/json" },
      }),
    );
    const responseDecision = boundedPolicy.inspect(request("/api/custom"));

    expect(bodyDecision.kind).toBe("reject");
    if (bodyDecision.kind === "reject") expect(bodyDecision.response.status).toBe(413);
    expect(responseDecision.kind).toBe("allow");
    if (responseDecision.kind === "allow") {
      expect(responseDecision.maxBodyBytes).toBe(16);
      expect(responseDecision.maxResponseBytes).toBe(32);
    }
  });

  it("bounds a streamed response and releases the request slot after completion", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789"));
        controller.close();
      },
    });
    const product = vi.fn(
      async (): Promise<RemoteRouteResponse> =>
        new Response(stream, { headers: { "content-type": "application/x-ndjson" } }),
    );
    const route = createRemoteRouteHandler({
      policy: policy({ maxConcurrentRequests: 1, maxResponseBytes: 4 }),
      webAssets: async () => undefined,
      preAuth: async () => undefined,
      authenticatedProduct: product,
    });

    const response = await route(
      request("/api/chat/bootstrap", {
        headers: { origin, "sec-fetch-site": "same-origin" },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeLessThanOrEqual(4);
    expect(product).toHaveBeenCalledOnce();
  });

  it("releases the concurrency slot when the response consumer cancels", async () => {
    let closeSource: (() => void) | undefined;
    const product = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          closeSource = () => controller.close();
        },
      });
      return new Response(stream);
    });
    const route = createRemoteRouteHandler({
      policy: policy({ maxConcurrentRequests: 1 }),
      webAssets: async () => undefined,
      preAuth: async () => undefined,
      authenticatedProduct: product,
    });

    const response = await route(request("/api/chat/bootstrap"));
    await response.body?.cancel();
    const next = await route(request("/api/chat/bootstrap"));
    closeSource?.();

    expect(next.status).toBe(200);
    expect(product).toHaveBeenCalledTimes(2);
  });
});
