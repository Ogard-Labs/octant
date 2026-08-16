import { describe, expect, it } from "vitest";
import {
  listRemoteShellSurfaces,
  listRemoteShellSurfacesByAvailability,
  remoteShellSurfaceAvailability,
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
