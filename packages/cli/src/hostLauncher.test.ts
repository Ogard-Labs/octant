import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { decodeWindowId, type WindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  attachOrCreateHost,
  createDefaultServicePolicyStore,
  resolveDefaultServerRoot,
  type HostLauncherDependencies,
  type HostLauncherResult,
} from "./hostLauncher";

it("resolves the source server root as a filesystem path", () => {
  expect(resolveDefaultServerRoot()).not.toMatch(/^file:/);
  expect(resolveDefaultServerRoot()).toMatch(/\/apps\/server$/);
});

it("constructs the persisted owner-only service policy store", () => {
  const store = createDefaultServicePolicyStore();
  expect(store.path.endsWith("service-policy.json")).toBe(true);
  expect(isAbsolute(store.path)).toBe(true);
});

const bridgeSecret = `${"S".repeat(42)}A`;
const windowId: WindowId = decodeWindowId(randomUUID());
const capability = `${"C".repeat(42)}A`;

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

function deps(overrides: Partial<HostLauncherDependencies> = {}): HostLauncherDependencies {
  return {
    bridgeSecret,
    hostname: "127.0.0.1",
    port: 13773,
    fetch: mockFetch(async () => new Response("not found", { status: 404 })),
    spawn: vi.fn(),
    waitForHost: vi.fn(async () => ({
      status: "ready" as const,
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
    })),
    ...overrides,
  };
}

describe("attachOrCreateHost", () => {
  it("attaches to an existing healthy host without spawning", async () => {
    const fetch = mockFetch(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            product: "Octant",
            status: "ok",
            storage: "ready",
            version: "0.0.0-dev",
            instanceId: "instance-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const spawn = vi.fn();
    const result = await attachOrCreateHost(deps({ fetch, spawn }));
    expect(result.kind).toBe("attached");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns a host when no healthy host is reachable", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const spawn = vi.fn();
    const waitForHost = vi.fn(async () => ({
      status: "ready" as const,
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-2",
      version: "0.0.0-dev",
    }));
    const result = await attachOrCreateHost(deps({ fetch, spawn, waitForHost }));
    expect(result.kind).toBe("started");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bun",
        args: ["run", "--cwd", resolveDefaultServerRoot(), "start"],
      }),
    );
  });

  it("does not automatically spawn when the persisted service policy is disabled", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const spawn = vi.fn();
    const policyStore = {
      read: vi.fn(async () => ({
        schemaVersion: 1 as const,
        enabled: false,
        updatedAt: "2026-08-10T10:00:00.000Z",
      })),
    };

    const result = await attachOrCreateHost({
      ...deps({ fetch, spawn }),
      policyStore,
    } as HostLauncherDependencies & { readonly policyStore: typeof policyStore });

    expect(result).toMatchObject({ kind: "disabled" });
    expect(spawn).not.toHaveBeenCalled();
    expect(policyStore.read).toHaveBeenCalledOnce();
  });

  it("adopts a winning host on a different port after its spawned child attaches", async () => {
    const winnerUrl = new URL("http://127.0.0.1:4000/");
    const resolveAttachedHost = vi.fn(async () => ({
      url: winnerUrl,
      instanceId: "foreground-winner",
    }));
    const waitForHost = vi.fn(async (options) => {
      expect(await options.resolveAttachedHost?.()).toEqual({
        url: winnerUrl,
        instanceId: "foreground-winner",
      });
      return {
        status: "ready" as const,
        url: winnerUrl,
        instanceId: "foreground-winner",
        version: "0.0.0-dev",
      };
    });

    const result = await attachOrCreateHost(deps({ resolveAttachedHost, waitForHost }));

    expect(result).toMatchObject({
      kind: "started",
      url: winnerUrl,
      instanceId: "foreground-winner",
    });
    expect(waitForHost).toHaveBeenCalledWith(
      expect.objectContaining({ resolveAttachedHost: expect.any(Function) }),
    );
  });

  it("does not adopt a recovered endpoint whose live instance differs from its receipt", async () => {
    const winnerUrl = new URL("http://127.0.0.1:4000/");
    const fetch = mockFetch(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.port === "4000") {
        return Response.json({
          product: "Octant",
          status: "ok",
          storage: "ready",
          instanceId: "unrelated-instance",
        });
      }
      throw new Error("not ready");
    });

    const { waitForHost: _defaultTestWait, ...dependencies } = deps({
      fetch,
      readyTimeoutMs: 20,
      resolveAttachedHost: async () => ({
        url: winnerUrl,
        instanceId: "expected-winner",
      }),
    });
    const result = await attachOrCreateHost(dependencies);

    expect(result).toMatchObject({ kind: "start-failed" });
  });

  it("passes the development web bootstrap only to a freshly spawned dev host", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const spawn = vi.fn();
    await attachOrCreateHost(
      deps({
        fetch,
        spawn,
        developmentWebBootstrap: true,
        waitForHost: vi.fn(async () => ({
          status: "ready" as const,
          url: new URL("http://127.0.0.1:13773"),
          developmentWebBootstrap: true,
        })),
      }),
    );

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ OCTANT_DEV_WEB_BOOTSTRAP: "1" }),
      }),
    );
  });

  it("reports a disabled host when storage is not ready", async () => {
    const fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            product: "Octant",
            status: "ok",
            storage: "starting",
            version: "0.0.0-dev",
            instanceId: "instance-3",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await attachOrCreateHost(deps({ fetch }));
    expect(result.kind).toBe("disabled");
  });

  it("treats a non-Octant health response as unreachable so the bridge secret is not leaked", async () => {
    const fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ product: "OtherApp", status: "ok", storage: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const spawn = vi.fn();
    const waitForHost = vi.fn(async () => ({ status: "timeout" as const }));
    const result = await attachOrCreateHost(deps({ fetch, spawn, waitForHost }));
    expect(result.kind).not.toBe("attached");
    expect(spawn).toHaveBeenCalled();
  });

  it("reports a port-conflict start failure when the host never becomes ready", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const spawn = vi.fn();
    const waitForHost = vi.fn(async () => ({ status: "timeout" as const }));
    const result = await attachOrCreateHost(deps({ fetch, spawn, waitForHost }));
    expect(result.kind).toBe("start-failed");
  });
});

