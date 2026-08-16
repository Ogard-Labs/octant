import { join } from "node:path";

export const NATIVE_WINDOW_STATE_FILENAME = "octant-window-state.json";
export const MINIMUM_WINDOW_SIZE = { width: 900, height: 600 } as const;
export const DEFAULT_WINDOW_SIZE = { width: 1000, height: 720 } as const;

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeWindowState {
  readonly schemaVersion: 1;
  readonly windowId: string;
  readonly bounds: WindowBounds;
  readonly maximized: boolean;
}

export interface NativeWindowStateFilePort {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}

export interface NativeWindowStateStore {
  readonly path: string;
  readonly load: () => Promise<NativeWindowState>;
  readonly save: (state: NativeWindowState) => Promise<void>;
}

export interface NativeWindowStateWindowPort {
  readonly getNormalBounds: () => WindowBounds;
  readonly isMaximized: () => boolean;
}

export async function flushNativeWindowState(
  window: NativeWindowStateWindowPort,
  windowId: string,
  store: Pick<NativeWindowStateStore, "save">,
): Promise<NativeWindowState> {
  const state: NativeWindowState = {
    schemaVersion: 1,
    windowId,
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
  };
  await store.save(state);
  return state;
}

interface CreateNativeWindowStateStoreOptions {
  readonly directory: string;
  readonly displays: readonly WindowBounds[];
  readonly files: NativeWindowStateFilePort;
  readonly uuid: () => string;
}

export function createNativeWindowStateStore(
  options: CreateNativeWindowStateStoreOptions,
): NativeWindowStateStore {
  const path = join(options.directory, NATIVE_WINDOW_STATE_FILENAME);
  let saveSequence = 0;
  let saveTail: Promise<void> = Promise.resolve();
  const save = (state: NativeWindowState): Promise<void> => {
    const temporaryPath = `${path}.${++saveSequence}.tmp`;
    const operation = saveTail.then(async () => {
      await options.files.mkdir(options.directory);
      await options.files.writeFile(temporaryPath, `${JSON.stringify(state)}\n`);
      await options.files.rename(temporaryPath, path);
    });
    saveTail = operation.catch(() => undefined);
    return operation;
  };
  return {
    path,
    load: async () => {
      const decoded = await readState(options.files, path);
      if (decoded === undefined) {
        const generated = centeredNativeWindowState(options.displays, options.uuid());
        await save(generated);
        return generated;
      }

      const display = intersectingDisplay(decoded.bounds, options.displays);
      if (display === undefined) {
        const recovered = {
          ...centeredNativeWindowState(options.displays, decoded.windowId),
          maximized: false,
        };
        await save(recovered);
        return recovered;
      }

      const restored = {
        ...decoded,
        bounds: clampBounds(decoded.bounds, display),
      };
      if (!sameBounds(restored.bounds, decoded.bounds)) await save(restored);
      return restored;
    },
    save,
  };
}

function sameBounds(left: WindowBounds, right: WindowBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

async function readState(
  files: NativeWindowStateFilePort,
  path: string,
): Promise<NativeWindowState | undefined> {
  try {
    return decodeState(JSON.parse(await files.readFile(path)));
  } catch {
    return undefined;
  }
}

function decodeState(value: unknown): NativeWindowState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !isUuid(candidate.windowId) ||
    typeof candidate.maximized !== "boolean" ||
    !isBounds(candidate.bounds)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    windowId: candidate.windowId,
    bounds: candidate.bounds,
    maximized: candidate.maximized,
  };
}

export function centeredNativeWindowState(
  displays: readonly WindowBounds[],
  windowId: string,
): NativeWindowState {
  const display = displays[0] ?? { x: 0, y: 0, width: 1440, height: 900 };
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, display.width);
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, display.height);
  return {
    schemaVersion: 1,
    windowId,
    bounds: {
      x: Math.round(display.x + (display.width - width) / 2),
      y: Math.round(display.y + (display.height - height) / 2),
      width,
      height,
    },
    maximized: false,
  };
}

function intersectingDisplay(
  bounds: WindowBounds,
  displays: readonly WindowBounds[],
): WindowBounds | undefined {
  let selected: WindowBounds | undefined;
  let selectedArea = 0;
  for (const display of displays) {
    const intersectionWidth = Math.max(
      0,
      Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x),
    );
    const intersectionHeight = Math.max(
      0,
      Math.min(bounds.y + bounds.height, display.y + display.height) -
        Math.max(bounds.y, display.y),
    );
    const area = intersectionWidth * intersectionHeight;
    if (intersectionWidth >= 64 && intersectionHeight >= 64 && area > selectedArea) {
      selected = display;
      selectedArea = area;
    }
  }
  return selected;
}

function clampBounds(bounds: WindowBounds, display: WindowBounds): WindowBounds {
  const width = Math.min(display.width, Math.max(MINIMUM_WINDOW_SIZE.width, bounds.width));
  const height = Math.min(display.height, Math.max(MINIMUM_WINDOW_SIZE.height, bounds.height));
  return {
    x: Math.min(Math.max(bounds.x, display.x), display.x + display.width - width),
    y: Math.min(Math.max(bounds.y, display.y), display.y + display.height - height),
    width,
    height,
  };
}

function isBounds(value: unknown): value is WindowBounds {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const bounds = value as Record<string, unknown>;
  const { x, y, width, height } = bounds;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return false;
  }
  return (
    [x, y, width, height].every((part) => Number.isFinite(part) && Number.isInteger(part)) &&
    width > 0 &&
    height > 0
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
