import { describe, expect, it, vi } from "vitest";
import {
  createNativePreviewHandoffExecutor,
  openPreviewHandoffFromServer,
  type PreviewHandoffExecutor,
} from "./previewHandoff";

const request = {
  target: {
    targetId: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    hostId: "30000000-0000-4000-8000-000000000001",
    kind: "artifact-version",
    opaqueRef: "opaque-ref-token-1",
    displayName: "report.pdf",
  },
  kind: "open-external",
} as const;

function mockExecute(overrides: Partial<PreviewHandoffExecutor> = {}): PreviewHandoffExecutor {
  return {
    revealInFinder: vi.fn(async () => undefined),
    quickLook: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mockFetch(json: unknown, ok = true): typeof globalThis.fetch {
  return vi.fn(async () =>
    ok ? Response.json(json) : new Response(JSON.stringify(json), { status: 404 }),
  ) as never;
}

describe("openPreviewHandoffFromServer", () => {
  it("resolves the opaque ref through the desktop-authenticated bridge and executes the affordance", async () => {
    const fetch = mockFetch({ handoffKind: "reveal-in-finder", path: "/private/repo/notes.md" });
    const execute = mockExecute();
    await openPreviewHandoffFromServer({
      serverUrl: "http://127.0.0.1:13773/",
      desktopBridgeSecret: "private-secret",
      windowId: request.target.targetId,
      request,
      fetch,
      execute,
    });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:13773/api/desktop/preview-handoff");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": "private-secret",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      windowId: request.target.targetId,
      ...request,
    });
    expect(execute.revealInFinder).toHaveBeenCalledWith("/private/repo/notes.md");
    expect(execute.quickLook).not.toHaveBeenCalled();
    expect(execute.openExternal).not.toHaveBeenCalled();
  });

  it("dispatches quick-look to the quick-look executor with the abort signal", async () => {
    const controller = new AbortController();
    const fetch = mockFetch({ handoffKind: "quick-look", path: "/private/repo/notes.md" });
    const execute = mockExecute();
    await openPreviewHandoffFromServer({
      serverUrl: "http://127.0.0.1:13773",
      desktopBridgeSecret: "private-secret",
      windowId: request.target.targetId,
      request: { ...request, kind: "quick-look" },
      fetch,
      execute,
      signal: controller.signal,
    });
    expect(execute.quickLook).toHaveBeenCalledWith("/private/repo/notes.md", controller.signal);
  });

  it("dispatches open-external to the open-external executor", async () => {
    const fetch = mockFetch({ handoffKind: "open-external", path: "/private/repo/notes.md" });
    const execute = mockExecute();
    await openPreviewHandoffFromServer({
      serverUrl: "http://127.0.0.1:13773",
      desktopBridgeSecret: "private-secret",
      windowId: request.target.targetId,
      request,
      fetch,
      execute,
    });
    expect(execute.openExternal).toHaveBeenCalledWith("/private/repo/notes.md");
  });

  it("redacts a host path from a server failure response", async () => {
    const fetch = mockFetch(
      { category: "unavailable", message: "/private/repo/notes.md missing" },
      false,
    );
    const execute = mockExecute();
    await expect(
      openPreviewHandoffFromServer({
        serverUrl: "http://127.0.0.1:13773",
        desktopBridgeSecret: "private-secret",
        windowId: request.target.targetId,
        request,
        fetch,
        execute,
      }),
    ).rejects.toThrow("Octant could not open the preview externally.");
    await expect(
      openPreviewHandoffFromServer({
        serverUrl: "http://127.0.0.1:13773",
        desktopBridgeSecret: "private-secret",
        windowId: request.target.targetId,
        request,
        fetch,
        execute,
      }),
    ).rejects.not.toThrow("/private/repo/notes.md");
  });

  it("redacts a host path from a transport error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("/private/repo/notes.md unreachable");
    }) as never;
    const execute = mockExecute();
    await expect(
      openPreviewHandoffFromServer({
        serverUrl: "http://127.0.0.1:13773",
        desktopBridgeSecret: "private-secret",
        windowId: request.target.targetId,
        request,
        fetch,
        execute,
      }),
    ).rejects.toThrow("Octant could not open the preview externally.");
    expect(execute.revealInFinder).not.toHaveBeenCalled();
  });

  it.each([
    [{ handoffKind: "open-external", path: "relative/notes.md" }, "relative path"],
    [{ handoffKind: "open-external", path: "/private/repo/notes.md", extra: true }, "extra key"],
    [{ handoffKind: "shell-open", path: "/private/repo/notes.md" }, "generic kind"],
    [{ handoffKind: "open-external", path: "/private/repo/notes\0.md" }, "NUL path"],
  ] as const)("rejects a malformed bridge reply (%s)", async (reply, _label) => {
    const fetch = mockFetch(reply);
    const execute = mockExecute();
    await expect(
      openPreviewHandoffFromServer({
        serverUrl: "http://127.0.0.1:13773",
        desktopBridgeSecret: "private-secret",
        windowId: request.target.targetId,
        request,
        fetch,
        execute,
      }),
    ).rejects.toThrow("Octant could not open the preview externally.");
    expect(execute.revealInFinder).not.toHaveBeenCalled();
    expect(execute.quickLook).not.toHaveBeenCalled();
    expect(execute.openExternal).not.toHaveBeenCalled();
  });
});

