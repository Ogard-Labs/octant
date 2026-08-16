import { decodeShellFailure, decodeWindowId } from "@octant/contracts";
import {
  defaultEnvironmentPresentationState,
  defaultShellSettings,
  defaultWindowWorkspace,
  resolveSurfaceDescriptors,
} from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { createShellRouteHandler } from "./shellRoutes";
import { ShellServiceError, type ShellServiceApi } from "./shellService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000301");

describe("shell routes", () => {
  it("serves bootstrap and command JSON only on the supported methods", async () => {
    const service = serviceStub();
    const handle = createShellRouteHandler(service);

    const bootstrap = await handle(
      new Request(`http://127.0.0.1:13773/api/shell/bootstrap?windowId=${windowId}`),
    );
    expect(bootstrap?.status).toBe(200);
    expect(await bootstrap?.json()).toMatchObject({ connectionStatus: "connected" });

    const command = await handle(
      new Request("http://localhost:13773/api/shell/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      new Request("http://127.0.0.1:13773/api/shell/commands", { method: "GET" }),
    );
    expect(wrongMethod?.status).toBe(400);
    expect(await wrongMethod?.json()).toMatchObject({ category: "unsupported" });
  });

  it("rejects malformed JSON, invalid window IDs, and foreign request hosts", async () => {
    const handle = createShellRouteHandler(serviceStub());

    const malformed = await handle(
      new Request("http://127.0.0.1:13773/api/shell/commands", {
        method: "POST",
        body: "{",
      }),
    );
    expect(malformed?.status).toBe(400);
    expect(await malformed?.json()).toMatchObject({ category: "invalid" });

    const invalidWindow = await handle(
      new Request("http://127.0.0.1:13773/api/shell/bootstrap?windowId=nope"),
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
    const handle = createShellRouteHandler(serviceStub());
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
    expect(response?.headers.get("access-control-allow-headers")).toBe("content-type");
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
    const handle = createShellRouteHandler(serviceStub());
    const response = await handle(
      new Request(`http://127.0.0.1:13773/api/shell/bootstrap?windowId=${windowId}`, {
        headers: { origin },
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ category: "unsupported" });
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects foreign origins and maps service failures to stable status codes", async () => {
    const foreign = createShellRouteHandler(serviceStub());
    const rejected = await foreign(
      new Request(`http://127.0.0.1:13773/api/shell/bootstrap?windowId=${windowId}`, {
        headers: { origin: "https://example.com" },
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
      const handle = createShellRouteHandler(serviceStub(failure));
      const response = await handle(
        new Request(`http://localhost:13773/api/shell/bootstrap?windowId=${windowId}`),
      );
      expect(response?.status).toBe(status);
      expect(await response?.json()).toEqual(failure);
    }
  });
});

function serviceStub(failure?: ConstructorParameters<typeof ShellServiceError>[0]) {
  const bootstrap = vi.fn(() => {
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
  });
  const execute = vi.fn(() => ({
    kind: "settings-replaced" as const,
    settings: defaultShellSettings(),
    version: 1 as never,
  }));
  return { bootstrap, execute } satisfies ShellServiceApi;
}
