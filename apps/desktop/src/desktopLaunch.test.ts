import { desktopIdentity } from "@octant/host-runtime";
import { describe, expect, it, vi } from "vitest";
import { launchDesktopApplication } from "./desktopLaunch";

describe("packaged desktop launch", () => {
  it("refuses Nightly before loading the module that initializes credentials and shared host paths", async () => {
    const loadHostOwningDesktop = vi.fn(async () => undefined);
    expect(
      await launchDesktopApplication(desktopIdentity("nightly"), loadHostOwningDesktop),
    ).toMatchObject({
      kind: "client-bridge-required",
      message: expect.stringContaining("Needs a newer Octant"),
    });
    expect(loadHostOwningDesktop).not.toHaveBeenCalled();
  });

  it("preserves stable's existing desktop entry", async () => {
    const loadHostOwningDesktop = vi.fn(async () => undefined);
    expect(
      await launchDesktopApplication(desktopIdentity("stable"), loadHostOwningDesktop),
    ).toEqual({ kind: "started" });
    expect(loadHostOwningDesktop).toHaveBeenCalledOnce();
  });
});
