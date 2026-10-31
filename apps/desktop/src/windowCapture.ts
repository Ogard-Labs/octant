import type {
  CaptureWindowList,
  CaptureWindowPermissionOutcome,
  CaptureWindowResult,
} from "@octant/contracts/desktop-bridge";

type ScreenAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

interface CaptureSource {
  readonly id: string;
  readonly name: string;
  readonly thumbnail: {
    readonly isEmpty: () => boolean;
    readonly toPNG: () => Uint8Array;
  };
}

export interface WindowCapturePorts {
  readonly platform: NodeJS.Platform;
  /** `systemPreferences.getMediaAccessStatus("screen")`: reads the grant, never prompts. */
  readonly screenAccess: () => ScreenAccess;
  /**
   * `desktopCapturer.getSources` for windows. A zero thumbnail size lists
   * names without reading any window's pixels. The first call after install
   * is what makes macOS show its Screen Recording prompt.
   */
  readonly windowSources: (thumbnail: {
    readonly width: number;
    readonly height: number;
  }) => Promise<ReadonlyArray<CaptureSource>>;
  readonly openScreenRecordingSettings: () => Promise<void>;
}

/** Larger than any display; the capture keeps the window's own aspect ratio. */
const CAPTURE_LIMIT = { width: 3840, height: 3840 } as const;
/** Under the attachment limit, so a capture that is too big is explained here, not refused later. */
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const MAX_WINDOW_NAME = 120;

/**
 * Attach-a-window-capture support for the desktop shell. Three steps keep the
 * person in control: listing reads only window titles, asking for the macOS
 * permission happens only after the renderer explained it and the person
 * agreed, and a capture reads exactly one window the person picked.
 */
export function createWindowCapture(ports: WindowCapturePorts) {
  const supported = ports.platform === "darwin";

  function lacksAccess(): "not-determined" | "denied" | "restricted" | undefined {
    const access = ports.screenAccess();
    return access === "not-determined" || access === "denied" || access === "restricted"
      ? access
      : undefined;
  }

  return {
    list: async (): Promise<CaptureWindowList> => {
      if (!supported) return { kind: "windows", windows: [] };
      const missing = lacksAccess();
      if (missing !== undefined) return { kind: "permission-needed", access: missing };
      const sources = await ports.windowSources({ width: 0, height: 0 });
      return {
        kind: "windows",
        windows: sources
          .filter((source) => source.name.trim().length > 0)
          .map((source) => ({
            id: source.id,
            name: source.name.trim().slice(0, MAX_WINDOW_NAME),
          })),
      };
    },
    requestPermission: async (): Promise<CaptureWindowPermissionOutcome> => {
      if (!supported) return { kind: "needs-settings" };
      const before = lacksAccess();
      if (before === undefined) return { kind: "granted" };
      if (before === "not-determined") {
        // The only way to make macOS ask is to use the capture API once.
        await ports.windowSources({ width: 0, height: 0 }).catch(() => []);
        if (lacksAccess() === undefined) return { kind: "granted" };
      } else {
        await ports.openScreenRecordingSettings();
      }
      return { kind: "needs-settings" };
    },
    capture: async (windowId: string): Promise<CaptureWindowResult> => {
      if (!supported) return { kind: "failed", message: "Window capture needs macOS." };
      if (lacksAccess() !== undefined) return { kind: "permission-needed" };
      let sources: ReadonlyArray<CaptureSource>;
      try {
        sources = await ports.windowSources(CAPTURE_LIMIT);
      } catch {
        return { kind: "failed", message: "macOS did not let Octant read that window." };
      }
      const source = sources.find((candidate) => candidate.id === windowId);
      if (source === undefined) return { kind: "gone" };
      if (source.thumbnail.isEmpty())
        return {
          kind: "failed",
          message: "That window is empty or minimized, so it has no picture.",
        };
      const bytes = source.thumbnail.toPNG();
      if (bytes.byteLength === 0) return { kind: "failed", message: "That window has no picture." };
      if (bytes.byteLength > MAX_CAPTURE_BYTES)
        return { kind: "failed", message: "That window is too large to attach as an image." };
      return {
        kind: "captured",
        name: source.name.trim().slice(0, MAX_WINDOW_NAME) || "Window",
        mimeType: "image/png",
        bytes,
      };
    },
  };
}

export type WindowCapture = ReturnType<typeof createWindowCapture>;
