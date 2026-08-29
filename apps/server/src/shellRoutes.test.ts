import { decodeShellFailure, decodeWindowId } from "@octant/contracts";
import {
  defaultEnvironmentPresentationState,
  defaultShellSettings,
  defaultWindowWorkspace,
  resolveSurfaceDescriptors,
} from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import {
  createShellRouteHandler,
  isAllowedRendererOrigin,
  resolveAllowedRendererHttpOrigin,
  SHELL_RENDERER_IDENTITY_HEADER as RENDERER_IDENTITY_HEADER,
} from "./shellRoutes";
import { ShellServiceError, type ShellServiceApi } from "./shellService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000301");
const otherWindowId = decodeWindowId("00000000-0000-4000-8000-000000000302");
const capability = "A".repeat(43);
const rendererIdentity = `${"C".repeat(42)}A`;

describe("shell routes", () => {
  it("serves bootstrap and command JSON only on the supported methods", async () => {
    const service = serviceStub();
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = authorizedHandle(service, authority);

    const bootstrap = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(bootstrap?.status).toBe(200);
    expect(await bootstrap?.json()).toMatchObject({ connectionStatus: "connected" });

    const command = await handle(
      new Request("http://localhost:13773/api/shell/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
        body: JSON.stringify({
          kind: "replace-settings",
          windowId,
          expectedVersion: 0,
          settings: defaultShellSettings(),
        }),
      }),
    );
    expect(command?.status).toBe(200);
    expect(service.execute).toHaveBeenCalledOnce();

    const wrongMethod = await handle(
      new Request("http://127.0.0.1:13773/api/shell/commands", {
        method: "GET",
        headers: {
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(wrongMethod?.status).toBe(400);
    expect(await wrongMethod?.json()).toMatchObject({ category: "unsupported" });
  });

  it("rejects malformed JSON, invalid window IDs, and foreign request hosts", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = authorizedHandle(serviceStub(), authority);

    const malformed = await handle(
      new Request("http://127.0.0.1:13773/api/shell/commands", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
        body: "{",
      }),
    );
    expect(malformed?.status).toBe(400);
    expect(await malformed?.json()).toMatchObject({ category: "invalid" });

    const invalidWindow = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap?windowId=nope", {
        headers: {
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(invalidWindow?.status).toBe(400);
    expect(await invalidWindow?.json()).toMatchObject({ category: "invalid" });

    const foreignHost = await handle(
      new Request(`http://192.168.1.5:13773/api/shell/bootstrap?windowId=${windowId}`),
    );
    expect(foreignHost?.status).toBe(400);
    expect(await foreignHost?.json()).toMatchObject({ category: "unsupported" });
  });

  it.each([
    "file://",
    "http://127.0.0.1",
    "http://127.0.0.1:5173",
    "http://localhost",
    "http://localhost:5173",
  ])("allows renderer preflight from %s without wildcard CORS", async (origin) => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = authorizedHandle(serviceStub(), authority);
    const response = await handle(
      new Request("http://127.0.0.1:13773/api/shell/commands", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response?.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(response?.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-octant-window-capability, x-octant-renderer-identity",
    );
    expect(response?.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it.each([
    "file:///tmp/renderer.html",
    "null",
    "http://user@localhost:5173",
    "http://localhost:5173/",
    "http://localhost:5173/renderer",
    "http://localhost:5173?mode=code",
    "http://localhost:5173#renderer",
    "HTTP://LOCALHOST:5173",
    "http://127.0.0.1:80",
    "http://[::1]:5173",
    "not an origin",
  ])("rejects and does not echo noncanonical renderer origin %s", async (origin) => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = authorizedHandle(serviceStub(), authority);
    const response = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: { origin, "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ category: "unsupported" });
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects foreign origins and maps service failures to stable status codes", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const foreign = authorizedHandle(serviceStub(), authority);
    const rejected = await foreign(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: { origin: "https://example.com", "x-octant-window-capability": capability },
      }),
    );
    expect(rejected?.status).toBe(400);
    expect(await rejected?.json()).toMatchObject({ category: "unsupported" });
    expect(rejected?.headers.get("access-control-allow-origin")).toBeNull();

    for (const [failure, status] of [
      [
        decodeShellFailure({
          category: "conflict",
          message: "reload",
          expectedVersion: 1,
          actualVersion: 2,
        }),
        409,
      ],
      [decodeShellFailure({ category: "unavailable", message: "retry" }), 503],
      [decodeShellFailure({ category: "recovery-required", message: "recover" }), 503],
    ] as const) {
      const failureAuthority = new WindowAuthorityStore();
      failureAuthority.register({ windowId, capability, rendererIdentity, now: 0 });
      const handle = authorizedHandle(serviceStub(failure), failureAuthority);
      const response = await handle(
        new Request("http://localhost:13773/api/shell/bootstrap", {
          method: "POST",
          headers: {
            "x-octant-window-capability": capability,
            [RENDERER_IDENTITY_HEADER]: rendererIdentity,
          },
        }),
      );
      expect(response?.status).toBe(status);
      expect(await response?.json()).toEqual(failure);
    }
  });

  it("requires capability and renderer identity for shell data and refuses caller-selected windows", async () => {
    const service = serviceStub();
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = authorizedHandle(service, authority);

    const missingCapability = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap"),
    );
    expect(missingCapability?.status).toBe(400);
    expect(service.bootstrap).not.toHaveBeenCalled();

    const arbitraryWindow = await handle(
      new Request(`http://127.0.0.1:13773/api/shell/bootstrap?windowId=${otherWindowId}`, {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(arbitraryWindow?.status).toBe(400);
    expect(service.bootstrap).not.toHaveBeenCalled();

    const bodyWindow = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ windowId: otherWindowId }),
      }),
    );
    expect(bodyWindow?.status).toBe(400);
    expect(service.bootstrap).not.toHaveBeenCalled();

    const wrongRenderer = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: {
          origin: "file://",
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: `${"D".repeat(42)}A`,
        },
      }),
    );
    expect(wrongRenderer?.status).toBe(401);
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it("rejects originless, arbitrary, and generic file requests without the exact window capability", async () => {
    const service = serviceStub();
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, now: 0 });
    const handle = authorizedHandle(service, authority);

    for (const [request, status, category] of [
      [new Request("http://127.0.0.1:13773/api/shell/bootstrap"), 400, "unsupported"],
      [
        new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
          headers: { origin: "https://attacker.example" },
        }),
        400,
        "unsupported",
      ],
      [
        new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
          headers: { origin: "file://" },
        }),
        400,
        "unsupported",
      ],
      [
        new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
          headers: { origin: "file:///tmp/renderer.html" },
        }),
        400,
        "unsupported",
      ],
    ] as const) {
      const response = await handle(request);
      expect(response?.status).toBe(status);
      expect(await response?.json()).toMatchObject({ category });
    }
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it("registers an authorized packaged renderer with POST and reads it without mutating on GET", async () => {
    const service = serviceStub();
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = authorizedHandle(service, authority);

    const registration = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: {
          origin: "file://",
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(registration?.status).toBe(200);
    expect(service.bootstrap).toHaveBeenCalledWith(windowId);

    const read = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        headers: {
          origin: "file://",
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(read?.status).toBe(200);
    expect(service.readBootstrap).toHaveBeenCalledWith(windowId);
    expect(service.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("revokes shell registration with window authority and refuses capability reuse", async () => {
    const service = serviceStub();
    const authority = new WindowAuthorityStore((revokedWindowId) => {
      service.revokeWindow(revokedWindowId);
    });
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = authorizedHandle(service, authority);

    await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    authority.revoke(windowId);

    const reuse = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "GET",
        headers: {
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(reuse?.status).toBe(401);
    expect(service.readBootstrap).not.toHaveBeenCalled();
    expect(service.revokeWindow).toHaveBeenCalledWith(windowId);
  });

  it("rejects a packaged file origin when development origin is pinned", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = createShellRouteHandler(serviceStub(), {
      windowAuthorityStore: authority,
      now: () => 0,
      allowedRendererHttpOrigin: "http://localhost:5173",
    });
    const rejected = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: {
          origin: "file://",
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(rejected?.status).toBe(400);
    expect(await rejected?.json()).toMatchObject({ category: "unsupported" });
  });

  it("rejects a non-Vite loopback origin when development origin is pinned", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = createShellRouteHandler(serviceStub(), {
      windowAuthorityStore: authority,
      now: () => 0,
      allowedRendererHttpOrigin: "http://localhost:5173",
    });
    const rejected = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:5173", "x-octant-window-capability": capability },
      }),
    );
    expect(rejected?.status).toBe(400);
    expect(await rejected?.json()).toMatchObject({ category: "unsupported" });
    expect(rejected?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects HTTP origins when the renderer is packaged", async () => {
    const service = serviceStub();
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, rendererIdentity, now: 0 });
    const handle = createShellRouteHandler(service, {
      windowAuthorityStore: authority,
      now: () => 0,
      allowedRendererHttpOrigin: null,
    });
    const rejected = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: { origin: "http://localhost:5173", "x-octant-window-capability": capability },
      }),
    );
    expect(rejected?.status).toBe(400);
    expect(service.bootstrap).not.toHaveBeenCalled();

    const allowed = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap", {
        method: "POST",
        headers: {
          origin: "file://",
          "x-octant-window-capability": capability,
          [RENDERER_IDENTITY_HEADER]: rendererIdentity,
        },
      }),
    );
    expect(allowed?.status).toBe(200);
  });
});

