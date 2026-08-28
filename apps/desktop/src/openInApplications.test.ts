import { describe, expect, it, vi } from "vitest";
import {
  detectOpenInApplications,
  launchOpenInApplication,
  openCodeCheckoutInApplicationFromServer,
} from "./openInApplications";

describe("Open in applications", () => {
  it("reports the fixed catalogue in product order and marks only installed applications available", () => {
    const existing = new Set([
      "/Applications/Visual Studio Code.app",
      "/System/Library/CoreServices/Finder.app",
    ]);
    const result = detectOpenInApplications({
      exists: (path) => existing.has(path),
      homeDirectory: "/Users/example",
      platform: "darwin",
    });

    expect(result.map((entry) => entry.id)).toEqual([
      "vscode",
      "cursor",
      "zed",
      "finder",
      "terminal",
      "ghostty",
      "xcode",
    ]);
    expect(result.find((entry) => entry.id === "vscode")).toMatchObject({
      label: "VS Code",
      available: true,
    });
    expect(result.find((entry) => entry.id === "finder")?.available).toBe(true);
    expect(result.find((entry) => entry.id === "cursor")?.available).toBe(false);
  });

  it("detects Linux editor binaries and always offers the file manager reveal", () => {
    const result = detectOpenInApplications({
      exists: (path) => path === "/usr/bin/code",
      homeDirectory: "/home/example",
      platform: "linux",
    });
    expect(result.find((entry) => entry.id === "vscode")).toMatchObject({
      available: true,
    });
    expect(result.find((entry) => entry.id === "finder")).toMatchObject({
      label: "Files",
      available: true,
    });
    expect(result.find((entry) => entry.id === "xcode")?.available).toBe(false);
  });

  it("resolves the checkout through the authenticated desktop route before launching", async () => {
    const fetch = vi.fn(async () => Response.json({ checkoutRoot: "/private/repo" }));
    const launch = vi.fn();
    await openCodeCheckoutInApplicationFromServer({
      serverUrl: "http://127.0.0.1:13773",
      desktopBridgeSecret: "secret",
      windowId: "10000000-0000-4000-8000-000000000001",
      request: {
        threadId: "20000000-0000-4000-8000-000000000001",
        applicationId: "zed",
      },
      fetch: fetch as never,
      launch,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/desktop/code-checkout-open-target",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          windowId: "10000000-0000-4000-8000-000000000001",
          threadId: "20000000-0000-4000-8000-000000000001",
        }),
      }),
    );
    expect(launch).toHaveBeenCalledWith({ applicationId: "zed", checkoutRoot: "/private/repo" });
  });

  it("opens an installed application without a shell against the confined checkout root", () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    launchOpenInApplication({
      applicationId: "vscode",
      checkoutRoot: "/private/repo",
      exists: (path) => path === "/Applications/Visual Studio Code.app",
      homeDirectory: "/Users/example",
      platform: "darwin",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "/Applications/Visual Studio Code.app", "/private/repo"],
      { detached: true, shell: false, stdio: "ignore" },
    );
  });

  it("opens Linux applications with the binary and reveals folders through xdg-open", () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    launchOpenInApplication({
      applicationId: "vscode",
      checkoutRoot: "/home/example/repo",
      exists: (path) => path === "/usr/bin/code",
      homeDirectory: "/home/example",
      platform: "linux",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith("/usr/bin/code", ["/home/example/repo"], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });

    spawn.mockClear();
    launchOpenInApplication({
      applicationId: "finder",
      checkoutRoot: "/home/example/repo",
      exists: () => false,
      homeDirectory: "/home/example",
      platform: "linux",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith("/usr/bin/xdg-open", ["/home/example/repo"], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
  });

  it("reveals the checkout in Finder and refuses unavailable applications", () => {
    const showItemInFolder = vi.fn();
    const common = {
      checkoutRoot: "/private/repo",
      exists: (path: string) => path === "/System/Library/CoreServices/Finder.app",
      homeDirectory: "/Users/example",
      platform: "darwin" as const,
      shell: { showItemInFolder },
      spawn: vi.fn(),
    } as const;

    launchOpenInApplication({ ...common, applicationId: "finder" });
    expect(showItemInFolder).toHaveBeenCalledWith("/private/repo");
    expect(() => launchOpenInApplication({ ...common, applicationId: "zed" })).toThrow(
      "Octant could not open the selected application.",
    );
  });
});
