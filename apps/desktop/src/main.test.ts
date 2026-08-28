import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAsDefaultProtocolClient: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  nativeTheme: {
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  },
  powerMonitor: {},
  screen: {},
  systemPreferences: {},
}));

import {
  installProviderCredentialIpcHandlers,
  installPrivateListenerIpcHandlers,
  installRemoteDeviceIpcHandlers,
  installHostIdentityIpcHandlers,
  shutdownManagedServerResources,
  startManagedServerResources,
  createMainBrowserWindowOptions,
  createTrustedRendererRequestRegistry,
  decorateTrustedRendererHeaders,
  prepareDevelopmentRendererUrl,
  createDesktopWindowContextRegistry,
  createProjectWindowAuthorityLifecycle,
  createProjectWindowPreparationCleanup,
  requestProjectWindowWhileRunning,
  resolveDesktopDataDirectory,
  resolveDesktopHostCapabilities,
  resolveCodeFileHelperPath,
  resolveKeychainHelperPath,
  validateProjectWindowTarget,
} from "./main";
import type { RemoteDeviceControlService } from "./remoteDeviceControls";
import type { CredentialStore } from "@octant/host-runtime";
import { ProjectWindowAuthorityUnavailableError } from "./projectRootPicker";

describe("packaged desktop storage identity", () => {
  it("uses the canonical Octant Application Support directory", () => {
    expect(resolveDesktopDataDirectory(undefined, "/Users/test/Library/Application Support")).toBe(
      "/Users/test/Library/Application Support/Octant",
    );
  });

  it("preserves an explicit isolated data directory", () => {
    expect(
      resolveDesktopDataDirectory("/tmp/octant-qa", "/Users/test/Library/Application Support"),
    ).toBe("/private/tmp/octant-qa");
  });
});

describe("packaged desktop host capabilities", () => {
  it("reports vibrancy support only for the native macOS host", () => {
    expect(resolveDesktopHostCapabilities("darwin")).toEqual({
      liveBrowserSupported: false,
      liveSimulatorFrameSupported: true,
      sidebarVibrancySupported: true,
    });
    expect(resolveDesktopHostCapabilities("linux")).toEqual({
      liveBrowserSupported: false,
      liveSimulatorFrameSupported: false,
      sidebarVibrancySupported: false,
    });
    expect(resolveDesktopHostCapabilities("darwin", true)).toEqual({
      liveBrowserSupported: true,
      liveSimulatorFrameSupported: true,
      sidebarVibrancySupported: true,
    });
  });
});

describe("development renderer startup", () => {
  it("carries the window, server, and development authority parameters to Vite", () => {
    const url = new URL(
      prepareDevelopmentRendererUrl(
        "http://localhost:5173/?existing=keep",
        "window-a",
        "http://127.0.0.1:13773",
      ),
    );
    expect(url.searchParams.get("existing")).toBe("keep");
    expect(url.searchParams.get("windowId")).toBe("window-a");
    expect(url.searchParams.get("serverUrl")).toBe("http://127.0.0.1:13773");
    expect(url.searchParams.get("developmentWebBootstrap")).toBe("1");
  });

  it("strips forged renderer identity and injects it only for the trusted shell frame", () => {
    const context = {
      serverOrigin: "http://127.0.0.1:13773",
      rendererIdentity: "A".repeat(43),
      developmentOrigin: "http://localhost:5173",
    };
    const trusted = decorateTrustedRendererHeaders({
      requestHeaders: { "X-Octant-Renderer-Identity": "forged", accept: "application/json" },
      requestUrl: "http://127.0.0.1:13773/api/shell/bootstrap",
      frameUrl: "http://localhost:5173/?serverUrl=http%3A%2F%2F127.0.0.1%3A13773",
      context,
    });
    expect(trusted).toMatchObject({
      accept: "application/json",
      "x-octant-renderer-identity": context.rendererIdentity,
    });
    expect(trusted["X-Octant-Renderer-Identity"]).toBeUndefined();

    const untrustedFrame = decorateTrustedRendererHeaders({
      requestHeaders: { "x-octant-renderer-identity": "forged" },
      requestUrl: "http://127.0.0.1:13773/api/shell/bootstrap",
      frameUrl: "file:///tmp/renderer.html",
      context,
    });
    expect(untrustedFrame["x-octant-renderer-identity"]).toBeUndefined();

    const otherServer = decorateTrustedRendererHeaders({
      requestHeaders: { "x-octant-renderer-identity": "forged" },
      requestUrl: "http://localhost:13773/api/shell/bootstrap",
      frameUrl: "http://localhost:5173/",
      context,
    });
    expect(otherServer["x-octant-renderer-identity"]).toBeUndefined();
  });

  it("removes a renderer request context when its window closes", () => {
    const registry = createTrustedRendererRequestRegistry();
    const context = {
      serverOrigin: "http://127.0.0.1:13773",
      rendererIdentity: "A".repeat(43),
    };
    registry.set(42, context);
    expect(registry.get(42)).toBe(context);
    registry.remove(42);
    expect(registry.get(42)).toBeUndefined();
  });
});

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve: () => resolve?.() };
}

