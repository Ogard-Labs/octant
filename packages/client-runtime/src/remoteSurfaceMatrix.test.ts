import { describe, expect, it } from "vitest";
import {
  listRemoteShellSurfaces,
  listRemoteShellSurfacesByAvailability,
  listRemoteThreadSurfaces,
  listRemoteThreadSurfacesByReach,
  remoteShellSurfaceAvailability,
  remoteThreadSurfaceReach,
} from "./remoteSurfaceMatrix";

describe("remoteSurfaceMatrix", () => {
  it("classifies mode and auxiliary surfaces as remote-approvable", () => {
    for (const surface of listRemoteShellSurfacesByAvailability("remote")) {
      expect(remoteShellSurfaceAvailability(surface)).toBe("remote");
    }
    expect(listRemoteShellSurfacesByAvailability("remote").map((surface) => surface.id)).toEqual([
      "chat",
      "work",
      "code",
      "preview",
      "provider-models",
      "settings-read",
    ]);
  });

  it("classifies desktop-only surfaces as local-host-only", () => {
    for (const surface of listRemoteShellSurfacesByAvailability("local-host-only")) {
      expect(remoteShellSurfaceAvailability(surface)).toBe("local-host-only");
    }
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only").map((surface) => surface.id),
    ).toEqual([
      "approvals",
      "extension-install",
      "provider-credentials",
      "listener-controls",
      "host-controls",
    ]);
  });

  it("keeps host lifecycle controls off the remote surface even if the descriptor drifts", () => {
    const hostControls = listRemoteShellSurfaces().find(
      (surface) => surface.id === "host-controls",
    );
    expect(hostControls).toBeDefined();
    expect(remoteShellSurfaceAvailability(hostControls!)).toBe("local-host-only");
  });

  it("lists every declared surface exactly once", () => {
    expect(listRemoteShellSurfaces()).toHaveLength(11);
  });
});

describe("the surfaces a companion client may watch a thread through", () => {
  it("lets a paired device act only where the catalog says acting is remote work", () => {
    expect(listRemoteThreadSurfacesByReach("interactive").map((surface) => surface.id)).toEqual([
      "chat",
      "browser",
    ]);
  });

  it("keeps a terminal watchable and never typeable from a companion client", () => {
    const terminal = listRemoteThreadSurfaces().find((surface) => surface.id === "terminal");
    if (terminal === undefined) throw new Error("the terminal surface is missing");
    expect(remoteThreadSurfaceReach(terminal)).toBe("read-only");
  });

  it("reports a surface whose read the catalog does not allow as unavailable", () => {
    expect(
      remoteThreadSurfaceReach({
        id: "simulator",
        label: "Simulator",
        description: "",
        observeAction: "never.catalogued",
      }),
    ).toBe("unavailable");
  });

  it("falls back to watching when only the interaction is host work", () => {
    expect(
      remoteThreadSurfaceReach({
        id: "browser",
        label: "Browser",
        description: "",
        observeAction: "browser.observe",
        interactAction: "browser.session.manage",
      }),
    ).toBe("read-only");
  });

  it("offers every declared thread surface exactly once", () => {
    expect(listRemoteThreadSurfaces().map((surface) => surface.id)).toEqual([
      "chat",
      "browser",
      "terminal",
      "simulator",
      "canvas",
      "preview",
    ]);
  });
});
