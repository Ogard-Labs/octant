import { describe, expect, it } from "vitest";
import {
  browserSurfaceReachNote,
  browserSurfaceStatusNote,
  conversationComposerAccess,
  listMobileThreadSurfaces,
} from "./threadSurfacePresentation";

describe("the surfaces a thread offers on the phone", () => {
  it("offers the conversation and the host's browser, and names the mode it is in", () => {
    const full = { session: { actsAsHostPerson: false, accessLevel: "full" as const } };
    expect(listMobileThreadSurfaces({ mode: "code", ...full })).toEqual([
      { id: "chat", label: "Thread", reach: "interactive" },
      { id: "browser", label: "Browser", reach: "interactive" },
    ]);
    expect(listMobileThreadSurfaces({ mode: "chat", ...full })[0]?.label).toBe("Chat");
    // Standing unread or unreadable fails closed rather than editable.
    expect(listMobileThreadSurfaces({ mode: "code" }).map((surface) => surface.reach)).toEqual([
      "read-only",
      "read-only",
    ]);
  });

  it("disables the composer with a reason when the pairing only lets the device watch", () => {
    const watching = listMobileThreadSurfaces({
      mode: "chat",
      session: { actsAsHostPerson: false, accessLevel: "read-only" },
    });
    expect(watching.find((surface) => surface.id === "chat")?.reach).toBe("read-only");
    const access = conversationComposerAccess(watching);
    expect(access.editable).toBe(false);
    expect(access.reason).toContain("Watching only");

    expect(
      conversationComposerAccess(
        listMobileThreadSurfaces({
          mode: "chat",
          session: { actsAsHostPerson: false, accessLevel: "full" },
        }),
      ).editable,
    ).toBe(true);
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