describe("Project window BrowserWindow construction", () => {
  it("consumes the resolved native presentation without overriding the frameless contract", () => {
    const options = createMainBrowserWindowOptions({
      bounds: { x: 10, y: 20, width: 1000, height: 720 },
      capability: "A".repeat(43),
      preloadPath: "/app/preload.mjs",
      browserWindow: {
        backgroundColor: "#00000000",
        titleBarStyle: "hiddenInset",
        transparent: true,
        vibrancy: "sidebar",
      },
    });
    expect(options).not.toHaveProperty("trafficLightPosition");
    expect(options).toMatchObject({
      x: 10,
      y: 20,
      width: 1000,
      height: 720,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: "#00000000",
      titleBarStyle: "hiddenInset",
      transparent: true,
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      webPreferences: {
        additionalArguments: [`--octant-project-capability=${"A".repeat(43)}`],
        preload: "/app/preload.mjs",
      },
    });
  });

  it("passes an optional one-time Project target only to the requested window", () => {
    expect(
      createMainBrowserWindowOptions({
        bounds: { x: 10, y: 20, width: 1000, height: 720 },
        capability: "A".repeat(43),
        initialProjectId: "00000000-0000-4000-8000-000000000203",
        preloadPath: "/app/preload.mjs",
        browserWindow: {
          backgroundColor: "#00000000",
          titleBarStyle: "hiddenInset",
          transparent: true,
        },
      }).webPreferences?.additionalArguments,
    ).toEqual([
      `--octant-project-capability=${"A".repeat(43)}`,
      "--octant-initial-project-id=00000000-0000-4000-8000-000000000203",
    ]);
  });

  it("passes an exact Project thread target to a secondary renderer", () => {
    expect(
      createMainBrowserWindowOptions({
        bounds: { x: 10, y: 20, width: 1000, height: 720 },
        capability: "A".repeat(43),
        initialProjectId: "00000000-0000-4000-8000-000000000203",
        initialThreadMode: "code",
        initialThreadId: "00000000-0000-4000-8000-000000000204",
        preloadPath: "/app/preload.mjs",
        browserWindow: {
          backgroundColor: "#00000000",
          titleBarStyle: "hiddenInset",
          transparent: true,
        },
      }).webPreferences?.additionalArguments,
    ).toEqual([
      `--octant-project-capability=${"A".repeat(43)}`,
      "--octant-initial-project-id=00000000-0000-4000-8000-000000000203",
      "--octant-initial-thread-mode=code",
      "--octant-initial-thread-id=00000000-0000-4000-8000-000000000204",
    ]);
  });

  it("rejects initial thread arguments without their Project authority", () => {
    expect(() =>
      createMainBrowserWindowOptions({
        bounds: { x: 10, y: 20, width: 1000, height: 720 },
        capability: "A".repeat(43),
        initialThreadMode: "code",
        initialThreadId: "00000000-0000-4000-8000-000000000204",
        preloadPath: "/app/preload.mjs",
        browserWindow: {
          backgroundColor: "#00000000",
          titleBarStyle: "hiddenInset",
          transparent: true,
        },
      }),
    ).toThrow("initial thread target requires a Project");
  });

  it("strictly validates the renderer Project window request", () => {
    const target = validateProjectWindowTarget({
      kind: "project",
      projectId: "00000000-0000-4000-8000-000000000203",
    });
    expect(target).toEqual({
      kind: "project",
      projectId: "00000000-0000-4000-8000-000000000203",
    });
    expect(Object.isFrozen(target)).toBe(true);

    expect(
      validateProjectWindowTarget({
        kind: "project-thread",
        projectId: "00000000-0000-4000-8000-000000000203",
        mode: "code",
        threadId: "00000000-0000-4000-8000-000000000204",
      }),
    ).toEqual({
      kind: "project-thread",
      projectId: "00000000-0000-4000-8000-000000000203",
      mode: "code",
      threadId: "00000000-0000-4000-8000-000000000204",
    });

    for (const value of [
      { kind: "project", projectId: "not-a-uuid" },
      { kind: "project", projectId: "00000000-0000-4000-8000-000000000203", extra: true },
      { kind: "thread", projectId: "00000000-0000-4000-8000-000000000203" },
      null,
    ]) {
      expect(() => validateProjectWindowTarget(value)).toThrow(
        "Octant rejected an invalid Project window target.",
      );
    }
  });
});

