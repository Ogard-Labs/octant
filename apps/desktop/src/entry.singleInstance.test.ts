import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ status: vi.fn(), client: vi.fn(), quit: vi.fn() }));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    on: vi.fn(),
    getAppPath: () => "/fixture",
    getPath: () => "/fixture/Library/Application Support",
    setName: vi.fn(),
    setPath: vi.fn(),
    whenReady: async () => undefined,
    // Another Nightly (a client or the test host) already holds the lock.
    requestSingleInstanceLock: () => false,
    exit: vi.fn(),
    quit: fixture.quit,
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  readFileSync: () =>
    JSON.stringify({ octantDesktopFlavor: "nightly", version: "0.1.0-preview.20261104.1" }),
}));
vi.mock("./nightlyTestData", async (original) => ({
  ...(await original<typeof import("./nightlyTestData")>()),
  resolveStartupHostRole: () => ({ kind: "octant-client" }),
}));
vi.mock("./desktopPeerStatus", () => ({
  loadDesktopPeerStatus: fixture.status,
  ensureNightlyHostReady: fixture.status,
  closeDesktopPeerStatus: fixture.status,
  linuxRendererSandboxDisabled: () => false,
}));
vi.mock("./desktopLaunch", async (original) => ({
  ...(await original<typeof import("./desktopLaunch")>()),
  resolvePackagedDesktopLaunch: () => ({ kind: "desktop" }),
}));
vi.mock("./desktopRuntimeLoader", async (original) => ({
  ...(await original<typeof import("./desktopRuntimeLoader")>()),
  loadNightlyClientRuntime: async () => ({ runNightlyClient: fixture.client }),
}));

it("leaves a second Nightly client to the running one instead of opening beside it", async () => {
  await import("./entry");
  await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalled());
  expect(fixture.status).not.toHaveBeenCalled();
  expect(fixture.client).not.toHaveBeenCalled();
}, 30_000);
