import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release, started: false, finished: false, setPath: vi.fn() };
});
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "/fixture",
    getPath: () => "/fixture",
    setName: vi.fn(),
    setPath: fixture.setPath,
    whenReady: () => fixture.ready,
    exit: vi.fn(),
    quit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: () =>
    JSON.stringify({ octantDesktopFlavor: "nightly", version: "0.1.0-preview.20261104.1" }),
}));
vi.mock("./canvasPrototypeHost", () => ({
  CANVAS_PROTOTYPE_HOST_SWITCH: "--octant-canvas-prototype-host",
  runCanvasPrototypeHost: vi.fn(),
}));
vi.mock("./desktopPeerStatus", () => ({
  loadDesktopPeerStatus: () => ({}),
  desktopPeerPreflight: async () => ({ kind: "ready", protocol: 1, version: "0.1.0" }),
  closeDesktopPeerStatus: async () => ({ kind: "closed" }),
}));
vi.mock("./desktopLaunch", async (original) => ({
  ...(await original<typeof import("./desktopLaunch")>()),
  resolvePackagedDesktopLaunch: () => ({ kind: "desktop" }),
}));
vi.mock("./nightlyClient", () => ({
  runNightlyClient: async () => {
    fixture.started = true;
    await fixture.ready;
    fixture.finished = true;
    return { kind: "started" };
  },
}));

it("finishes ordinary Nightly module evaluation before its client waits for Electron ready", async () => {
  const imported = import("./entry");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Only a module held open waits this long; a cold import of the entry's
    // dependency graph took 1.7s on a Mac and over 500ms on hosted runners.
    const evaluated = await Promise.race([
      imported.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 20_000);
      }),
    ]);
    expect(evaluated).toBe(true);
    expect(fixture.finished).toBe(false);
    expect(fixture.setPath).toHaveBeenCalledWith("userData", "/fixture/Octant Nightly");
    expect(fixture.setPath).toHaveBeenCalledWith("sessionData", "/fixture/Octant Nightly");
  } finally {
    clearTimeout(timer);
    fixture.release();
    await imported;
  }
  await vi.waitFor(() => expect(fixture.finished).toBe(true));
}, 30_000);