describe("desktop Project window ownership", () => {
  it("resolves only independently registered live windows and removes exact ownership", () => {
    const registry = createDesktopWindowContextRegistry<{
      readonly id: number;
      readonly isDestroyed: () => boolean;
      readonly name: string;
    }>();
    const primary = { id: 1, isDestroyed: () => false, name: "primary" };
    const secondary = { id: 2, isDestroyed: () => false, name: "secondary" };
    registry.register(primary, { windowId: "window-a", capability: "A".repeat(43) });
    registry.register(secondary, { windowId: "window-b", capability: "B".repeat(43) });

    expect(registry.resolve(primary)).toMatchObject({
      window: primary,
      windowId: "window-a",
      capability: "A".repeat(43),
    });
    expect(registry.resolve(secondary)).toMatchObject({
      window: secondary,
      windowId: "window-b",
      capability: "B".repeat(43),
    });
    expect(() => registry.resolve({ id: 3, isDestroyed: () => false, name: "unknown" })).toThrow(
      "Octant rejected an unauthorized native window request.",
    );

    registry.remove(primary);
    expect(() => registry.resolve(primary)).toThrow(
      "Octant rejected an unauthorized native window request.",
    );
    expect(registry.resolve(secondary).window).toBe(secondary);
  });

  it("fails closed for a destroyed or replaced BrowserWindow identity", () => {
    const registry = createDesktopWindowContextRegistry<{
      readonly id: number;
      readonly isDestroyed: () => boolean;
    }>();
    let destroyed = false;
    const window = { id: 1, isDestroyed: () => destroyed };
    registry.register(window, { windowId: "window-a", capability: "A".repeat(43) });

    expect(() => registry.resolve({ id: 1, isDestroyed: () => false })).toThrow(
      "Octant rejected an unauthorized native window request.",
    );
    destroyed = true;
    expect(() => registry.resolve(window)).toThrow(
      "Octant rejected an unauthorized native window request.",
    );
  });
});

