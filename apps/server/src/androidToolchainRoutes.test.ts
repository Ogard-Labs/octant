import type { AndroidExecutionContext } from "./android/androidToolchainService";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createAndroidToolchainRouteHandler: (
  options: Record<string, unknown>,
) => (request: Request) => Promise<Response | undefined>;

beforeAll(async () => {
  const loaded = await import("./androidToolchainRoutes");
  expect(loaded.createAndroidToolchainRouteHandler).toBeTypeOf("function");
  createAndroidToolchainRouteHandler = loaded.createAndroidToolchainRouteHandler;
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
});
