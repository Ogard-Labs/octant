import type { AndroidExecutionContext } from "./android/androidToolchainService";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createAndroidToolchainRouteHandler: (
  options: Record<string, unknown>,
) => (request: Request) => Promise<Response | undefined>;

beforeAll(async () => {
  const path = "./androidToolchainRoutes";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.createAndroidToolchainRouteHandler).toBeTypeOf("function");
  createAndroidToolchainRouteHandler = loaded!.createAndroidToolchainRouteHandler;
});

const capability = "A".repeat(43);
const windowId = "60000000-0000-4000-8000-000000000001" as never;
const authority = {
  hostId: "60000000-0000-4000-8000-000000000002",
  mode: "code",
  projectId: "60000000-0000-4000-8000-000000000003",
  providerInstanceId: "60000000-0000-4000-8000-000000000004",
  extension: { kind: "core" },
} as const;
const scope = {
  threadId: "60000000-0000-4000-8000-000000000005",
  checkoutId: "60000000-0000-4000-8000-000000000006",
} as const;
const context: AndroidExecutionContext = {
  authority: authority as never,
  threadId: scope.threadId as never,
  checkoutId: scope.checkoutId as never,
  checkoutRoot: "/private/project",
  artifactRoot: "/private/artifacts",
  executionPolicy: "full-access",
  approvalValid: true,
};

function authorityStore() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 1 });
  return store;
}

function request(body: unknown, token = capability) {
  return new Request("http://127.0.0.1:13773/api/android/toolchain", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": token,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(body),
  });
}

