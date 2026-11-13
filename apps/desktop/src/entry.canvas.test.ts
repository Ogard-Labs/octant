import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const loading = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  return { loading, ready, requested: false, prepared: false, started: false };
});
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "/fixture",
    exit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock("node:fs", () => ({
  readFileSync: () => JSON.stringify({ octantDesktopFlavor: "stable", version: "0.1.0" }),
}));
vi.mock("./desktopLaunch", async (original) => ({
  ...(await original<typeof import("./desktopLaunch")>()),
  resolvePackagedDesktopLaunch: () => ({ kind: "canvas" }),
}));
vi.mock("./desktopRuntimeLoader", () => ({
  loadCanvasPrototypeHostRuntime: async () => {
    fixture.requested = true;
    await fixture.loading.promise;
    return {
      runCanvasPrototypeHost: async () => {
        fixture.prepared = true;
        void fixture.ready.promise.then(() => {
          fixture.started = true;
        });
      },
    };
  },
}));

it("finishes Canvas pre-ready setup before releasing Electron's entry evaluation", async () => {
  let evaluated = false;
  const imported = import("./entry").then(() => {
    evaluated = true;
  });
  try {
    await vi.waitFor(() => expect(fixture.requested).toBe(true));
    expect(evaluated).toBe(false);
    fixture.loading.resolve();
    await imported;
    expect(fixture.prepared).toBe(true);
    expect(fixture.started).toBe(false);
  } finally {
    fixture.loading.resolve();
    fixture.ready.resolve();
    await imported;
  }
});