describe("Project window authority production lifecycle", () => {
  it("awaits registration before construction and renderer load", async () => {
    const order: string[] = [];
    const registered = deferred();
    const lifecycle = createProjectWindowAuthorityLifecycle();
    const opening = lifecycle.open({
      register: async () => {
        order.push("register-start");
        await registered.promise;
        order.push("register-end");
        return { capability: "A".repeat(43), revoke: vi.fn() };
      },
      construct: (capability) => {
        order.push(`construct:${capability}`);
        return { id: "window" };
      },
      prepare: () => order.push("prepare"),
      load: async () => void order.push("load"),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["register-start"]);
    registered.resolve();
    await opening;
    expect(order).toEqual([
      "register-start",
      "register-end",
      `construct:${"A".repeat(43)}`,
      "prepare",
      "load",
    ]);
  });

  it("prevents construction and load when registration fails", async () => {
    const construct = vi.fn();
    const load = vi.fn();
    const lifecycle = createProjectWindowAuthorityLifecycle();

    await expect(
      lifecycle.open({
        register: vi.fn().mockRejectedValue(new Error("private capability")),
        construct,
        prepare: vi.fn(),
        load,
      }),
    ).rejects.toMatchObject({ message: "Octant could not open its Project window." });
    expect(construct).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("tells the user which host state refused the window, not a generic sentence", async () => {
    const lifecycle = createProjectWindowAuthorityLifecycle();

    await expect(
      lifecycle.open({
        register: vi.fn().mockRejectedValue(new ProjectWindowAuthorityUnavailableError()),
        construct: vi.fn(),
        prepare: vi.fn(),
        load: vi.fn(),
      }),
    ).rejects.toMatchObject({
      message: "Octant cannot authorize this Project window while host time recovery is required.",
    });
  });

  it("waits for close revocation before recreating with a distinct capability", async () => {
    const revoking = deferred();
    const firstRevoke = vi.fn(() => revoking.promise);
    const secondRevoke = vi.fn().mockResolvedValue(undefined);
    const register = vi
      .fn()
      .mockResolvedValueOnce({ capability: "A".repeat(43), revoke: firstRevoke })
      .mockResolvedValueOnce({ capability: "B".repeat(43), revoke: secondRevoke });
    const constructed: string[] = [];
    const lifecycle = createProjectWindowAuthorityLifecycle();
    const options = () => ({
      register,
      construct: (capability: string) => {
        constructed.push(capability);
        return {};
      },
      prepare: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
    });

    const first = await lifecycle.open(options());
    const closing = first.close();
    const second = lifecycle.open(options());
    await Promise.resolve();
    await Promise.resolve();
    expect(firstRevoke).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();

    revoking.resolve();
    await closing;
    await second;
    expect(register).toHaveBeenCalledTimes(2);
    expect(constructed).toEqual(["A".repeat(43), "B".repeat(43)]);
  });

  it("revokes once before server stop during quit", async () => {
    const order: string[] = [];
    const lifecycle = createProjectWindowAuthorityLifecycle();
    const opened = await lifecycle.open({
      register: async () => ({
        capability: "A".repeat(43),
        revoke: async () => void order.push("revoke"),
      }),
      construct: () => ({}),
      prepare: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
    });

    await lifecycle.shutdown(async () => void order.push("stop-server"));
    await opened.close();

    expect(order).toEqual(["revoke", "stop-server"]);
  });

  it("waits for in-flight registration before quit revokes and stops the server", async () => {
    const order: string[] = [];
    const registered = deferred();
    const lifecycle = createProjectWindowAuthorityLifecycle();
    const opening = lifecycle.open({
      register: async () => {
        order.push("register-start");
        await registered.promise;
        order.push("register-end");
        return {
          capability: "A".repeat(43),
          revoke: async () => void order.push("revoke"),
        };
      },
      construct: () => ({}),
      prepare: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
    });
    const shutdown = lifecycle.shutdown(async () => void order.push("stop-server"));

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["register-start"]);
    registered.resolve();
    await opening;
    await shutdown;
    expect(order).toEqual(["register-start", "register-end", "revoke", "stop-server"]);
  });

  it("makes shutdown terminal before its first await and rejects late opens", async () => {
    const registered = deferred();
    const firstRegister = vi.fn(async () => {
      await registered.promise;
      return { capability: "A".repeat(43), revoke: vi.fn() };
    });
    const lifecycle = createProjectWindowAuthorityLifecycle();
    const opening = lifecycle.open({
      register: firstRegister,
      construct: () => ({}),
      prepare: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
    });
    const stopServer = vi.fn().mockResolvedValue(undefined);
    const shutdown = lifecycle.shutdown(stopServer);
    const secondShutdown = lifecycle.shutdown(vi.fn().mockResolvedValue(undefined));
    const lateRegister = vi.fn();
    const lateConstruct = vi.fn();
    const lateLoad = vi.fn();

    const lateOpen = lifecycle.open({
      register: lateRegister,
      construct: lateConstruct,
      prepare: vi.fn(),
      load: lateLoad,
    });
    expect(secondShutdown).toBe(shutdown);

    registered.resolve();
    await opening;
    await shutdown;
    await expect(lateOpen).rejects.toMatchObject({
      message: "Octant Project window lifecycle is unavailable.",
    });
    expect(lateRegister).not.toHaveBeenCalled();
    expect(lateConstruct).not.toHaveBeenCalled();
    expect(lateLoad).not.toHaveBeenCalled();
    expect(firstRegister).toHaveBeenCalledOnce();
    expect(stopServer).toHaveBeenCalledOnce();
  });

  it("contains revoke failure and still gates recreation and shutdown", async () => {
    const register = vi
      .fn()
      .mockResolvedValueOnce({
        capability: "A".repeat(43),
        revoke: vi.fn().mockRejectedValue(new Error("private capability")),
      })
      .mockResolvedValueOnce({
        capability: "B".repeat(43),
        revoke: vi.fn().mockRejectedValue(new Error("private capability")),
      });
    const lifecycle = createProjectWindowAuthorityLifecycle();
    const options = () => ({
      register,
      construct: () => ({}),
      prepare: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
    });

    const first = await lifecycle.open(options());
    await expect(first.close()).resolves.toBeUndefined();
    await expect(lifecycle.open(options())).resolves.toBeDefined();
    const stopServer = vi.fn().mockResolvedValue(undefined);
    await expect(lifecycle.shutdown(stopServer)).resolves.toBeUndefined();
    expect(stopServer).toHaveBeenCalledOnce();
  });

  it.each(["construct", "prepare", "load"] as const)(
    "revokes before surfacing a redacted %s failure",
    async (stage) => {
      const order: string[] = [];
      const lifecycle = createProjectWindowAuthorityLifecycle();
      const opening = lifecycle.open({
        register: async () => ({
          capability: "A".repeat(43),
          revoke: async () => void order.push("revoke"),
        }),
        construct: () => {
          order.push("construct");
          if (stage === "construct") throw new Error("private capability");
          return {};
        },
        prepare: () => {
          order.push("prepare");
          if (stage === "prepare") throw new Error("private capability");
        },
        load: async () => {
          order.push("load");
          if (stage === "load") throw new Error("private capability");
        },
        dispose: () => void order.push("dispose"),
      });

      await expect(opening).rejects.toMatchObject({
        message: "Octant could not open its Project window.",
      });
      expect(order.at(-1)).toBe("revoke");
      expect(JSON.stringify(order)).not.toContain("private capability");
    },
  );
});

describe("Keychain helper runtime path", () => {
  it("uses the canonical Resources/native helper in packaged production", () => {
    expect(
      resolveKeychainHelperPath({
        packaged: true,
        resourcesPath: "/Applications/Octant.app/Contents/Resources",
        moduleUrl:
          "file:///Applications/Octant.app/Contents/Resources/app/apps/desktop/dist/main.mjs",
      }),
    ).toBe("/Applications/Octant.app/Contents/Resources/native/octant-keychain-helper");
  });

  it("keeps the built dist/native helper fallback for development", () => {
    expect(
      resolveKeychainHelperPath({
        packaged: false,
        resourcesPath: "/unused",
        moduleUrl: "file:///repo/apps/desktop/dist/main.mjs",
      }),
    ).toBe("/repo/apps/desktop/dist/native/octant-keychain-helper");
  });
});

describe("Code file helper runtime path", () => {
  it("uses the canonical Resources/native helper in packaged production", () => {
    expect(
      resolveCodeFileHelperPath({
        packaged: true,
        resourcesPath: "/Applications/Octant.app/Contents/Resources",
        moduleUrl:
          "file:///Applications/Octant.app/Contents/Resources/app/apps/desktop/dist/main.mjs",
      }),
    ).toBe("/Applications/Octant.app/Contents/Resources/native/octant-code-file-helper");
  });

  it("uses the built dist/native helper in development", () => {
    expect(
      resolveCodeFileHelperPath({
        packaged: false,
        resourcesPath: "/unused",
        moduleUrl: "file:///repo/apps/desktop/dist/main.mjs",
      }),
    ).toBe("/repo/apps/desktop/dist/native/octant-code-file-helper");
  });
});

describe("Project window production preparation cleanup", () => {
  it("disposes thermal and presentation resources once after later preparation failure", () => {
    const order: string[] = [];
    const controller = { dispose: vi.fn(() => void order.push("controller")) };
    const stopThermal = vi.fn(() => void order.push("thermal"));
    const cleanup = createProjectWindowPreparationCleanup();

    cleanup.trackPresentationController(controller);
    cleanup.trackThermalObserver(stopThermal);
    cleanup.dispose();
    cleanup.dispose();

    expect(order).toEqual(["thermal", "controller"]);
    expect(stopThermal).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a presentation controller when thermal setup fails before tracking", () => {
    const controller = { dispose: vi.fn() };
    const cleanup = createProjectWindowPreparationCleanup();
    cleanup.trackPresentationController(controller);

    cleanup.dispose();

    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("runs tracked production cleanup when a later prepare step throws", async () => {
    const controller = { dispose: vi.fn() };
    const stopThermal = vi.fn();
    const cleanup = createProjectWindowPreparationCleanup();
    const lifecycle = createProjectWindowAuthorityLifecycle();

    await expect(
      lifecycle.open({
        register: async () => ({ capability: "A".repeat(43), revoke: vi.fn() }),
        construct: () => ({}),
        prepare: () => {
          cleanup.trackPresentationController(controller);
          cleanup.trackThermalObserver(stopThermal);
          throw new Error("listener setup failed");
        },
        load: vi.fn(),
        dispose: () => cleanup.dispose(),
      }),
    ).rejects.toMatchObject({ message: "Octant could not open its Project window." });
    expect(stopThermal).toHaveBeenCalledOnce();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });
});

describe("Project window production request gate", () => {
  it("does not request a window after teardown begins", () => {
    const request = vi.fn();
    const handleFailure = vi.fn();

    requestProjectWindowWhileRunning({
      isTearingDown: () => true,
      request,
      handleFailure,
    });

    expect(request).not.toHaveBeenCalled();
    expect(handleFailure).not.toHaveBeenCalled();
  });

  it("contains a request rejection when teardown begins before it settles", async () => {
    const handleFailure = vi.fn();
    let tearingDown = false;

    requestProjectWindowWhileRunning({
      isTearingDown: () => tearingDown,
      request: vi.fn().mockRejectedValue(new Error("late lifecycle rejection")),
      handleFailure,
    });
    tearingDown = true;
    await Promise.resolve();
    await Promise.resolve();

    expect(handleFailure).not.toHaveBeenCalled();
  });
});

describe("managed server credential broker lifecycle", () => {
  it("sanitizes broker startup failure without attempting server startup", async () => {
    const privateFailure = "listen EADDRINUSE with private runtime path";
    const startServer = vi.fn();

    const failure = await startManagedServerResources({
      startBroker: vi.fn().mockRejectedValue(new Error(privateFailure)),
      startServer,
    }).catch((error: unknown) => error);

    expect(startServer).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(privateFailure);
  });

  it("starts the broker before the managed server", async () => {
    const order: string[] = [];
    const broker = {
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      close: vi.fn(),
    };
    const child = { id: "server" };

    const resources = await startManagedServerResources({
      startBroker: async () => {
        order.push("broker");
        return broker;
      },
      startServer: (startedBroker) => {
        order.push(`server:${startedBroker.url}`);
        return child;
      },
    });

    expect(order).toEqual(["broker", "server:http://127.0.0.1:41000/"]);
    expect(resources).toEqual({ broker, server: child });
  });

  it("closes the broker when managed server startup fails", async () => {
    const privateFailure = "spawn command leaked a private path";
    const broker = {
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      close: vi.fn().mockResolvedValue(undefined),
    };

    const failure = await startManagedServerResources({
      startBroker: vi.fn().mockResolvedValue(broker),
      startServer: () => {
        throw new Error(privateFailure);
      },
    }).catch((error: unknown) => error);

    expect(broker.close).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(privateFailure);
  });

  it("closes the server before the broker and still closes the broker after server cleanup fails", async () => {
    const order: string[] = [];
    const broker = {
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      close: vi.fn(async () => void order.push("broker")),
    };
    const server = { id: "server" };
    const shutdownServer = vi.fn(async () => {
      order.push("server");
      throw new Error("private shutdown diagnostic");
    });

    await expect(
      shutdownManagedServerResources({ broker, server, shutdownServer }),
    ).rejects.toThrow("Octant could not stop its managed server resources.");
    expect(order).toEqual(["server", "broker"]);
  });
});

describe("provider credential host operations", () => {
  const providerInstanceId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";

  it("requires an owned window and exposes status without credential reads", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sender = {};
    const values = new Map([[providerInstanceId, "private-value"]]);
    const store = credentialStore(values);
    installProviderCredentialIpcHandlers({
      handle: (channel, handler) => void handlers.set(channel, handler),
      resolveOwnedWindow: (event) => {
        if (event !== sender) throw new Error("unauthorized");
      },
      store,
    });

    await expect(
      handlers.get("octant:provider-credential:status")?.(sender, providerInstanceId),
    ).resolves.toBe("stored");
    await expect(
      handlers.get("octant:provider-credential:status")?.({}, providerInstanceId),
    ).rejects.toThrow("Octant rejected an unauthorized credential request.");
    expect(store.resolve).not.toHaveBeenCalled();
    expect([...handlers.keys()]).toEqual([
      "octant:provider-credential:set",
      "octant:provider-credential:status",
      "octant:provider-credential:clear",
    ]);
  });

  it("validates again in main and sanitizes store failures", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const store = credentialStore();
    vi.mocked(store.set).mockRejectedValue(new Error("private-value raw Keychain diagnostic"));
    installProviderCredentialIpcHandlers({
      handle: (channel, handler) => void handlers.set(channel, handler),
      resolveOwnedWindow: vi.fn(),
      store,
    });
    const set = handlers.get("octant:provider-credential:set")!;

    await expect(set({}, "not-a-uuid", "value")).rejects.toThrow(
      "Octant rejected an invalid credential request.",
    );
    await expect(set({}, providerInstanceId, "")).rejects.toThrow(
      "Octant rejected an invalid credential request.",
    );
    const failure = await Promise.resolve(set({}, providerInstanceId, "private-value")).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toBe("Error: Octant could not store the provider credential.");
  });

  it("rejects foreign senders for set and clear before touching the store", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const owner = {};
    const store = credentialStore();
    installProviderCredentialIpcHandlers({
      handle: (channel, handler) => void handlers.set(channel, handler),
      resolveOwnedWindow: (event) => {
        if (event !== owner) throw new Error("foreign sender");
      },
      store,
    });

    await expect(
      handlers.get("octant:provider-credential:set")?.({}, providerInstanceId, "fixture-value"),
    ).rejects.toThrow("Octant rejected an unauthorized credential request.");
    await expect(
      handlers.get("octant:provider-credential:clear")?.({}, providerInstanceId),
    ).rejects.toThrow("Octant rejected an unauthorized credential request.");
    expect(store.set).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("rejects invalid status and clear UUIDs before touching the store", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const store = credentialStore();
    installProviderCredentialIpcHandlers({
      handle: (channel, handler) => void handlers.set(channel, handler),
      resolveOwnedWindow: vi.fn(),
      store,
    });

    await expect(
      handlers.get("octant:provider-credential:status")?.({}, "not-a-uuid"),
    ).rejects.toThrow("Octant rejected an invalid credential request.");
    await expect(
      handlers.get("octant:provider-credential:clear")?.({}, "not-a-uuid"),
    ).rejects.toThrow("Octant rejected an invalid credential request.");
    expect(store.has).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("rejects non-string credentials and enforces the exact UTF-8 byte boundary", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const store = credentialStore();
    installProviderCredentialIpcHandlers({
      handle: (channel, handler) => void handlers.set(channel, handler),
      resolveOwnedWindow: vi.fn(),
      store,
    });
    const set = handlers.get("octant:provider-credential:set")!;
    const exactBoundary = "€".repeat(4_096);

    await expect(set({}, providerInstanceId, { credential: "fixture-value" })).rejects.toThrow(
      "Octant rejected an invalid credential request.",
    );
    await expect(set({}, providerInstanceId, exactBoundary)).resolves.toBeUndefined();
    await expect(set({}, providerInstanceId, `${exactBoundary}a`)).rejects.toThrow(
      "Octant rejected an invalid credential request.",
    );
    expect(store.set).toHaveBeenCalledOnce();
    expect(vi.mocked(store.set).mock.calls[0]?.[1]).toHaveLength(4_096);
  });
});

function credentialStore(values = new Map<string, string>()): CredentialStore {
  return {
    set: vi.fn(async (instanceId, credential) => void values.set(instanceId, credential)),
    has: vi.fn(async (instanceId) => values.has(instanceId)),
    resolve: vi.fn(async (instanceId) => values.get(instanceId) ?? ""),
    delete: vi.fn(async (instanceId) => void values.delete(instanceId)),
  };
}

function disabledStatus() {
  return {
    enabled: false,
    state: "disabled" as const,
    hostname: null,
    port: null,
    origin: null,
    exposureClass: null,
    certificateFingerprint: null,
    certificateReady: false,
  };
}

function readyStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    state: "ready" as const,
    hostname: "192.168.1.20",
    port: 9443,
    origin: "https://192.168.1.20:9443",
    exposureClass: "lan-private" as const,
    certificateFingerprint: "ab".repeat(32),
    certificateReady: true,
    ...overrides,
  };
}

describe("private listener IPC handlers", () => {
  it("reconciles authoritative native status and rejects unauthorized callers", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const service = {
      getStatus: vi.fn(() => disabledStatus()),
      syncStatus: vi.fn(async () => disabledStatus()),
      enable: vi.fn(),
      restart: vi.fn(),
      disable: vi.fn(),
    };
    installPrivateListenerIpcHandlers({
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      resolveOwnedWindow: (event) => {
        if (event !== "owned") throw new Error("unauthorized");
      },
      resolveService: () => service,
    });

    const statusHandler = handlers.get("octant:private-listener:status");
    expect(statusHandler).toBeTypeOf("function");
    await expect(statusHandler?.("owned")).resolves.toMatchObject({
      enabled: false,
      state: "disabled",
    });
    expect(service.syncStatus).toHaveBeenCalledOnce();
    await expect(statusHandler?.("foreign")).rejects.toThrow(
      /unauthorized private listener request/,
    );
  });

  it("enable/restart require local confirmation and never return certificate material", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const service = {
      getStatus: vi.fn(() => disabledStatus()),
      syncStatus: vi.fn(async () => disabledStatus()),
      enable: vi.fn(async () => readyStatus()),
      restart: vi.fn(async () =>
        readyStatus({ hostname: "100.64.1.3", exposureClass: "tailscale" }),
      ),
      disable: vi.fn(async () => disabledStatus()),
    };
    installPrivateListenerIpcHandlers({
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      resolveOwnedWindow: () => undefined,
      resolveService: () => service,
    });

    const request = {
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      certificatePem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----",
      localConfirmation: true,
    };
    const enable = handlers.get("octant:private-listener:enable");
    const restart = handlers.get("octant:private-listener:restart");
    const disable = handlers.get("octant:private-listener:disable");

    const status = await enable?.("owned", request);
    expect(status).toMatchObject({
      enabled: true,
      certificateFingerprint: "ab".repeat(32),
      certificateReady: true,
    });
    expect(service.enable).toHaveBeenCalledWith(
      expect.objectContaining({ localConfirmation: true }),
    );
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(status)).not.toContain("BEGIN CERTIFICATE");

    await expect(restart?.("owned", request)).resolves.toMatchObject({
      hostname: "100.64.1.3",
      exposureClass: "tailscale",
    });
    expect(service.restart).toHaveBeenCalledOnce();

    await expect(disable?.("owned")).resolves.toMatchObject({ enabled: false, state: "disabled" });
  });
});

