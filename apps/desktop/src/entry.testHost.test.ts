import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  status: vi.fn(),
  client: vi.fn(),
  error: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    on: vi.fn(),
    getAppPath: () => "/fixture",
    getPath: () => "/fixture/Library/Application Support",
    setName: vi.fn(),
    setPath: vi.fn(),
    whenReady: async () => undefined,
    exit: vi.fn(),
    quit: vi.fn(),
  },
}));
vi.mock("./startupFailureElectron", () => ({ showStartupFailure: fixture.error }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  readFileSync: () =>
    JSON.stringify({ octantDesktopFlavor: "nightly", version: "0.1.0-preview.20261104.1" }),
}));
vi.mock("./nightlyTestData", async (original) => ({
  ...(await original<typeof import("./nightlyTestData")>()),
  resolveStartupHostRole: () => ({
    kind: "test-host",
    dataDirectory: "/fixture/Library/Application Support/Octant Nightly/Test Data",
    serverPort: 13_774,
    keychainServiceFamily: "octant-nightly-test-data",
  }),
}));
vi.mock("./canvasPrototypeHost", () => ({
  CANVAS_PROTOTYPE_HOST_SWITCH: "--octant-canvas-prototype-host",
  runCanvasPrototypeHost: vi.fn(),
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
vi.mock("./nightlyClient", () => ({ runNightlyClient: fixture.client }));

it("starts Nightly's own host for test data without asking Octant for status or a client window", async () => {
  await import("./entry");
  // The source tree has no built host-owning module, so the start fails; the
  // point is which path Nightly took and what it told the person.
  await vi.waitFor(() =>
    expect(fixture.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Octant Nightly",
        message: "Octant Nightly could not start the host for its test data.",
      }),
    ),
  );
  expect(fixture.status).not.toHaveBeenCalled();
  expect(fixture.client).not.toHaveBeenCalled();
}, 30_000);
