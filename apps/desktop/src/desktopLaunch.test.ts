import { desktopIdentity } from "@octant/host-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_BACKGROUND_SERVICE_SWITCH,
  DESKTOP_HOST_ONLY_SWITCH,
  launchDesktopApplication,
  resolvePackagedDesktopLaunch,
} from "./desktopLaunch";

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

  it("reads authenticated status before refusing the unfinished Nightly client bridge", async () => {
    const loadHost = vi.fn(async () => undefined);
    const status = vi.fn(async () => ({
      kind: "ready" as const,
      protocol: 1 as const,
      version: "0.1.0",
    }));
    expect(
      await launchDesktopApplication(desktopIdentity("nightly"), loadHost, status),
    ).toMatchObject({
      kind: "client-bridge-required",
      message: expect.stringContaining("0.1.0"),
    });
    expect(status).toHaveBeenCalledOnce();
    expect(loadHost).not.toHaveBeenCalled();
  });

  it("reports unsigned preflight refusal without importing the shared host", async () => {
    const loadHost = vi.fn(async () => undefined);
    expect(
      await launchDesktopApplication(desktopIdentity("nightly"), loadHost, async () => ({
        kind: "refused",
        reason: "unsigned-build",
      })),
    ).toMatchObject({
      kind: "client-bridge-required",
      message: expect.stringContaining("signed"),
    });
    expect(loadHost).not.toHaveBeenCalled();
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
      expect(resolvePackagedDesktopLaunch(desktopIdentity("nightly"), args)).toEqual({
        kind: "desktop",
      });
    }
  });

  it("selects only the bundled scoped terminal command", () => {
    for (const args of [["--help"], ["mcp"], ["mcp", "--help"]]) {
      expect(
        resolvePackagedDesktopLaunch(desktopIdentity("nightly"), [
          "--octant-terminal-cli",
          ...args,
        ]),
      ).toEqual({
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
    expect(resolvePackagedDesktopLaunch(desktopIdentity("nightly"), args).kind).toBe("refused");
  });
});

it("accepts only Stable's fixed packaged roles and refuses a caller-selected script", () => {
  expect(resolvePackagedDesktopLaunch(desktopIdentity("stable"), [])).toEqual({ kind: "desktop" });
  expect(
    resolvePackagedDesktopLaunch(desktopIdentity("stable"), [
      "--octant-terminal-cli",
      "mcp",
      "--help",
    ]),
  ).toEqual({ kind: "terminal", args: ["mcp", "--help"] });
  expect(
    resolvePackagedDesktopLaunch(desktopIdentity("stable"), ["--octant-canvas-prototype-host"]),
  ).toEqual({ kind: "canvas" });
  for (const args of [
    ["/tmp/arbitrary.mjs"],
    ["--inspect"],
    ["--remote-debugging-pipe"],
    ["--octant-canvas-prototype-host", "/tmp/arbitrary.mjs"],
  ]) {
    expect(resolvePackagedDesktopLaunch(desktopIdentity("stable"), args).kind).toBe("refused");
  }
});

it("starts Nightly's Canvas prototype host only while Nightly is its own test host", () => {
  const nightly = desktopIdentity("nightly");
  const testHost = {
    kind: "test-host" as const,
    dataDirectory: "/Users/test/Library/Application Support/Octant Nightly/Test Data",
    serverPort: 13_774,
    keychainServiceFamily: "octant-nightly-test-data" as const,
  };
  expect(
    resolvePackagedDesktopLaunch(nightly, ["--octant-canvas-prototype-host"], testHost),
  ).toEqual({ kind: "canvas" });
  expect(
    resolvePackagedDesktopLaunch(nightly, ["--octant-canvas-prototype-host"], {
      kind: "octant-client",
    }).kind,
  ).toBe("refused");
  for (const args of [
    ["--octant-canvas-prototype-host", "/tmp/arbitrary.mjs"],
    [DESKTOP_HOST_ONLY_SWITCH],
    ["/tmp/arbitrary.mjs"],
  ])
    expect(resolvePackagedDesktopLaunch(nightly, args, testHost).kind).toBe("refused");
});

it("accepts a host-only role only for Stable without mixed entries or runtime options", () => {
  for (const args of [[DESKTOP_HOST_ONLY_SWITCH], ["-psn_0_123", DESKTOP_HOST_ONLY_SWITCH]]) {
    expect(resolvePackagedDesktopLaunch(desktopIdentity("stable"), args)).toEqual({
      kind: "host-only",
    });
    expect(resolvePackagedDesktopLaunch(desktopIdentity("nightly"), args).kind).toBe("refused");
  }
  // The background service marks its own host-only launch so it is not stopped
  // like a Nightly client's host when no window arrives.
  expect(
    resolvePackagedDesktopLaunch(desktopIdentity("stable"), [
      DESKTOP_HOST_ONLY_SWITCH,
      DESKTOP_BACKGROUND_SERVICE_SWITCH,
    ]),
  ).toEqual({ kind: "host-only", backgroundService: true });
  for (const args of [
    [DESKTOP_BACKGROUND_SERVICE_SWITCH],
    [
      DESKTOP_HOST_ONLY_SWITCH,
      DESKTOP_BACKGROUND_SERVICE_SWITCH,
      DESKTOP_BACKGROUND_SERVICE_SWITCH,
    ],
    [DESKTOP_HOST_ONLY_SWITCH, DESKTOP_HOST_ONLY_SWITCH],
    [DESKTOP_HOST_ONLY_SWITCH, "--inspect"],
    [DESKTOP_HOST_ONLY_SWITCH, "octant://code/project/123e4567-e89b-42d3-a456-426614174000"],
    [DESKTOP_HOST_ONLY_SWITCH, "-psn_0_1", "-psn_0_2"],
  ])
    expect(resolvePackagedDesktopLaunch(desktopIdentity("stable"), args).kind).toBe("refused");
});

it("names the newer-host prerequisite when the installed Stable lacks host-only launch", async () => {
  const host = vi.fn(async () => undefined);
  expect(
    await launchDesktopApplication(desktopIdentity("nightly"), host, async () => ({
      kind: "refused",
      reason: "incompatible-host",
    })),
  ).toMatchObject({
    kind: "client-bridge-required",
    message: expect.stringContaining("Needs a newer Octant"),
  });
  expect(host).not.toHaveBeenCalled();
});

it("asks a Linux person to open Octant when no launch recorded it, and names the sandbox refusal", async () => {
  const host = vi.fn(async () => undefined);
  expect(
    await launchDesktopApplication(desktopIdentity("nightly"), host, async () => ({
      kind: "refused",
      reason: "no-launcher-record",
    })),
  ).toEqual({ kind: "client-bridge-required", message: "Open Octant, then try again." });
  expect(
    await launchDesktopApplication(desktopIdentity("nightly"), host, async () => ({
      kind: "refused",
      reason: "unsandboxed-renderer",
    })),
  ).toMatchObject({
    kind: "client-bridge-required",
    message: expect.stringContaining("Chromium's sandbox"),
  });
  expect(host).not.toHaveBeenCalled();
});

describe("Linux display flags", () => {
  const octant = desktopIdentity("stable");
  const nightly = desktopIdentity("nightly");
  const link = "octant://code/project/123e4567-e89b-42d3-a456-426614174000";
  const allowed = [
    ["--ozone-platform=wayland"],
    ["--ozone-platform-hint=auto"],
    ["--ozone-platform=x11", "--enable-features=UseOzonePlatform,WaylandWindowDecorations"],
    ["--disable-features=VaapiVideoDecoder"],
    ["--enable-wayland-ime", "--wayland-text-input-version=3"],
    ["--disable-gpu", "--disable-gpu-compositing"],
    ["--force-device-scale-factor=1.5"],
  ];

  it("accepts the closed display list beside each role on Linux, for both apps", () => {
    for (const flags of allowed) {
      expect(resolvePackagedDesktopLaunch(octant, flags, undefined, "linux").kind).toBe("desktop");
      expect(resolvePackagedDesktopLaunch(nightly, flags, undefined, "linux").kind).toBe("desktop");
      expect(
        resolvePackagedDesktopLaunch(
          octant,
          [...flags, DESKTOP_HOST_ONLY_SWITCH],
          undefined,
          "linux",
        ).kind,
      ).toBe("host-only");
      expect(resolvePackagedDesktopLaunch(octant, [...flags, link], undefined, "linux").kind).toBe(
        "desktop",
      );
    }
  });

  it("refuses sandbox, debugging, loader and unknown flags, bad values and repeats", () => {
    for (const flags of [
      ["--no-sandbox"],
      ["--disable-seccomp-filter-sandbox"],
      ["--disable-setuid-sandbox"],
      ["--inspect"],
      ["--remote-debugging-port=9222"],
      ["--js-flags=--expose-gc"],
      ["--require=/tmp/x.js"],
      ["/tmp/script.js"],
      ["--use-gl=egl"],
      ["--ozone-platform=headless"],
      ["--ozone-platform"],
      ["--enable-features=RunAllFlashInAllowMode"],
      ["--enable-features=UseOzonePlatform,UseOzonePlatform"],
      ["--enable-features="],
      ["--wayland-text-input-version=2"],
      ["--force-device-scale-factor=0"],
      ["--force-device-scale-factor=9"],
      ["--force-device-scale-factor=1e1"],
      ["--disable-gpu=1"],
      ["--disable-gpu", "--disable-gpu"],
      ["--ozone-platform=wayland", "--no-sandbox"],
    ]) {
      expect(resolvePackagedDesktopLaunch(octant, flags, undefined, "linux").kind).toBe("refused");
      expect(resolvePackagedDesktopLaunch(nightly, flags, undefined, "linux").kind).toBe("refused");
    }
  });

  it("keeps display flags refused on macOS", () => {
    expect(
      resolvePackagedDesktopLaunch(octant, ["--ozone-platform=wayland"], undefined, "darwin").kind,
    ).toBe("refused");
  });
});
