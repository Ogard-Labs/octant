import type {
  CaptureWindowList,
  CaptureWindowPermissionOutcome,
  CaptureWindowResult,
} from "@octant/contracts/desktop-bridge";

type ScreenAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

interface CaptureSource {
  readonly id: string;
  readonly name: string;
}

export interface WindowCapturePorts<TSource extends CaptureSource = CaptureSource> {
  readonly platform: NodeJS.Platform;
  /** `systemPreferences.getMediaAccessStatus("screen")`: reads the grant, never prompts. */
  readonly screenAccess: () => ScreenAccess;
  /**
   * `desktopCapturer.getSources` for windows with a zero-size thumbnail: ids
   * and titles only, no window's pixels. It takes no size on purpose. A
   * non-zero thumbnail size makes Electron read the pixels of every open
   * window, so nothing here may ask for one. The first call after install is
   * what makes macOS show its Screen Recording prompt.
   */
  readonly windowSources: () => Promise<ReadonlyArray<TSource>>;
  /**
   * One frame of exactly this window, as PNG bytes, or undefined when the
   * window cannot be read. The stream is opened for the chosen source alone.
   */
  readonly grabFrame: (source: TSource) => Promise<Uint8Array | undefined>;
  readonly openScreenRecordingSettings: () => Promise<void>;
}

/** Under the attachment limit, so a capture that is too big is explained here, not refused later. */
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const MAX_WINDOW_NAME = 120;

/**
 * Attach-a-window-capture support for the desktop shell. Three steps keep the
 * person in control: listing reads only window titles, asking for the macOS
 * permission happens only after the renderer explained it and the person
 * agreed, and a capture reads exactly one window the person picked.
 */
export function createWindowCapture<TSource extends CaptureSource>(
  ports: WindowCapturePorts<TSource>,
) {
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
      const sources = await ports.windowSources();
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
        await ports.windowSources().catch(() => []);
        if (lacksAccess() === undefined) return { kind: "granted" };
      } else {
        await ports.openScreenRecordingSettings();
      }
      return { kind: "needs-settings" };
    },
    capture: async (windowId: string): Promise<CaptureWindowResult> => {
      if (!supported) return { kind: "failed", message: "Window capture needs macOS." };
      if (lacksAccess() !== undefined) return { kind: "permission-needed" };
      let source: TSource | undefined;
      try {
        source = (await ports.windowSources()).find((candidate) => candidate.id === windowId);
      } catch {
        return { kind: "failed", message: "macOS did not let Octant read that window." };
      }
      if (source === undefined) return { kind: "gone" };
      let bytes: Uint8Array | undefined;
      try {
        bytes = await ports.grabFrame(source);
      } catch {
        bytes = undefined;
      }
      if (bytes === undefined || bytes.byteLength === 0)
        return {
          kind: "failed",
          message: "That window is empty or minimized, so it has no picture.",
        };
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