describe("createNativePreviewHandoffExecutor", () => {
  it("reveals in Finder through shell.showItemInFolder", async () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") };
    const executor = createNativePreviewHandoffExecutor({
      shell,
      spawn: vi.fn(),
      platform: "darwin",
    });
    await executor.revealInFinder("/private/repo/notes.md");
    expect(shell.showItemInFolder).toHaveBeenCalledWith("/private/repo/notes.md");
  });

  it("reveals and opens paths on Linux through xdg-open", async () => {
    const spawn = vi.fn();
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") };
    const executor = createNativePreviewHandoffExecutor({ shell, spawn, platform: "linux" });
    await executor.revealInFinder("/home/example/notes.md");
    await executor.openExternal("/home/example/notes.md");
    expect(spawn).toHaveBeenCalledWith("/usr/bin/xdg-open", ["/home/example/notes.md"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("opens the system default application through shell.openPath and sanitizes failures", async () => {
    const shell = {
      showItemInFolder: vi.fn(),
      openPath: vi.fn(async () => "NSFileNoApplicationError /private/secret/notes.md"),
    };
    const executor = createNativePreviewHandoffExecutor({
      shell,
      spawn: vi.fn(),
      platform: "darwin",
    });
    await expect(executor.openExternal("/private/secret/notes.md")).rejects.toThrow(
      "Octant could not open the preview externally.",
    );
  });

  it("spawns qlmanage with the path as one isolated argument and resolves on exit", async () => {
    const exitHandlers: Array<() => void> = [];
    const spawn = vi.fn(() => ({
      on: (event: string, listener: () => void) => {
        if (event === "exit") exitHandlers.push(listener);
      },
      kill: vi.fn(),
    }));
    const executor = createNativePreviewHandoffExecutor({
      shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
      spawn,
      platform: "darwin",
      quickLookLifetimeMs: 60_000,
    });
    const pending = executor.quickLook("/private/repo/notes.md");
    expect(spawn).toHaveBeenCalledWith("qlmanage", ["-p", "/private/repo/notes.md"]);
    exitHandlers[0]?.();
    await pending;
  });

  it("skips Quick Look on Linux", async () => {
    const spawn = vi.fn();
    const executor = createNativePreviewHandoffExecutor({
      shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
      spawn,
      platform: "linux",
    });
    await executor.quickLook("/home/example/notes.md");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills the Quick Look child on cancellation with a bounded lifetime", async () => {
    const controller = new AbortController();
    const kill = vi.fn();
    const spawn = vi.fn(() => ({ kill }));
    const executor = createNativePreviewHandoffExecutor({
      shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
      spawn,
      platform: "darwin",
      quickLookLifetimeMs: 60_000,
    });
    const pending = executor.quickLook("/private/repo/notes.md", controller.signal);
    controller.abort();
    await pending;
    expect(kill).toHaveBeenCalled();
  });

  it("bounds the Quick Look lifetime by killing the child when the timer fires", async () => {
    const kill = vi.fn();
    const spawn = vi.fn(() => ({ kill }));
    const executor = createNativePreviewHandoffExecutor({
      shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
      spawn,
      platform: "darwin",
      quickLookLifetimeMs: 10,
    });
    await executor.quickLook("/private/repo/notes.md");
    expect(kill).toHaveBeenCalled();
  });
});