describe("local remote device IPC handlers", () => {
  const ticketId = "11111111-1111-4111-8111-111111111111";
  const deviceId = "22222222-2222-4222-8222-222222222222";
  const device = {
    hostId: "33333333-3333-4333-8333-333333333333",
    deviceId,
    deviceKeyFingerprint: "a".repeat(64),
    deviceLabel: "Safari",
    origin: "https://mac.example.test",
    protocolFloor: 1,
    credentialGeneration: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    lastSeenAt: "2026-08-01T10:00:00.000Z",
    state: "active" as const,
  };

  it("authorizes owned windows and dispatches local pairing and inventory controls", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const handle = vi.fn((channel, handler) => {
      handlers.set(channel, handler);
    });
    const service: RemoteDeviceControlService = {
      listPairingRequests: vi.fn(async () => []),
      approvePairingRequest: vi.fn(async () => ({ decision: "approved" as const, device })),
      denyPairingRequest: vi.fn(async () => ({ decision: "denied" as const })),
      getDeviceInventory: vi.fn(async () => [device]),
      renameDevice: vi.fn(async () => device),
      revokeDevice: vi.fn(async () => ({
        commandId: "44444444-4444-4444-8444-444444444444",
        result: "applied" as const,
        occurredAt: "2026-08-01T10:00:00.000Z",
      })),
      revokeAllDevices: vi.fn(async () => ({
        commandId: "55555555-5555-4555-8555-555555555555",
        result: "applied" as const,
        occurredAt: "2026-08-01T10:00:00.000Z",
      })),
      reconcileExpiredDevices: vi.fn(async () => ({
        commandId: "66666666-6666-4666-8666-666666666666",
        result: "applied" as const,
        occurredAt: "2026-08-01T10:00:00.000Z",
      })),
    };
    installRemoteDeviceIpcHandlers({
      handle,
      resolveOwnedWindow: (event) => {
        if (event !== "owned") throw new Error("foreign");
      },
      service,
    });

    await expect(handlers.get("octant:remote-device:pairing-requests")?.("owned")).resolves.toEqual(
      [],
    );
    await expect(
      handlers.get("octant:remote-device:pairing-approve")?.("owned", ticketId),
    ).resolves.toMatchObject({ decision: "approved", device: { deviceId } });
    await expect(
      handlers.get("octant:remote-device:pairing-deny")?.("owned", ticketId, "user-denied"),
    ).resolves.toEqual({ decision: "denied" });
    await expect(handlers.get("octant:remote-device:inventory")?.("owned")).resolves.toEqual([
      device,
    ]);
    await expect(
      handlers.get("octant:remote-device:rename")?.("owned", deviceId, "Living Room"),
    ).resolves.toEqual(device);
    await expect(
      handlers.get("octant:remote-device:revoke")?.("owned", deviceId),
    ).resolves.toMatchObject({ result: "applied" });
    await expect(handlers.get("octant:remote-device:revoke-all")?.("owned")).resolves.toMatchObject(
      { result: "applied" },
    );
    await expect(
      handlers.get("octant:remote-device:reconcile-expired")?.("owned"),
    ).resolves.toMatchObject({ result: "applied" });

    await expect(handlers.get("octant:remote-device:inventory")?.("foreign")).rejects.toThrow(
      /unauthorized local device request/,
    );
    expect(JSON.stringify([...handlers.keys()])).not.toMatch(/secret|private/i);
  });

  it("keeps unavailable failures typed and does not leak runtime diagnostics", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    installRemoteDeviceIpcHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      resolveOwnedWindow: () => undefined,
      service: {
        listPairingRequests: vi.fn(async () => {
          throw new Error("raw sqlite private diagnostic");
        }),
      } as unknown as RemoteDeviceControlService,
    });

    const failure = await Promise.resolve(
      handlers.get("octant:remote-device:pairing-requests")?.("owned"),
    ).catch((error: unknown) => error);
    expect(String(failure)).toContain("local device controls");
    expect(String(failure)).not.toMatch(/sqlite|private diagnostic/i);
  });
});