describe("isAllowedRendererOrigin", () => {
  it("keeps loopback HTTP on any port when no development origin is configured", () => {
    expect(isAllowedRendererOrigin("file://")).toBe(true);
    expect(isAllowedRendererOrigin("null")).toBe(true);
    expect(isAllowedRendererOrigin("http://127.0.0.1:9999")).toBe(true);
    expect(isAllowedRendererOrigin("http://localhost:5173")).toBe(true);
  });

  it("requires the configured development origin when set", () => {
    expect(isAllowedRendererOrigin("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(isAllowedRendererOrigin("http://127.0.0.1:5173", "http://localhost:5173")).toBe(false);
    expect(isAllowedRendererOrigin("file://", "http://localhost:5173")).toBe(false);
    expect(isAllowedRendererOrigin("null", "http://localhost:5173")).toBe(false);
  });

  it("allows only the packaged file origin", () => {
    expect(isAllowedRendererOrigin("file://", null)).toBe(true);
    expect(isAllowedRendererOrigin("null", null)).toBe(true);
    expect(isAllowedRendererOrigin("http://127.0.0.1:5173", null)).toBe(false);
    expect(isAllowedRendererOrigin("http://localhost:5173", null)).toBe(false);
  });

  it("resolves packaged, Vite, and unset development origins", () => {
    expect(resolveAllowedRendererHttpOrigin({ packaged: true })).toBeNull();
    expect(resolveAllowedRendererHttpOrigin({ developmentWebUrl: "http://localhost:5173/" })).toBe(
      "http://localhost:5173",
    );
    expect(resolveAllowedRendererHttpOrigin({})).toBeUndefined();
  });
});

function authorizedHandle(
  service: ShellServiceApi,
  authority: WindowAuthorityStore,
): ReturnType<typeof createShellRouteHandler> {
  return createShellRouteHandler(service, {
    windowAuthorityStore: authority,
    now: () => 0,
  });
}

function serviceStub(failure?: ConstructorParameters<typeof ShellServiceError>[0]) {
  const makeBootstrap = () => {
    if (failure !== undefined) throw new ShellServiceError(failure);
    const workspace = defaultWindowWorkspace(windowId);
    return {
      settings: defaultShellSettings(),
      workspace,
      availableSurfaces: {
        chat: resolveSurfaceDescriptors(workspace.contextByMode.chat),
        work: resolveSurfaceDescriptors(workspace.contextByMode.work),
        code: resolveSurfaceDescriptors(workspace.contextByMode.code),
      },
      connectionStatus: "connected" as const,
      settingsVersion: 0 as never,
      workspaceVersion: 0 as never,
      environmentPresentation: defaultEnvironmentPresentationState(),
      presentationVersion: 0 as never,
    };
  };
  const bootstrap = vi.fn(makeBootstrap);
  const execute = vi.fn(() => ({
    kind: "settings-replaced" as const,
    settings: defaultShellSettings(),
    version: 1 as never,
  }));
  const readBootstrap = vi.fn(makeBootstrap);
  const revokeWindow = vi.fn();
  return { bootstrap, readBootstrap, execute, revokeWindow } satisfies ShellServiceApi;
}