describe("Android toolchain routes", () => {
  it("authenticates the window and returns a normalized discovery snapshot", async () => {
    const discovery = {
      sdk: {
        sdkId: "60000000-0000-4000-8000-000000000007",
        available: true,
        discoveredAt: "2026-09-20T20:00:00.000Z",
      },
      emulators: [],
    } as const;
    const service = {
      discover: vi.fn(async () => ({ kind: "discovered", ...discovery })),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
      watchScreen: vi.fn(),
    };
    const resolveContext = vi.fn(async () => context);
    const handler = createAndroidToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext,
      service,
      now: () => 2,
    });
    const response = await handler(
      request({
        kind: "android-discovery-request",
        request: {
          actionId: "60000000-0000-4000-8000-000000000008",
          correlationId: "60000000-0000-4000-8000-000000000009",
          authority,
          ...scope,
        },
      }),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      kind: "android-discovery-snapshot",
      snapshot: { sdk: { available: true } },
    });
    expect(service.discover).toHaveBeenCalledWith(expect.any(Object), context);
  });

  describe("Volume keys", () => {
    const volume = {
      actionId: "60000000-0000-4000-8000-000000000018",
      correlationId: "60000000-0000-4000-8000-000000000019",
      authority,
      ...scope,
      kind: "key-press",
      emulatorId: "Pixel_8_API_34",
      key: "volume-up",
      requestedBy: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000099" },
      timeoutMs: 30_000,
      approval: { kind: "approved", approvalId: "60000000-0000-4000-8000-00000000001b" },
    };
    function routes(resolveContext: ReturnType<typeof vi.fn>) {
      const service = {
        discover: vi.fn(),
        execute: vi.fn(async () => ({
          actionId: volume.actionId,
          correlationId: volume.correlationId,
          authority,
          kind: "key-press",
          outcome: "succeeded",
          emulatorId: volume.emulatorId,
          requestedBy: volume.requestedBy,
          diagnostics: [],
          artifacts: [],
          cleanup: "complete",
          durationMs: 5,
          completedAt: "2026-10-14T20:00:01.000Z",
        })),
        cancel: vi.fn(),
        snapshot: vi.fn(),
        readScreenshotArtifact: vi.fn(),
        watchScreen: vi.fn(),
      };
      const handler = createAndroidToolchainRouteHandler({
        windowAuthorityStore: authorityStore(),
        resolveContext,
        service,
        now: () => 2,
      });
      return { handler, service };
    }

    it("hands a volume key to the host with the window's authority", async () => {
      const { handler, service } = routes(vi.fn(async () => context));

      const response = await handler(request({ kind: "android-action-request", request: volume }));

      expect(response?.status).toBe(200);
      expect(service.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "key-press", key: "volume-up" }),
        context,
      );
    });

    it("refuses a volume key for a thread the window has no authority over", async () => {
      const { handler, service } = routes(vi.fn(async () => undefined));

      const response = await handler(request({ kind: "android-action-request", request: volume }));

      expect(response?.status).toBe(403);
      expect(service.execute).not.toHaveBeenCalled();
    });
  });

  describe("Open URL", () => {
    const openUrl = {
      actionId: "60000000-0000-4000-8000-000000000008",
      correlationId: "60000000-0000-4000-8000-000000000009",
      authority,
      ...scope,
      kind: "open-url",
      emulatorId: "Pixel_8_API_34",
      url: "https://example.com/welcome",
      requestedBy: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000099" },
      timeoutMs: 30_000,
      approval: { kind: "approved", approvalId: "60000000-0000-4000-8000-00000000000b" },
    };
    function routes(resolveContext: ReturnType<typeof vi.fn>) {
      const service = {
        discover: vi.fn(),
        execute: vi.fn(async () => ({
          actionId: openUrl.actionId,
          correlationId: openUrl.correlationId,
          authority,
          kind: "open-url",
          outcome: "succeeded",
          emulatorId: openUrl.emulatorId,
          requestedBy: openUrl.requestedBy,
          diagnostics: [],
          artifacts: [],
          cleanup: "complete",
          durationMs: 5,
          completedAt: "2026-10-14T20:00:01.000Z",
        })),
        cancel: vi.fn(),
        snapshot: vi.fn(),
        readScreenshotArtifact: vi.fn(),
        watchScreen: vi.fn(),
      };
      const handler = createAndroidToolchainRouteHandler({
        windowAuthorityStore: authorityStore(),
        resolveContext,
        service,
        now: () => 2,
      });
      return { handler, service };
    }

    it("hands an address the window may open to the host with that window's authority", async () => {
      const { handler, service } = routes(vi.fn(async () => context));

      const response = await handler(request({ kind: "android-action-request", request: openUrl }));

      expect(response?.status).toBe(200);
      expect(service.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "open-url", url: "https://example.com/welcome" }),
        context,
      );
    });

    it("refuses an app-content or script address before authority is checked or the host is reached", async () => {
      for (const url of ["content://contacts/people/1", "javascript:alert(1)"]) {
        const resolveContext = vi.fn(async () => context);
        const { handler, service } = routes(resolveContext);

        const response = await handler(
          request({ kind: "android-action-request", request: { ...openUrl, url } }),
        );

        expect(response?.status, url).toBe(400);
        expect(resolveContext).not.toHaveBeenCalled();
        expect(service.execute).not.toHaveBeenCalled();
      }
    });

    it("refuses an Open URL for a thread the window has no authority over", async () => {
      const { handler, service } = routes(vi.fn(async () => undefined));

      const response = await handler(request({ kind: "android-action-request", request: openUrl }));

      expect(response?.status).toBe(403);
      expect(service.execute).not.toHaveBeenCalled();
    });
  });

  describe("Rotate", () => {
    const rotate = {
      actionId: "60000000-0000-4000-8000-000000000008",
      correlationId: "60000000-0000-4000-8000-000000000009",
      authority,
      ...scope,
      kind: "rotate",
      emulatorId: "Pixel_8_API_34",
      orientation: "landscape",
      requestedBy: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000099" },
      timeoutMs: 30_000,
      approval: { kind: "approved", approvalId: "60000000-0000-4000-8000-00000000000b" },
    };
    function routes(resolveContext: ReturnType<typeof vi.fn>) {
      const service = {
        discover: vi.fn(),
        execute: vi.fn(async () => ({
          actionId: rotate.actionId,
          correlationId: rotate.correlationId,
          authority,
          kind: "rotate",
          outcome: "succeeded",
          emulatorId: rotate.emulatorId,
          requestedBy: rotate.requestedBy,
          diagnostics: [],
          artifacts: [],
          cleanup: "complete",
          durationMs: 5,
          completedAt: "2026-10-14T20:00:01.000Z",
        })),
        cancel: vi.fn(),
        snapshot: vi.fn(),
        readScreenshotArtifact: vi.fn(),
        watchScreen: vi.fn(),
      };
      const handler = createAndroidToolchainRouteHandler({
        windowAuthorityStore: authorityStore(),
        resolveContext,
        service,
        now: () => 2,
      });
      return { handler, service };
    }

    it("hands a rotation the window may make to the host with that window's authority", async () => {
      const { handler, service } = routes(vi.fn(async () => context));

      const response = await handler(request({ kind: "android-action-request", request: rotate }));

      expect(response?.status).toBe(200);
      expect(service.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "rotate", orientation: "landscape" }),
        context,
      );
    });

    it("refuses a rotation without a known orientation before authority is checked", async () => {
      for (const orientation of [undefined, "upside-down"]) {
        const resolveContext = vi.fn(async () => context);
        const { handler, service } = routes(resolveContext);

        const response = await handler(
          request({ kind: "android-action-request", request: { ...rotate, orientation } }),
        );

        expect(response?.status, String(orientation)).toBe(400);
        expect(resolveContext).not.toHaveBeenCalled();
        expect(service.execute).not.toHaveBeenCalled();
      }
    });

    it("refuses a rotation for a thread the window has no authority over", async () => {
      const { handler, service } = routes(vi.fn(async () => undefined));

      const response = await handler(request({ kind: "android-action-request", request: rotate }));

      expect(response?.status).toBe(403);
      expect(service.execute).not.toHaveBeenCalled();
    });
  });

  it("tells the pane which emulators the thread may send input to without a new approval", async () => {
    const snapshot = {
      sequence: 4,
      snapshotAt: "2026-09-20T20:00:03.000Z",
      sdk: {
        sdkId: "60000000-0000-4000-8000-000000000007",
        available: true,
        discoveredAt: "2026-09-20T20:00:00.000Z",
      },
      emulators: [],
      active: [],
      recentEvidence: [],
    };
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(() => snapshot),
      readScreenshotArtifact: vi.fn(),
      watchScreen: vi.fn(),
    };
    const grants = [
      {
        emulatorId: "Pixel_8_API_34",
        expiresAt: "2026-09-20T20:15:00.000Z",
      },
    ];
    const inputGrants = vi.fn(() => grants);
    const handler = createAndroidToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext: async () => context,
      service,
      inputGrants,
      now: () => 2,
    });
    const body = { kind: "android-snapshot-request", authority, ...scope };
    const granted = await handler(request(body));
    expect(granted?.status).toBe(200);
    await expect(granted?.json()).resolves.toMatchObject({
      kind: "android-runtime-snapshot",
      snapshot: { sequence: 4, inputGrants: grants },
    });
    inputGrants.mockReturnValue([]);
    const ungranted = await (await handler(request(body)))?.json();
    expect(ungranted.snapshot.inputGrants).toBeUndefined();
  });

  it("names how the emulator screen reaches the pane", async () => {
    const frames = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const service = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshotArtifact: vi.fn(),
      watchScreen: vi.fn(async () => ({
        kind: "watching" as const,
        screen: { width: 1080, height: 2400 },
        frames,
        transport: { kind: "screencap", reason: "tool-exited" },
      })),
    };
    const handler = createAndroidToolchainRouteHandler({
      windowAuthorityStore: authorityStore(),
      resolveContext: vi.fn(async () => context),
      service,
      now: () => 2,
    });
    const response = await handler(
      new Request("http://127.0.0.1:13773/api/android/screen-stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({
          kind: "android-screen-stream-request",
          authority,
          ...scope,
          emulatorId: "Pixel_8_API_34",
        }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(JSON.parse(response?.headers.get("x-octant-android-transport") ?? "null")).toEqual({
      kind: "screencap",
      reason: "tool-exited",
    });
    expect(response?.headers.get("access-control-expose-headers")).toContain(
      "x-octant-android-transport",
    );
  });
});