describe("local host identity IPC handlers", () => {
  it("keeps recovery and rotation behind owned-window authorization", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const service = {
      probeRecoveryState: vi.fn(async () => ({
        status: "ready" as const,
        reason: null,
        remoteIdentityUsable: true as const,
        localDesktopUsable: true as const,
        fingerprint: "a".repeat(64),
      })),
      rotateIdentityKey: vi.fn(async () => ({ fingerprint: "b".repeat(64) })),
      ensureIdentityKey: vi.fn(async () => ({ fingerprint: "b".repeat(64) })),
      sign: vi.fn(async () => ({ fingerprint: "a".repeat(64), signature: "sig" })),
    };
    installHostIdentityIpcHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      resolveOwnedWindow: (event) => {
        if (event !== "owned") throw new Error("foreign");
      },
      service,
    });
    await expect(
      handlers.get("octant:remote-host-identity:status")?.("owned"),
    ).resolves.toMatchObject({
      status: "ready",
      fingerprint: "a".repeat(64),
    });
    await expect(handlers.get("octant:remote-host-identity:rotate")?.("owned")).resolves.toEqual({
      status: "rotated",
      fingerprint: "b".repeat(64),
    });
    await expect(
      handlers.get("octant:remote-host-identity:recover")?.("owned"),
    ).resolves.toMatchObject({
      status: "ready",
    });
    await expect(handlers.get("octant:remote-host-identity:status")?.("foreign")).rejects.toThrow(
      /unauthorized host-identity request/,
    );
    expect(service.ensureIdentityKey).toHaveBeenCalledOnce();
  });
});
