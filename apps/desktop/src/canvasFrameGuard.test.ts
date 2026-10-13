import { describe, expect, it, vi } from "vitest";
import {
  installCanvasFrameGuards,
  isolateEachCanvasFrameDocument,
  type CanvasFrameNavigation,
} from "./canvasFrameGuard";

const server = "http://127.0.0.1:3773";
const page = `${server}/api/canvas/design-page?ticket=${"a".repeat(43)}`;

function guarded(serverUrl: string | null = server) {
  let navigate: ((navigation: CanvasFrameNavigation) => void) | undefined;
  const setWebRTCIPHandlingPolicy = vi.fn();
  installCanvasFrameGuards(
    {
      onFrameNavigate: (listener) => {
        navigate = listener;
      },
      setWebRTCIPHandlingPolicy,
    },
    { serverUrl: () => serverUrl ?? undefined },
  );
  const tryNavigate = (url: string, isMainFrame = false): "allowed" | "cancelled" => {
    let cancelled = false;
    navigate?.({ url, isMainFrame, preventDefault: () => (cancelled = true) });
    return cancelled ? "cancelled" : "allowed";
  };
  return { tryNavigate, setWebRTCIPHandlingPolicy };
}

describe("app window frame guards", () => {
  it("refuses non-proxied UDP for the renderer", () => {
    expect(guarded().setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
  });

  it("never lets a frame of the app window load the host's design page, so a prototype cannot run uncontained there", () => {
    const guard = guarded();
    expect(guard.tryNavigate(page)).toBe("cancelled");
    expect(guard.tryNavigate(`${server}/api/canvas/design-page`)).toBe("cancelled");
  });

  it("leaves other frames, other hosts, and the top-level document alone", () => {
    const guard = guarded();
    expect(guard.tryNavigate("about:blank")).toBe("allowed");
    expect(guard.tryNavigate(`${server}/api/canvas/other`)).toBe("allowed");
    expect(guard.tryNavigate(page.replace("3773", "9999"))).toBe("allowed");
    expect(guard.tryNavigate("not a url")).toBe("allowed");
    expect(guard.tryNavigate(page, true)).toBe("allowed");
  });

  it("cancels nothing while no host is known", () => {
    expect(guarded(null).tryNavigate(page)).toBe("allowed");
  });
});

describe("sandboxed frame processes", () => {
  it("gives each sandboxed document its own process, keeping features already enabled", () => {
    const appended: Array<[string, string | undefined]> = [];
    isolateEachCanvasFrameDocument({
      hasSwitch: (name) => name === "enable-features",
      getSwitchValue: () => "Existing",
      appendSwitch: (name, value) => appended.push([name, value]),
    });
    expect(appended).toEqual([
      ["enable-features", "Existing,IsolateSandboxedIframes:grouping/per-document"],
    ]);
  });
});