describe("createLaunchSession", () => {
  it("creates a launch session against the admin route with the bridge secret", async () => {
    const fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ launchToken: `${"A".repeat(42)}A`, expiresAt: 1 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const { createLaunchSession } = await import("./hostLauncher");
    const receipt = await createLaunchSession({
      bridgeSecret,
      serverUrl: new URL("http://127.0.0.1:13773"),
      windowId,
      capability,
      fetch,
    });
    expect(receipt?.launchToken).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    const calls = vi.mocked(fetch).mock.calls as [URL, RequestInit][];
    const call = calls[0]!;
    expect(call[0].toString()).toBe("http://127.0.0.1:13773/api/desktop/launch-sessions");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers).toEqual({
      "x-octant-desktop-secret": bridgeSecret,
      "content-type": "application/json",
    });
  });

  it("returns undefined when the admin route is unavailable (503)", async () => {
    const fetch = mockFetch(async () => new Response("{}", { status: 503 }));
    const { createLaunchSession } = await import("./hostLauncher");
    const receipt = await createLaunchSession({
      bridgeSecret,
      serverUrl: new URL("http://127.0.0.1:13773"),
      windowId,
      capability,
      fetch,
    });
    expect(receipt).toBeUndefined();
  });

  it("returns undefined when the bridge secret is unauthorized (401)", async () => {
    const fetch = mockFetch(async () => new Response("{}", { status: 401 }));
    const { createLaunchSession } = await import("./hostLauncher");
    const receipt = await createLaunchSession({
      bridgeSecret,
      serverUrl: new URL("http://127.0.0.1:13773"),
      windowId,
      capability,
      fetch,
    });
    expect(receipt).toBeUndefined();
  });

  it("returns undefined when the transport rejects after health succeeded", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { createLaunchSession } = await import("./hostLauncher");
    const receipt = await createLaunchSession({
      bridgeSecret,
      serverUrl: new URL("http://127.0.0.1:13773"),
      windowId,
      capability,
      fetch,
    });
    expect(receipt).toBeUndefined();
  });
});

describe("buildWebClientUrl", () => {
  it("places the launch token in the URL fragment so it never reaches the server", async () => {
    const { buildWebClientUrl } = await import("./hostLauncher");
    const url = buildWebClientUrl({
      serverUrl: new URL("http://127.0.0.1:13773"),
      launchToken: `${"A".repeat(42)}A`,
    });
    expect(url.hash).toMatch(/^#launchToken=[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("serverUrl")).toBe("http://127.0.0.1:13773/");
    expect(url.pathname).toBe("/");
  });
});

describe("HostLauncherResult", () => {
  it("attached result carries the host URL and identity", async () => {
    const result: HostLauncherResult = {
      kind: "attached",
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
    };
    expect(result.kind).toBe("attached");
  });
});
