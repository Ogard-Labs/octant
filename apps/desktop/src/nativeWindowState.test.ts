import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_WINDOW_STATE_FILENAME,
  createNativeWindowStateStore,
  flushNativeWindowState,
  type NativeWindowStateFilePort,
} from "./nativeWindowState";

const displays = [{ x: 0, y: 0, width: 1440, height: 900 }];
const uuid = "00000000-0000-4000-8000-000000000801";

function memoryFiles(initial?: string): {
  readonly files: NativeWindowStateFilePort;
  readonly operations: string[];
} {
  let contents = initial;
  const operations: string[] = [];
  return {
    operations,
    files: {
      mkdir: async (path) => void operations.push(`mkdir:${path}`),
      readFile: async (path) => {
        operations.push(`read:${path}`);
        if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return contents;
      },
      rename: async (from, to) => {
        operations.push(`rename:${from}:${to}`);
      },
      writeFile: async (path, value) => {
        operations.push(`write:${path}`);
        contents = value;
      },
    },
  };
}

function persisted(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    windowId: uuid,
    bounds: { x: 100, y: 80, width: 1100, height: 720 },
    maximized: false,
    ...overrides,
  });
}

describe("native window state", () => {
  it.each([undefined, "not json", JSON.stringify({ schemaVersion: 1 })])(
    "centers safe defaults for missing or corrupt state",
    async (initial) => {
      const { files } = memoryFiles(initial);
      const store = createNativeWindowStateStore({
        directory: "/data",
        displays,
        files,
        uuid: () => uuid,
      });

      await expect(store.load()).resolves.toEqual({
        schemaVersion: 1,
        windowId: uuid,
        bounds: { x: 220, y: 90, width: 1000, height: 720 },
        maximized: false,
      });
    },
  );

  it("keeps the stable window id while clamping minimum size into the intersecting display", async () => {
    const { files } = memoryFiles(
      persisted({ bounds: { x: -20, y: 30, width: 400, height: 300 }, maximized: true }),
    );
    const store = createNativeWindowStateStore({
      directory: "/data",
      displays,
      files,
      uuid: () => "new-id",
    });

    await expect(store.load()).resolves.toEqual({
      schemaVersion: 1,
      windowId: uuid,
      bounds: { x: 0, y: 30, width: 900, height: 600 },
      maximized: true,
    });
  });

  it("retains the stable id but centers defaults when saved bounds are off-screen", async () => {
    const { files } = memoryFiles(
      persisted({ bounds: { x: 5000, y: 5000, width: 1000, height: 700 }, maximized: true }),
    );
    const store = createNativeWindowStateStore({
      directory: "/data",
      displays,
      files,
      uuid: () => "new-id",
    });

    const state = await store.load();

    expect(state.windowId).toBe(uuid);
    expect(state.bounds).toEqual({ x: 220, y: 90, width: 1000, height: 720 });
    expect(state.maximized).toBe(false);
  });

  it("atomically replaces the Octant-only state file", async () => {
    const { files, operations } = memoryFiles(persisted());
    const store = createNativeWindowStateStore({
      directory: "/data",
      displays,
      files,
      uuid: () => uuid,
    });
    const state = await store.load();

    await store.save(state);

    expect(store.path).toBe(`/data/${NATIVE_WINDOW_STATE_FILENAME}`);
    expect(operations).toEqual([
      "read:/data/octant-window-state.json",
      "mkdir:/data",
      "write:/data/octant-window-state.json.1.tmp",
      "rename:/data/octant-window-state.json.1.tmp:/data/octant-window-state.json",
    ]);
  });

  it("persists a generated stable UUID before returning so crash-style reload reuses it", async () => {
    const memory = memoryFiles();
    const first = createNativeWindowStateStore({
      directory: "/data",
      displays,
      files: memory.files,
      uuid: () => uuid,
    });

    const generated = await first.load();
    const afterCrash = createNativeWindowStateStore({
      directory: "/data",
      displays,
      files: memory.files,
      uuid: () => "00000000-0000-4000-8000-000000000899",
    });

    await expect(afterCrash.load()).resolves.toEqual(generated);
    expect(memory.operations).toContain("write:/data/octant-window-state.json.1.tmp");
  });

  it("serializes concurrent saves through unique same-directory temporary files", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const operations: string[] = [];
    const store = createNativeWindowStateStore({
      directory: "/data",
      displays,
      uuid: () => uuid,
      files: {
        mkdir: async () => undefined,
        readFile: async () => persisted(),
        writeFile: async (path) => {
          operations.push(`write:${path}`);
          if (path.endsWith(".1.tmp")) await firstWrite;
        },
        rename: async (from) => void operations.push(`rename:${from}`),
      },
    });
    const state = await store.load();

    const first = store.save(state);
    const second = store.save({ ...state, maximized: true });
    await vi.waitFor(() =>
      expect(operations).toEqual(["write:/data/octant-window-state.json.1.tmp"]),
    );

    releaseFirstWrite?.();
    await Promise.all([first, second]);
    expect(operations).toEqual([
      "write:/data/octant-window-state.json.1.tmp",
      "rename:/data/octant-window-state.json.1.tmp",
      "write:/data/octant-window-state.json.2.tmp",
      "rename:/data/octant-window-state.json.2.tmp",
    ]);
  });

  it("flushes last non-maximized bounds while preserving the stable window UUID", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const state = await flushNativeWindowState(
      {
        getNormalBounds: () => ({ x: 40, y: 60, width: 1200, height: 760 }),
        isMaximized: () => true,
      },
      uuid,
      { save },
    );

    expect(state).toEqual({
      schemaVersion: 1,
      windowId: uuid,
      bounds: { x: 40, y: 60, width: 1200, height: 760 },
      maximized: true,
    });
    expect(save).toHaveBeenCalledWith(state);
  });
});
