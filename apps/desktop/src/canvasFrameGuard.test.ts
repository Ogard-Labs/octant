import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL,
  installCanvasFrameGuards,
  type CanvasFrameGuardFrame,
  type CanvasFrameKeyInput,
  type CanvasFrameNavigation,
} from "./canvasFrameGuard";

const server = "http://127.0.0.1:3773";
const page = `${server}/api/canvas/design-page?ticket=${"a".repeat(43)}`;

function guarded(platform: NodeJS.Platform = "darwin") {
  let navigate: ((navigation: CanvasFrameNavigation) => void) | undefined;
  let key:
    | ((event: { readonly preventDefault: () => void }, input: CanvasFrameKeyInput) => void)
    | undefined;
  let focused: CanvasFrameGuardFrame | null = null;
  const send = vi.fn();
  const setWebRTCIPHandlingPolicy = vi.fn();
  installCanvasFrameGuards(
    {
      onFrameNavigate: (listener) => {
        navigate = listener;
      },
      onKeyInput: (listener) => {
        key = listener;
      },
      focusedFrame: () => focused,
      send,
      setWebRTCIPHandlingPolicy,
    },
    { serverUrl: () => server, platform },
  );
  const tryNavigate = (
    frame: CanvasFrameGuardFrame | null,
    url: string,
    isMainFrame = false,
  ): "allowed" | "cancelled" => {
    let cancelled = false;
    navigate?.({ url, isMainFrame, frame, preventDefault: () => (cancelled = true) });
    return cancelled ? "cancelled" : "allowed";
  };
  const press = (input: Partial<CanvasFrameKeyInput>): "swallowed" | "passed" => {
    let swallowed = false;
    key?.(
      { preventDefault: () => (swallowed = true) },
      {
        type: "keyDown",
        key: "Escape",
        meta: false,
        control: false,
        alt: false,
        shift: false,
        ...input,
      },
    );
    return swallowed ? "swallowed" : "passed";
  };
  return {
    tryNavigate,
    press,
    send,
    setWebRTCIPHandlingPolicy,
    focus: (frame: CanvasFrameGuardFrame | null) => {
      focused = frame;
    },
  };
}

describe("running Canvas frame guards", () => {
  it("refuses non-proxied UDP for the renderer, so a frame's WebRTC cannot go around its policy", () => {
    const guard = guarded();
    expect(guard.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
  });

  it("lets a fresh frame open its ticketed page once and cancels every navigation after it", () => {
    const guard = guarded();
    const frame = { frameTreeNodeId: 7, url: "" };
    expect(guard.tryNavigate(frame, page)).toBe("allowed");
    const loaded = { frameTreeNodeId: 7, url: page };
    for (const target of [
      "https://example.com/?x",
      `${server}/api/canvas/design-page?ticket=${"b".repeat(43)}`,
      "about:blank",
      "data:text/html,<p>x</p>",
    ]) {
      expect(guard.tryNavigate(loaded, target)).toBe("cancelled");
    }
    // A page that rewrote its own address with history is still known.
    expect(
      guard.tryNavigate({ frameTreeNodeId: 7, url: `${server}/elsewhere` }, "https://example.com"),
    ).toBe("cancelled");
  });

  it("refuses a ticketed page in a frame that already holds another page, and leaves other frames alone", () => {
    const guard = guarded();
    expect(guard.tryNavigate({ frameTreeNodeId: 3, url: "about:srcdoc" }, page)).toBe("cancelled");
    expect(
      guard.tryNavigate(
        { frameTreeNodeId: 4, url: "" },
        "https://www.youtube-nocookie.com/embed/x",
      ),
    ).toBe("allowed");
    expect(guard.tryNavigate(null, page)).toBe("cancelled");
    // The top-level document has its own guard.
    expect(
      guard.tryNavigate({ frameTreeNodeId: 1, url: "file:///app/index.html" }, page, true),
    ).toBe("allowed");
  });

  it("reads the reserved shortcut before a running frame sees it and asks the renderer to move focus", () => {
    const guard = guarded("darwin");
    guard.tryNavigate({ frameTreeNodeId: 9, url: "" }, page);
    guard.focus({ frameTreeNodeId: 9, url: page });
    expect(guard.press({ meta: true })).toBe("swallowed");
    expect(guard.send).toHaveBeenCalledWith(CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL);

    // Not the shortcut, or not a running frame: the key goes where it was going.
    guard.send.mockClear();
    expect(guard.press({})).toBe("passed");
    expect(guard.press({ meta: true, shift: true })).toBe("passed");
    expect(guard.press({ meta: true, type: "keyUp" })).toBe("passed");
    expect(guard.press({ control: true })).toBe("passed");
    guard.focus({ frameTreeNodeId: 1, url: "file:///app/index.html" });
    expect(guard.press({ meta: true })).toBe("passed");
    guard.focus(null);
    expect(guard.press({ meta: true })).toBe("passed");
    expect(guard.send).not.toHaveBeenCalled();
  });

  it("uses Control-Escape outside macOS", () => {
    const guard = guarded("linux");
    guard.tryNavigate({ frameTreeNodeId: 9, url: "" }, page);
    guard.focus({ frameTreeNodeId: 9, url: page });
    expect(guard.press({ meta: true })).toBe("passed");
    expect(guard.press({ control: true })).toBe("swallowed");
  });
});
