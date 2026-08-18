import { describe, expect, it } from "vitest";
import {
  browserSurfaceReachNote,
  browserSurfaceStatusNote,
  listMobileThreadSurfaces,
} from "./threadSurfacePresentation";

describe("the surfaces a thread offers on the phone", () => {
  it("offers the conversation and the host's browser, and names the mode it is in", () => {
    expect(listMobileThreadSurfaces({ mode: "code" })).toEqual([
      { id: "chat", label: "Thread", reach: "interactive" },
      { id: "browser", label: "Browser", reach: "interactive" },
    ]);
    expect(listMobileThreadSurfaces({ mode: "chat" })[0]?.label).toBe("Chat");
  });

  it("offers nothing this device cannot draw, however far the host would let it reach", () => {
    // Terminal, simulator, canvas, and preview are settled in the shared
    // matrix but have no view on the phone yet, so they are absent rather than
    // shown as tabs that open onto nothing.
    expect(listMobileThreadSurfaces({ mode: "code" }).map((surface) => surface.id)).not.toContain(
      "terminal",
    );
  });

  it("says what a tap does and what stays on the Mac", () => {
    expect(browserSurfaceReachNote("interactive")).toContain("Tap to click");
    expect(browserSurfaceReachNote("interactive")).toContain("stay on the Mac");
    expect(browserSurfaceReachNote("read-only")).toContain("Watching only");
    expect(browserSurfaceReachNote("unavailable")).toContain("does not share");
  });

  it("describes the picture rather than guessing at it", () => {
    expect(
      browserSurfaceStatusNote({ status: "showing", stale: false, url: "https://example.com/" }),
    ).toBe("https://example.com/");
    expect(
      browserSurfaceStatusNote({ status: "showing", stale: true, url: "https://example.com/" }),
    ).toContain("moved on");
    expect(browserSurfaceStatusNote({ status: "idle", stale: true })).toContain("No browser");
    expect(browserSurfaceStatusNote({ status: "waiting", stale: true })).toContain("Waiting");
    expect(browserSurfaceStatusNote({ status: "unavailable", stale: true })).toContain(
      "does not share",
    );
  });
});
