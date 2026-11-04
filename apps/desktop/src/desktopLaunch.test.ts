import { desktopIdentity } from "@octant/host-runtime";
import { describe, expect, it, vi } from "vitest";
import { launchDesktopApplication, resolveNightlyLaunch } from "./desktopLaunch";

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

describe("Nightly's fixed packaged entry", () => {
  it("accepts an ordinary app launch, Launch Services token, or its own Code link", () => {
    for (const args of [
      [],
      ["-psn_0_123"],
      ["octant-nightly://code/project/123e4567-e89b-42d3-a456-426614174000"],
    ]) {
      expect(resolveNightlyLaunch(args)).toEqual({ kind: "desktop" });
    }
  });

  it("selects only the bundled scoped terminal command", () => {
    for (const args of [["--help"], ["mcp"], ["mcp", "--help"]]) {
      expect(resolveNightlyLaunch(["--octant-terminal-cli", ...args])).toEqual({
        kind: "terminal",
        args,
      });
    }
  });

  it.each([
    ["/tmp/arbitrary.mjs"],
    ["--remote-debugging-port=9222"],
    ["--remote-debugging-pipe"],
    ["--inspect"],
    ["--inspect-brk=9229"],
    ["--require", "/tmp/arbitrary.cjs"],
    ["--import=/tmp/arbitrary.mjs"],
    ["--js-flags=--expose-gc"],
    ["--no-sandbox"],
    ["--octant-canvas-prototype-host"],
    ["--unknown"],
    ["--", "/tmp/arbitrary.mjs"],
    ["--octant-terminal-cli", "mcp", "--remote-debugging-port=9222"],
    ["--octant-terminal-cli", "host", "start"],
    ["octant://code/project/123e4567-e89b-42d3-a456-426614174000"],
    ["x".repeat(16385)],
    Array.from({ length: 65 }, () => "-psn_0_1"),
  ])("refuses an unrecognized entry or runtime override %#", (...args) => {
    expect(resolveNightlyLaunch(args).kind).toBe("refused");
  });
});
