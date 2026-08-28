import { describe, expect, it, vi } from "vitest";
import {
  detectOpenInApplications,
  launchOpenInApplication,
  openCodeCheckoutInApplicationFromServer,
} from "./openInApplications";

function mockSpawnedChild(outcome: "spawn" | "error" = "spawn") {
  return {
    unref: vi.fn(),
    once: (event: string, listener: (error?: Error) => void) => {
      if (event === outcome) {
        queueMicrotask(() => listener(outcome === "error" ? new Error("spawn ENOENT") : undefined));
      }
    },
  };
}

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

  it("detects Linux editor binaries and offers Files only when xdg-open is on PATH", () => {
    const withXdg = detectOpenInApplications({
      exists: (path) => path === "/usr/bin/code" || path === "/usr/bin/xdg-open",
      homeDirectory: "/home/example",
      platform: "linux",
      pathEnv: "/usr/bin",
    });
    expect(withXdg.find((entry) => entry.id === "vscode")).toMatchObject({
      available: true,
    });
    expect(withXdg.find((entry) => entry.id === "finder")).toMatchObject({
      label: "Files",
      available: true,
    });
    expect(withXdg.find((entry) => entry.id === "xcode")?.available).toBe(false);

    const withoutXdg = detectOpenInApplications({
      exists: (path) => path === "/usr/bin/code",
      homeDirectory: "/home/example",
      platform: "linux",
      pathEnv: "/usr/bin",
    });
    expect(withoutXdg.find((entry) => entry.id === "finder")).toMatchObject({
      label: "Files",
      available: false,
    });
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

  it("opens an installed application without a shell against the confined checkout root", async () => {
    const spawn = vi.fn(() => mockSpawnedChild());
    await launchOpenInApplication({
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

  it("opens Linux applications with the binary and reveals folders through PATH-resolved xdg-open", async () => {
    const spawn = vi.fn(() => mockSpawnedChild());
    await launchOpenInApplication({
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
    await launchOpenInApplication({
      applicationId: "finder",
      checkoutRoot: "/home/example/repo",
      exists: (path) => path === "/usr/local/bin/xdg-open",
      homeDirectory: "/home/example",
      platform: "linux",
      pathEnv: "/usr/local/bin:/usr/bin",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith("/usr/local/bin/xdg-open", ["/home/example/repo"], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
  });

  it("opens Linux terminals with working-directory flags instead of a positional path", async () => {
    const spawn = vi.fn(() => mockSpawnedChild());
    await launchOpenInApplication({
      applicationId: "terminal",
      checkoutRoot: "/home/example/repo",
      exists: (path) => path === "/usr/bin/gnome-terminal",
      homeDirectory: "/home/example",
      platform: "linux",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/gnome-terminal",
      ["--working-directory=/home/example/repo"],
      { detached: true, shell: false, stdio: "ignore" },
    );

    spawn.mockClear();
    await launchOpenInApplication({
      applicationId: "terminal",
      checkoutRoot: "/home/example/repo",
      exists: (path) => path === "/usr/bin/konsole",
      homeDirectory: "/home/example",
      platform: "linux",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith("/usr/bin/konsole", ["--workdir", "/home/example/repo"], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });

    spawn.mockClear();
    await launchOpenInApplication({
      applicationId: "ghostty",
      checkoutRoot: "/home/example/repo",
      exists: (path) => path === "/usr/bin/ghostty",
      homeDirectory: "/home/example",
      platform: "linux",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/ghostty",
      ["--working-directory=/home/example/repo"],
      { detached: true, shell: false, stdio: "ignore" },
    );

    spawn.mockClear();
    await launchOpenInApplication({
      applicationId: "terminal",
      checkoutRoot: "/home/example/repo",
      exists: (path) => path === "/usr/bin/x-terminal-emulator",
      homeDirectory: "/home/example",
      platform: "linux",
      shell: { showItemInFolder: vi.fn() },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith("/usr/bin/x-terminal-emulator", [], {
      detached: true,
      shell: false,
      stdio: "ignore",
      cwd: "/home/example/repo",
    });
  });

  it("rejects when Linux xdg-open is missing from PATH", async () => {
    await expect(
      launchOpenInApplication({
        applicationId: "finder",
        checkoutRoot: "/home/example/repo",
        exists: () => false,
        homeDirectory: "/home/example",
        platform: "linux",
        pathEnv: "/usr/bin",
        shell: { showItemInFolder: vi.fn() },
        spawn: vi.fn(),
      }),
    ).rejects.toThrow("Octant could not open the selected application.");
  });

  it("propagates asynchronous Linux spawn failures through the launch promise", async () => {
    const spawn = vi.fn(() => mockSpawnedChild("error"));
    await expect(
      launchOpenInApplication({
        applicationId: "vscode",
        checkoutRoot: "/home/example/repo",
        exists: (path) => path === "/usr/bin/code",
        homeDirectory: "/home/example",
        platform: "linux",
        shell: { showItemInFolder: vi.fn() },
        spawn,
      }),
    ).rejects.toThrow("Octant could not open the selected application.");
  });

  it("reveals the checkout in Finder and refuses unavailable applications", async () => {
    const showItemInFolder = vi.fn();
    const common = {
      checkoutRoot: "/private/repo",
      exists: (path: string) => path === "/System/Library/CoreServices/Finder.app",
      homeDirectory: "/Users/example",
      platform: "darwin" as const,
      shell: { showItemInFolder },
      spawn: vi.fn(() => mockSpawnedChild()),
    } as const;

    await launchOpenInApplication({ ...common, applicationId: "finder" });
    expect(showItemInFolder).toHaveBeenCalledWith("/private/repo");
    await expect(launchOpenInApplication({ ...common, applicationId: "zed" })).rejects.toThrow(
      "Octant could not open the selected application.",
    );
  });
});
