import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import { decodeBrowserPageScriptNativeCommand } from "@octant/contracts/browser-page-script";
import { decodeOwnerBrowserNativeCommand } from "@octant/contracts/owner-browser";
import {
  decodeBrowserEditorId,
  decodeHumanBrowserRequest,
} from "@octant/contracts/browser-presentation";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserTargetStaleError,
  createBrowserSurfaceHost,
  type BrowserSurfaceViewPort,
} from "./browserSurfaceHost";

const contextId = "60000000-0000-4000-8000-000000000001";
const threadId = "10000000-0000-4000-8000-000000000001";

function view(): BrowserSurfaceViewPort {
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  let debuggerAttached = false;
  return {
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    webContents: {
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        toJPEG: () => Uint8Array.from([1, 2, 3]),
      })),
      close: vi.fn(),
      debugger: {
        attach: vi.fn(() => {
          debuggerAttached = true;
        }),
        detach: vi.fn(() => {
          debuggerAttached = false;
        }),
        isAttached: vi.fn(() => debuggerAttached),
        sendCommand: vi.fn(async () => undefined),
      },
      executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined),
      getTitle: vi.fn(() => "Example"),
      getURL: vi.fn(() => "https://example.com/"),
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => false),
      loadURL: vi.fn(async () => undefined),
      mainFrame: { framesInSubtree: [] },
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => true),
        goBack: vi.fn(),
        goForward: vi.fn(),
      },
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      reload: vi.fn(),
      session: {
        on: vi.fn(),
        setCertificateVerifyProc: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
        setDisplayMediaRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onErrorOccurred: vi.fn(), onCompleted: vi.fn() },
      },
      setWindowOpenHandler: vi.fn(),
      stop: vi.fn(),
    },
  };
}

describe("BrowserSurfaceHost", () => {
  it("keeps owner frames volatile, fences earlier agent captures and lets local input reclaim the exact native page", async () => {
    const created = view();
    created.webContents.insertText = vi.fn(async () => undefined);
    vi.mocked(created.webContents.debugger.sendCommand).mockImplementation(
      async (method, params) => {
        // Actual Electron emits before-mouse-event for CDP mouse dispatch too.
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          vi.mocked(created.webContents.on).mock.calls.find(
            ([event]) => event === "before-mouse-event",
          )?.[1]({}, { type: "mouseDown" });
        }
        return undefined;
      },
    );
    const started = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<void>();
    let delay = true;
    vi.mocked(created.webContents.capturePage).mockImplementation(async () => {
      started.resolve();
      if (delay) await captured.promise;
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 800, height: 600 }),
        toJPEG: () => Uint8Array.from([1, 2, 3]),
      };
    });
    const owner = { windowId: "a7880000-0000-4000-8000-000000000001", threadId };
    const host = createBrowserSurfaceHost({
      createView: () => created,
      isOwnerWindowAvailable: () => true,
    });
    const id = "a7880000-0000-4000-8000-000000000002";
    const run = (command: Readonly<Record<string, unknown>>) =>
      host.ownerControl(decodeOwnerBrowserNativeCommand({ contextId, owner, ...command }));
    try {
      await host.createContext({
        contextId,
        owner,
        policy: {
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 1,
          sessionTimeoutMs: 60_000,
        },
      });
      expect(await run({ operation: "inspect" })).toEqual({ status: "refused" });
      host.attach(
        contextId,
        owner,
        {
          contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
          isDestroyed: () => false,
          isVisible: () => true,
          webContents: { send: vi.fn() },
        },
        { x: 0, y: 0, width: 800, height: 600 },
      );
      const inspect = await run({ operation: "inspect" });
      if (inspect.status !== "target") throw new Error("Expected visible native target");
      const pending = host.peek(contextId);
      // Attach rejection handling before the deliberately delayed capture settles.
      const withheld = expect(pending).rejects.toThrow(
        "Owner Browser control holds agent observations",
      );
      await started.promise;
      expect(
        await run({
          operation: "claim",
          controlId: id,
          target: inspect.target,
          expiresAt: new Date(Date.now() + 50_000).toISOString(),
        }),
      ).toEqual({ status: "claimed" });
      expect(
        (await host.prepareCredentialFill(contextId, owner, "https://example.com")).status,
      ).toBe("refused");
      expect(await run({ operation: "release", controlId: id, disposition: "revoke" })).toEqual({
        status: "released",
      });
      captured.resolve();
      await withheld;
      delay = false;
      expect(
        (
          await run({
            operation: "claim",
            controlId: id,
            target: inspect.target,
            expiresAt: new Date(Date.now() + 50_000).toISOString(),
          })
        ).status,
      ).toBe("claimed");
      expect((await run({ operation: "frame", controlId: id, sequence: 1 })).status).toBe("frame");
      await expect(host.peek(contextId)).rejects.toThrow(
        "Owner Browser control holds agent observations",
      );
      expect(
        await run({
          operation: "input",
          controlId: id,
          sequence: 2,
          expectedFrame: 1,
          input: { kind: "press", key: "Tab" },
        }),
      ).toEqual({ status: "input", effect: "completed" });
      expect(created.webContents.debugger.sendCommand).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ type: "keyDown", key: "Tab" }),
      );
      expect((await run({ operation: "frame", controlId: id, sequence: 3 })).status).toBe("frame");
      expect(
        await run({
          operation: "input",
          controlId: id,
          sequence: 4,
          expectedFrame: 3,
          input: { kind: "tap", x: 0.5, y: 0.5 },
        }),
      ).toEqual({ status: "input", effect: "completed" });
      expect(created.webContents.debugger.sendCommand).toHaveBeenCalledWith(
        "Input.dispatchTouchEvent",
        expect.objectContaining({ type: "touchStart" }),
      );
      expect((await run({ operation: "frame", controlId: id, sequence: 5 })).status).toBe("frame");
      const reclaim = vi
        .mocked(created.webContents.on)
        .mock.calls.find(([event]) => event === "before-input-event")?.[1];
      reclaim?.({}, { type: "keyDown" });
      expect(
        (
          await run({
            operation: "input",
            controlId: id,
            sequence: 6,
            expectedFrame: 5,
            input: { kind: "press", key: "Enter" },
          })
        ).status,
      ).toBe("refused");
    } finally {
      captured.resolve();
      await host.closeAll();
    }
  });
  it.each([
    ["https://example.com"],
    ["https://identity.example:8443"],
    ["https://example.com", "https://identity.example"],
  ])(
    "refuses native custody unless both exact page and submission origins are saved (%j)",
    async (...origins) => {
      const created = view();
      vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
        async (_world, scripts) =>
          scripts[0]?.code.includes('"operation":"validate"')
            ? { status: "valid" }
            : {
                status: "prepared",
                usernameLabel: "Email",
                passwordLabel: "Password",
                submissionOrigin: "https://identity.example:8443",
              },
      );
      const host = createBrowserSurfaceHost({ createView: () => created });
      const owner = { windowId: "window-a", threadId };
      try {
        await host.createContext({
          contextId,
          owner,
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 1,
            sessionTimeoutMs: 300_000,
          },
        });
        const plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
        if (plan.status !== "prepared") throw new Error("Expected plan");
        expect(await host.reserveCredentialFill(contextId, owner, plan.planId, origins)).toEqual({
          status: "refused",
        });
        await expect(host.peek(contextId)).resolves.toMatchObject({ url: "https://example.com/" });
      } finally {
        await host.closeAll();
      }
    },
  );

  it("releases an expired ready reservation when commit can no longer find an eligible plan", async () => {
    vi.useFakeTimers();
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
      async (_world, scripts) =>
        scripts[0]?.code.includes('"operation":"validate"')
          ? { status: "valid" }
          : {
              status: "prepared",
              usernameLabel: "Email",
              passwordLabel: "Password",
              submissionOrigin: "https://example.com",
            },
    );
    const host = createBrowserSurfaceHost({ createView: () => created });
    const owner = { windowId: "window-a", threadId };
    try {
      await host.createContext({
        contextId,
        owner,
        policy: {
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 1,
          sessionTimeoutMs: 300_000,
        },
      });
      const plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
      if (plan.status !== "prepared") throw new Error("Expected plan");
      await host.reserveCredentialFill(contextId, owner, plan.planId, [
        "https://example.com",
        "https://identity.example",
        "https://identity.example:8443",
      ]);
      await vi.advanceTimersByTimeAsync(180_001);
      await expect(host.peek(contextId)).rejects.toThrow(/credential fill holds observations/);
      expect(
        await host.commitCredentialFill(contextId, owner, plan.planId, {
          username: "never",
          password: "never",
        }),
      ).toEqual({ status: "cancelled", effect: "none" });
      await expect(host.peek(contextId)).resolves.toMatchObject({ url: "https://example.com/" });
    } finally {
      await host.closeAll();
      vi.useRealTimers();
    }
  });

  it("keeps native observation exclusion after a late reservation's plan expires until custody cleanup", async () => {
    vi.useFakeTimers();
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
      async (_world, scripts) =>
        scripts[0]?.code.includes('"operation":"validate"')
          ? { status: "valid" }
          : {
              status: "prepared",
              usernameLabel: "Email",
              passwordLabel: "Password",
              submissionOrigin: "https://example.com",
            },
    );
    const host = createBrowserSurfaceHost({ createView: () => created });
    const owner = { windowId: "window-a", threadId };
    try {
      await host.createContext({
        contextId,
        owner,
        policy: {
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 1,
          sessionTimeoutMs: 300_000,
        },
      });
      const plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
      if (plan.status !== "prepared") throw new Error("Expected plan");
      await vi.advanceTimersByTimeAsync(179_900);
      await host.reserveCredentialFill(contextId, owner, plan.planId, [
        "https://example.com",
        "https://identity.example",
        "https://identity.example:8443",
      ]);
      await vi.advanceTimersByTimeAsync(101);
      expect(await host.validateCredentialFill(contextId, owner, plan.planId)).toBe(false);
      await expect(host.peek(contextId)).rejects.toThrow(/credential fill holds observations/);
      host.cancelCredentialFill(contextId, owner, plan.planId);
      await expect(host.peek(contextId)).resolves.toMatchObject({ url: "https://example.com/" });
    } finally {
      await host.closeAll();
      vi.useRealTimers();
    }
  });
  it("refuses submission when the grant deadline passes during final native field validation", async () => {
    vi.useFakeTimers();
    const created = view();
    let defer = false;
    let finish: ((value: object) => void) | undefined;
    let submitted = false;
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
      async (_world, scripts) => {
        const code = scripts[0]?.code ?? "";
        if (code.includes('"operation":"validate"'))
          return defer
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : { status: "valid" };
        if (code.includes('"operation":"submit"')) {
          submitted = true;
          return { status: "submitted" };
        }
        return code.includes('"operation":"fill"')
          ? { status: "filled" }
          : {
              status: "prepared",
              usernameLabel: "Email",
              passwordLabel: "Password",
              submissionOrigin: "https://identity.example",
            };
      },
    );
    const host = createBrowserSurfaceHost({ createView: () => created });
    const owner = { windowId: "window-a", threadId };
    try {
      await host.createContext({
        contextId,
        owner,
        policy: {
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 1,
          sessionTimeoutMs: 300_000,
        },
      });
      const plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
      if (plan.status !== "prepared") throw new Error("Expected plan");
      await host.reserveCredentialFill(contextId, owner, plan.planId, [
        "https://example.com",
        "https://identity.example",
        "https://identity.example:8443",
      ]);
      await host.commitCredentialFill(contextId, owner, plan.planId, {
        username: "fixture",
        password: "fixture-private",
      });
      const expiresAt = new Date(Date.now() + 100).toISOString();
      defer = true;
      const pending = host.submitCredentialFill(contextId, owner, plan.planId, expiresAt);
      await vi.advanceTimersByTimeAsync(101);
      finish?.({ status: "valid" });
      expect(await pending).toEqual({ status: "cancelled", effect: "none" });
      expect(submitted).toBe(false);
      const guard = vi
        .mocked(created.webContents.on)
        .mock.calls.find(([event]) => event === "will-navigate")?.[1];
      const refused = vi.fn();
      guard?.({
        preventDefault: refused,
        isMainFrame: true,
        url: "https://identity.example/authorize",
      });
      expect(refused).toHaveBeenCalledOnce();
    } finally {
      await host.closeAll();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "cancels an unstarted submit and reports possible effect after submit start (%s)",
    async (started) => {
      const created = view();
      let hold = false;
      let finish: ((value: object) => void) | undefined;
      let submissions = 0;
      vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
        async (_world, scripts) => {
          const code = scripts[0]?.code ?? "";
          if (code.includes('"operation":"validate"')) {
            if (hold && !started)
              return new Promise((resolve) => {
                finish = resolve;
              });
            return { status: "valid" };
          }
          if (code.includes('"operation":"submit"')) {
            submissions += 1;
            if (hold && started)
              return new Promise((resolve) => {
                finish = resolve;
              });
            return { status: "submitted" };
          }
          return code.includes('"operation":"fill"')
            ? { status: "filled" }
            : {
                status: "prepared",
                usernameLabel: "Email",
                passwordLabel: "Password",
                submissionOrigin: "https://identity.example",
              };
        },
      );
      const host = createBrowserSurfaceHost({ createView: () => created });
      const owner = { windowId: "window-a", threadId };
      try {
        await host.createContext({
          contextId,
          owner,
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 1,
            sessionTimeoutMs: 300_000,
          },
        });
        const plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
        if (plan.status !== "prepared") throw new Error("Expected form");
        await host.reserveCredentialFill(contextId, owner, plan.planId, [
          "https://example.com",
          "https://identity.example",
          "https://identity.example:8443",
        ]);
        await host.commitCredentialFill(contextId, owner, plan.planId, {
          username: "fixture",
          password: "fixture-private",
        });
        hold = true;
        const pending = host.submitCredentialFill(
          contextId,
          owner,
          plan.planId,
          new Date(Date.now() + 180_000).toISOString(),
        );
        await vi.waitFor(() => expect(finish).toBeDefined());
        expect(host.cancelCredentialFill(contextId, owner, plan.planId)).toEqual({
          status: "cancelled",
          effect: started ? "possible" : "none",
        });
        finish?.(started ? { status: "submitted" } : { status: "valid" });
        expect(await pending).toEqual(
          started
            ? { status: "authentication-required", effect: "completed" }
            : { status: "cancelled", effect: "none" },
        );
        expect(submissions).toBe(started ? 1 : 0);
      } finally {
        await host.closeAll();
      }
    },
  );

  it("admits only the reviewed SSO submission and return origins after explicit submit without creating another profile", async () => {
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
      async (_world, scripts) => {
        const code = scripts[0]?.code ?? "";
        return code.includes('"operation":"validate"')
          ? { status: "valid" }
          : code.includes('"operation":"fill"')
            ? { status: "filled" }
            : code.includes('"operation":"submit"')
              ? { status: "submitted" }
              : {
                  status: "prepared",
                  usernameLabel: "Email",
                  passwordLabel: "Password",
                  submissionOrigin: "https://identity.example:8443",
                };
      },
    );
    const createView = vi.fn(() => created);
    const host = createBrowserSurfaceHost({ createView });
    const owner = { windowId: "window-a", threadId };
    try {
      await host.createContext({
        contextId,
        owner,
        policy: {
          profileMode: "isolated",
          profile: { kind: "private" },
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 1,
          sessionTimeoutMs: 300_000,
        },
      });
      const navigate = vi
        .mocked(created.webContents.on)
        .mock.calls.find(([event]) => event === "will-navigate")?.[1];
      if (navigate === undefined) throw new Error("Expected native navigation guard");
      const before = vi.fn();
      navigate({ preventDefault: before }, "https://identity.example:8443/authorize");
      expect(before).toHaveBeenCalledOnce();
      let plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
      if (plan.status !== "prepared") throw new Error("Expected plan");
      await host.reserveCredentialFill(contextId, owner, plan.planId, [
        "https://example.com",
        "https://identity.example",
        "https://identity.example:8443",
      ]);
      await host.commitCredentialFill(contextId, owner, plan.planId, {
        username: "fixture",
        password: "fixture-private",
      });
      const notYet = vi.fn();
      navigate({ preventDefault: notYet }, "https://identity.example:8443/authorize");
      expect(notYet).toHaveBeenCalledOnce();
      vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld)
        .mockResolvedValueOnce({ status: "valid" })
        .mockResolvedValueOnce({ status: "refused" });
      expect(
        await host.submitCredentialFill(
          contextId,
          owner,
          plan.planId,
          new Date(Date.now() + 180_000).toISOString(),
        ),
      ).toEqual({ status: "cancelled", effect: "none" });
      const staleAdmission = vi.fn();
      navigate({ preventDefault: staleAdmission }, "https://identity.example:8443/authorize");
      expect(staleAdmission).toHaveBeenCalledOnce();
      plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
      if (plan.status !== "prepared") throw new Error("Expected fresh form");
      await host.reserveCredentialFill(contextId, owner, plan.planId, [
        "https://example.com",
        "https://identity.example",
        "https://identity.example:8443",
      ]);
      await host.commitCredentialFill(contextId, owner, plan.planId, {
        username: "fixture",
        password: "fixture-private",
      });
      expect(
        await host.submitCredentialFill(
          contextId,
          owner,
          plan.planId,
          new Date(Date.now() + 180_000).toISOString(),
        ),
      ).toEqual({
        status: "authentication-required",
        effect: "completed",
      });
      for (const target of [
        "https://identity.example:8443/authorize",
        "https://example.com/callback",
      ]) {
        const refused = vi.fn();
        navigate({ preventDefault: refused }, target);
        expect(refused).not.toHaveBeenCalled();
      }
      for (const target of [
        "https://identity.example/authorize",
        "https://unreviewed.example/authorize",
      ]) {
        const refused = vi.fn();
        navigate({ preventDefault: refused }, target);
        expect(refused).toHaveBeenCalledOnce();
      }
      for (const eventName of ["will-frame-navigate", "will-redirect"]) {
        const guard = vi
          .mocked(created.webContents.on)
          .mock.calls.find(([name]) => name === eventName)?.[1];
        if (guard === undefined) throw new Error("Expected frame-aware guard");
        const main = vi.fn();
        guard({
          preventDefault: main,
          isMainFrame: true,
          url: "https://identity.example:8443/authorize",
        });
        expect(main).not.toHaveBeenCalled();
        const frame = vi.fn();
        guard({
          preventDefault: frame,
          isMainFrame: false,
          url: "https://identity.example:8443/authorize",
        });
        expect(frame).toHaveBeenCalledOnce();
        const unknown = vi.fn();
        guard({ preventDefault: unknown, url: "https://identity.example:8443/authorize" });
        expect(unknown).toHaveBeenCalledOnce();
      }
      expect(createView).toHaveBeenCalledOnce();
    } finally {
      await host.closeAll();
    }
  });

  it("expires abandoned form plans and releases reserved ownership after the window disappears", async () => {
    vi.useFakeTimers();
    const created = view();
    let available = true;
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
      async (_world, scripts) =>
        scripts[0]?.code.includes('"operation":"validate"')
          ? { status: "valid" }
          : {
              status: "prepared",
              usernameLabel: "Email",
              passwordLabel: "Password",
              submissionOrigin: "https://example.com",
            },
    );
    const host = createBrowserSurfaceHost({
      createView: () => created,
      isOwnerWindowAvailable: () => available,
    });
    const owner = { windowId: "window-a", threadId };
    try {
      await host.createContext({
        contextId,
        owner,
        policy: {
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 1,
          sessionTimeoutMs: 300_000,
        },
      });
      for (let i = 0; i < 32; i++)
        expect(
          (await host.prepareCredentialFill(contextId, owner, "https://example.com")).status,
        ).toBe("prepared");
      expect(
        (await host.prepareCredentialFill(contextId, owner, "https://example.com")).status,
      ).toBe("refused");
      await vi.advanceTimersByTimeAsync(180_001);
      const plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
      if (plan.status !== "prepared") throw new Error("Expired plans must release capacity");
      expect(
        await host.reserveCredentialFill(contextId, owner, plan.planId, [
          "https://example.com",
          "https://identity.example",
          "https://identity.example:8443",
        ]),
      ).toEqual({
        status: "reserved",
      });
      available = false;
      host.cancelCredentialFill(contextId, owner, plan.planId);
      available = true;
      await expect(host.peek(contextId)).resolves.toMatchObject({ url: "https://example.com/" });
      expect(
        await host.commitCredentialFill(contextId, owner, plan.planId, {
          username: "never",
          password: "never",
        }),
      ).toEqual({ status: "cancelled", effect: "none" });
    } finally {
      await host.closeAll();
      vi.useRealTimers();
    }
  });

  it("withholds a capture already awaited when credential custody starts", async () => {
    const created = view();
    let releaseCapture:
      | ((value: Awaited<ReturnType<typeof created.webContents.capturePage>>) => void)
      | undefined;
    const image = { isEmpty: () => false, toJPEG: () => Uint8Array.from([1, 2, 3]) };
    vi.mocked(created.webContents.capturePage).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCapture = resolve;
        }),
    );
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementation(
      async (_world, scripts) =>
        scripts[0]?.code.includes('"operation":"validate"')
          ? { status: "valid" }
          : {
              status: "prepared",
              usernameLabel: "Email",
              passwordLabel: "Password",
              submissionOrigin: "https://example.com",
            },
    );
    const host = createBrowserSurfaceHost({ createView: () => created });
    const owner = { windowId: "window-a", threadId };
    await host.createContext({
      contextId,
      owner,
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const plan = await host.prepareCredentialFill(contextId, owner, "https://example.com");
    expect(plan.status).toBe("prepared");
    if (plan.status !== "prepared") throw new Error("Expected prepared fixture");
    const capture = host.peek(contextId);
    await vi.waitFor(() => expect(releaseCapture).toBeDefined());
    expect(
      await host.reserveCredentialFill(contextId, owner, plan.planId, [
        "https://example.com",
        "https://identity.example",
        "https://identity.example:8443",
      ]),
    ).toEqual({
      status: "reserved",
    });
    await expect(host.peek(contextId)).rejects.toThrow(/credential fill holds observations/);
    await expect(host.act(contextId, { kind: "snapshot" })).rejects.toThrow(
      /credential fill holds observations/,
    );
    host.cancelCredentialFill(contextId, owner, plan.planId);
    releaseCapture?.(image);
    await expect(capture).rejects.toThrow(/credential fill holds observations/);

    vi.mocked(created.webContents.capturePage).mockResolvedValue(image);
    await expect(host.peek(contextId)).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("keeps an admitted pointer down ahead of its release while composition cleanup awaits", async () => {
    let receive:
      | ((image: {
          getSize: () => { width: number; height: number };
          toJPEG: () => Uint8Array;
        }) => void)
      | undefined;
    const editorId = "60000000-0000-4000-8000-000000000019";
    const base = view();
    const input = vi.fn();
    const target = { id: editorId, selectionStart: 0, selectionEnd: 0 };
    vi.mocked(base.webContents.executeJavaScriptInIsolatedWorld).mockResolvedValue(target);
    let finish: (() => void) | undefined;
    const cancellation = new Promise<void>((done) => {
      finish = done;
    });
    let cancelling = false;
    vi.mocked(base.webContents.debugger.sendCommand).mockImplementation(
      async (method, parameters) => {
        if (method === "Input.imeSetComposition" && parameters?.text === "") {
          cancelling = true;
          await cancellation;
        }
      },
    );
    const host = createBrowserSurfaceHost({
      isEmbeddedOwner: () => true,
      isOwnerWindowAvailable: () => true,
      createView: () => ({
        ...base,
        human: {
          input,
          visible: vi.fn(),
          bounds: vi.fn(),
          frames: (listener) => {
            receive = listener;
            return () => {};
          },
          editor: async () => ({
            ...target,
            id: decodeBrowserEditorId(editorId),
            caret: { x: 20, y: 30, width: 0, height: 24 },
          }),
        },
      }),
    });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        profile: { kind: "personal" },
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      },
    });
    const request = (value: Readonly<Record<string, unknown>>) =>
      decodeHumanBrowserRequest({ contextId, threadId, ...value });
    const attached = await host.humanPresentation(request({ kind: "attach" }), "window-a");
    if (attached.status !== "attached") throw new Error("Attachment refused");
    const send = (value: Readonly<Record<string, unknown>>) =>
      host.humanPresentation(
        request({ presentationId: attached.presentationId, ...value }),
        "window-a",
      );
    await send({ kind: "layout", layout: { width: 800, height: 600, visible: true } });
    receive?.({ getSize: () => ({ width: 800, height: 600 }), toJPEG: () => new Uint8Array([1]) });
    await send({ kind: "frame", acknowledgement: 0 });
    const started = await send({ kind: "composition", composition: { phase: "begin", editorId } });
    if (started.status !== "composition-started") throw new Error("Composition refused");
    const down = send({
      kind: "input",
      frameSequence: 1,
      input: { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 },
    });
    await vi.waitFor(() => expect(cancelling).toBe(true));
    const up = send({
      kind: "input",
      frameSequence: 1,
      input: { type: "mouseUp", x: 10, y: 20, button: "left", clickCount: 1 },
    });
    receive?.({ getSize: () => ({ width: 800, height: 600 }), toJPEG: () => new Uint8Array([2]) });
    expect(await send({ kind: "frame", acknowledgement: 1 })).toMatchObject({
      status: "frame",
      sequence: 2,
    });
    expect(input).not.toHaveBeenCalled();
    finish?.();
    expect(await down).toEqual({ status: "accepted" });
    expect(await up).toEqual({ status: "accepted" });
    expect(input.mock.calls.map((call) => call[0])).toEqual([
      { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 },
      { type: "mouseUp", x: -1, y: -1, button: "left", clickCount: 1 },
    ]);
    expect(
      await send({
        kind: "input",
        frameSequence: 1,
        input: { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 },
      }),
    ).toEqual({ status: "refused" });
    host.closeContext(contextId);
  });
  it("refuses a composition edit when an agent action takes the surface while the edit awaits its field", async () => {
    let receive:
      | ((image: {
          getSize: () => { width: number; height: number };
          toJPEG: () => Uint8Array;
        }) => void)
      | undefined;
    const editorId = "60000000-0000-4000-8000-000000000029";
    const base = view();
    const target = { id: editorId, selectionStart: 0, selectionEnd: 0 };
    vi.mocked(base.webContents.executeJavaScriptInIsolatedWorld).mockResolvedValue(target);
    const host = createBrowserSurfaceHost({
      isEmbeddedOwner: () => true,
      isOwnerWindowAvailable: () => true,
      createView: () => ({
        ...base,
        human: {
          input: vi.fn(),
          visible: vi.fn(),
          bounds: vi.fn(),
          frames: (listener) => {
            receive = listener;
            return () => {};
          },
          editor: async () => ({
            ...target,
            id: decodeBrowserEditorId(editorId),
            caret: { x: 20, y: 30, width: 0, height: 24 },
          }),
        },
      }),
    });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        profile: { kind: "personal" },
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      },
    });
    const request = (value: Readonly<Record<string, unknown>>) =>
      decodeHumanBrowserRequest({ contextId, threadId, ...value });
    const attached = await host.humanPresentation(request({ kind: "attach" }), "window-a");
    if (attached.status !== "attached") throw new Error("Attachment refused");
    const send = (value: Readonly<Record<string, unknown>>) =>
      host.humanPresentation(
        request({ presentationId: attached.presentationId, ...value }),
        "window-a",
      );
    await send({ kind: "layout", layout: { width: 800, height: 600, visible: true } });
    receive?.({ getSize: () => ({ width: 800, height: 600 }), toJPEG: () => new Uint8Array([1]) });
    await send({ kind: "frame", acknowledgement: 0 });
    const started = await send({ kind: "composition", composition: { phase: "begin", editorId } });
    if (started.status !== "composition-started") throw new Error("Composition refused");

    let fieldFound = () => {};
    let agentRead = () => {};
    vi.mocked(base.webContents.executeJavaScriptInIsolatedWorld)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            fieldFound = () => resolve(target);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            agentRead = () => resolve(undefined);
          }),
      );
    const calls = vi.mocked(base.webContents.executeJavaScriptInIsolatedWorld).mock.calls.length;
    const update = send({
      kind: "composition",
      composition: {
        phase: "update",
        compositionId: started.compositionId,
        text: "é",
        selectionStart: 1,
        selectionEnd: 1,
      },
    });
    await vi.waitFor(() =>
      expect(vi.mocked(base.webContents.executeJavaScriptInIsolatedWorld).mock.calls.length).toBe(
        calls + 1,
      ),
    );
    const agentAction = host.act(contextId, { kind: "snapshot" });
    await vi.waitFor(() =>
      expect(vi.mocked(base.webContents.executeJavaScriptInIsolatedWorld).mock.calls.length).toBe(
        calls + 2,
      ),
    );
    fieldFound();
    expect(await update).toEqual({ status: "refused" });
    expect(base.webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      "Input.imeSetComposition",
      expect.objectContaining({ text: "é" }),
    );
    agentRead();
    await agentAction.catch(() => undefined);
    host.closeContext(contextId);
  });

  it("hides expired embedded profiles and isolates listeners while closing owned views", async () => {
    let available = true;
    const base = view();
    const created = { ...base, webContents: { ...base.webContents, id: 701 } };
    const input = vi.fn();
    const visible = vi.fn();
    const close = vi.fn();
    const source = { input, visible, bounds: vi.fn(), frames: () => () => {} };
    const host = createBrowserSurfaceHost({
      createView: () => ({ ...created, human: source, close }),
      isOwnerWindowAvailable: () => available,
      isEmbeddedOwner: () => available,
    });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        profile: { kind: "personal" },
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      },
    });
    const request = (value: Readonly<Record<string, unknown>>) =>
      decodeHumanBrowserRequest({ contextId, threadId, ...value });
    const attached = await host.humanPresentation(request({ kind: "attach" }), "window-a");
    if (attached.status !== "attached") throw new Error("Attachment refused");
    await host.humanPresentation(
      request({
        kind: "layout",
        presentationId: attached.presentationId,
        layout: { width: 800, height: 600, visible: true },
      }),
      "window-a",
    );
    expect(host.profileTabs({ kind: "personal" }, "window-a")).toHaveLength(1);
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await host.humanPresentation(
        request({ kind: "command", presentationId: attached.presentationId, command: "reload" }),
        "window-a",
        aborted.signal,
      ),
    ).toEqual({ status: "refused" });
    expect(created.webContents.reload).not.toHaveBeenCalled();
    available = false;
    expect(host.profileTabs({ kind: "personal" }, "window-a")).toMatchObject([{ active: false }]);
    expect(
      await host.openProfileTab({ kind: "personal" }, "window-a", "https://example.com/"),
    ).toEqual({ status: "no-page" });
    expect(
      await host.humanPresentation(
        request({ kind: "frame", presentationId: attached.presentationId, acknowledgement: 0 }),
        "window-a",
      ),
    ).toEqual({ status: "refused" });
    const sibling = vi.fn();
    host.onContextGone(() => {
      throw new Error("observer failed");
    });
    host.onContextGone(sibling);
    await host.closeOwnerContexts("window-a");
    expect(visible).toHaveBeenLastCalledWith(false);
    expect(close).toHaveBeenCalledOnce();
    expect(sibling).toHaveBeenCalledWith(contextId);
  });

  it("refuses certificate acceptance it cannot bind to this surface's one origin", async () => {
    // Local-certificate acceptance is bounded to the exact origin this tab was
    // opened for.
    // Electron's certificate verify proc reports only `request.hostname` — no
    // scheme, no port, no URL — because Chromium verifies a certificate against
    // a host, and the result is cached by the network service. A second
    // self-signed service on another port of the same loopback host is
    // therefore indistinguishable from the allowed origin, and subresource
    // requests never reach the navigation guard. Fail closed: install no
    // acceptance override at all and leave Chromium's verdict in force.
    const accepting = view();
    const acceptingHost = createBrowserSurfaceHost({ createView: vi.fn(() => accepting) });
    await acceptingHost.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://127.0.0.1:8443"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
        acceptsLocalCertificate: true,
      },
    });

    expect(accepting.webContents.session.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  it("creates one sandboxed isolated surface and denies permissions and popups", async () => {
    const created = view();
    const createView = vi.fn(() => created);
    const host = createBrowserSurfaceHost({ createView });

    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    expect(createView).toHaveBeenCalledWith({
      owner: { windowId: "window-a", threadId },
      partition: `octant-browser-${contextId}`,
      webPreferences: {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(created.webContents.session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(created.webContents.session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(created.webContents.session.setDevicePermissionHandler).toHaveBeenCalledOnce();
    expect(created.webContents.session.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();
    const permissionHandler = vi.mocked(created.webContents.session.setPermissionRequestHandler)
      .mock.calls[0]?.[0];
    const permissionDecision = vi.fn();
    permissionHandler?.(created.webContents, "geolocation", permissionDecision);
    expect(permissionDecision).toHaveBeenCalledWith(false);
    const downloadHandler = vi
      .mocked(created.webContents.session.on)
      .mock.calls.find(([event]) => event === "will-download")?.[1];
    const preventDownload = vi.fn();
    downloadHandler?.({ preventDefault: preventDownload });
    expect(preventDownload).toHaveBeenCalledOnce();
    const popupHandler = vi.mocked(created.webContents.setWindowOpenHandler).mock.calls[0]?.[0];
    expect(popupHandler?.({ url: "https://example.com/popup" })).toEqual({ action: "deny" });

    const redirectGuard = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "will-redirect")?.[1];
    const preventRedirect = vi.fn();
    redirectGuard?.({ preventDefault: preventRedirect }, { url: "https://attacker.invalid/" });
    expect(preventRedirect).toHaveBeenCalledOnce();
    const allowRedirect = vi.fn();
    redirectGuard?.({ preventDefault: allowRedirect }, { url: "https://example.com/next" });
    expect(allowRedirect).not.toHaveBeenCalled();
    const frameNavigationGuard = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "will-frame-navigate")?.[1];
    const allowFrameNavigation = vi.fn();
    frameNavigationGuard?.({
      url: "https://example.com/account",
      isMainFrame: true,
      preventDefault: allowFrameNavigation,
    });
    expect(allowFrameNavigation).not.toHaveBeenCalled();
    const loginHandler = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "login")?.[1];
    const preventLogin = vi.fn();
    const cancelLogin = vi.fn();
    loginHandler?.({ preventDefault: preventLogin }, {}, {}, cancelLogin);
    expect(preventLogin).toHaveBeenCalledOnce();
    expect(cancelLogin).toHaveBeenCalledWith();
    const certificateHandler = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "select-client-certificate")?.[1];
    const preventCertificate = vi.fn();
    const rejectCertificate = vi.fn();
    certificateHandler?.({ preventDefault: preventCertificate }, {}, rejectCertificate);
    expect(preventCertificate).toHaveBeenCalledOnce();
    expect(rejectCertificate).toHaveBeenCalledWith();
  });

  it("attaches only to its owning Project window and hides on detach", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const window = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    expect(() =>
      host.attach(contextId, { windowId: "window-b", threadId }, window, {
        x: 10,
        y: 20,
        width: 640,
        height: 480,
      }),
    ).toThrow("owning Project window");

    host.attach(contextId, { windowId: "window-a", threadId }, window, {
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    });
    expect(window.contentView.addChildView).toHaveBeenCalledWith(created);
    expect(created.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 640, height: 480 });
    expect(created.setVisible).toHaveBeenLastCalledWith(true);

    expect(() =>
      host.updateBounds(
        contextId,
        { windowId: "window-a", threadId },
        {
          x: Number.NaN,
          y: 20,
          width: 640,
          height: 480,
        },
      ),
    ).toThrow("invalid Browser surface bounds");
    await expect(
      host.command(contextId, { windowId: "window-b", threadId }, "reload"),
    ).rejects.toThrow("does not own this context");

    host.detach(contextId, { windowId: "window-a", threadId });
    expect(created.setVisible).toHaveBeenLastCalledWith(false);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(created);
  });

  it("rejects navigation outside the server-owned allowlist and destroys closed contents", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await expect(
      host.act(contextId, { kind: "navigate", target: "https://attacker.invalid/" }),
    ).rejects.toThrow("allowlist");
    await host.act(contextId, { kind: "navigate", target: "https://example.com/docs" });
    expect(created.webContents.loadURL).toHaveBeenCalledWith("https://example.com/docs");

    await host.closeContext(contextId);
    expect(created.webContents.close).toHaveBeenCalledOnce();
    await expect(host.act(contextId, { kind: "screenshot" })).rejects.toThrow("unknown");
  });

  it("names the refused redirect target when an allowed navigation moves off-origin", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const redirectGuard = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "will-redirect")?.[1];
    // Chromium cancels the load when the guard refuses the redirect, so
    // loadURL rejects with an opaque ERR_ABORTED after the guard has run.
    vi.mocked(created.webContents.loadURL).mockImplementationOnce(async () => {
      // A site's own www host is the same place; a different site is not.
      redirectGuard?.({
        preventDefault: vi.fn(),
        isMainFrame: true,
        url: "https://login.example.net/",
      });
      throw new Error("ERR_ABORTED (-3) loading 'https://example.com/'");
    });
    await expect(
      host.act(contextId, { kind: "navigate", target: "https://example.com/" }),
    ).rejects.toMatchObject({
      name: "BrowserNavigationBlockedError",
      url: "https://login.example.net/",
    });
    // The refusal is per action: an unrelated later failure keeps its own cause.
    vi.mocked(created.webContents.loadURL).mockRejectedValueOnce(new Error("ERR_TIMED_OUT"));
    await expect(
      host.act(contextId, { kind: "navigate", target: "https://example.com/" }),
    ).rejects.toThrow("ERR_TIMED_OUT");
  });

  it("serializes user chrome commands behind an in-flight agent action", async () => {
    const created = view();
    let releaseAction!: () => void;
    const action = new Promise<{ x: number; y: number }>((resolve) => {
      releaseAction = () => resolve({ x: 20, y: 30 });
    });
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld)
      .mockImplementationOnce(async () => action)
      .mockResolvedValue(undefined);
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const window = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    host.attach(contextId, { windowId: "window-a", threadId }, window, {
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    });

    const agentAction = host.act(contextId, { kind: "click", target: "#continue" });
    await vi.waitFor(() =>
      expect(window.webContents.send).toHaveBeenCalledWith(
        "octant:browser-surface:state",
        expect.objectContaining({ control: "agent" }),
      ),
    );
    const mouseGate = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "before-mouse-event")?.[1];
    // The person's click during the agent's action is delivered, not dropped,
    // and reported so the server can drop the agent's refs.
    const personInput = vi.fn();
    const stopListening = host.onPersonInput(personInput);
    const preventMouseRace = vi.fn();
    mouseGate?.({ preventDefault: preventMouseRace }, { type: "mouseDown" });
    expect(preventMouseRace).not.toHaveBeenCalled();
    expect(personInput).toHaveBeenCalledExactlyOnceWith(contextId);
    // A pointer drifting over the page is not the person using it.
    mouseGate?.({ preventDefault: preventMouseRace }, { type: "mouseMove" });
    expect(personInput).toHaveBeenCalledOnce();
    const keyGate = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "before-input-event")?.[1];
    keyGate?.({ preventDefault: preventMouseRace }, { type: "keyDown", key: "a" });
    expect(preventMouseRace).not.toHaveBeenCalled();
    expect(personInput).toHaveBeenCalledTimes(2);
    stopListening();
    const userCommand = Promise.resolve(
      host.command(contextId, { windowId: "window-a", threadId }, "reload"),
    );
    expect(created.webContents.reload).not.toHaveBeenCalled();

    releaseAction();
    await agentAction;
    await userCommand;
    expect(created.webContents.reload).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      "octant:browser-surface:state",
      expect.objectContaining({ control: "user" }),
    );
  });

  it("delivers the person's embedded keys and releases while an agent action is in flight", async () => {
    const created = view();
    let releaseAction!: () => void;
    const action = new Promise<{ x: number; y: number }>((resolve) => {
      releaseAction = () => resolve({ x: 20, y: 30 });
    });
    let offer:
      | ((image: { getSize(): { width: number; height: number }; toJPEG(): Uint8Array }) => void)
      | undefined;
    const delivered = vi.fn();
    const source = {
      input: delivered,
      visible: vi.fn(),
      bounds: vi.fn(),
      frames: (listener: NonNullable<typeof offer>) => {
        offer = listener;
        return () => {};
      },
    };
    const host = createBrowserSurfaceHost({
      createView: () => ({ ...created, human: source, close: vi.fn() }),
      isEmbeddedOwner: () => true,
    });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const request = (value: Readonly<Record<string, unknown>>) =>
      decodeHumanBrowserRequest({ contextId, threadId, ...value });
    const attached = await host.humanPresentation(request({ kind: "attach" }), "window-a");
    if (attached.status !== "attached") throw new Error("Attachment refused");
    const presentationId = attached.presentationId;
    await host.humanPresentation(
      request({
        kind: "layout",
        presentationId,
        layout: { width: 800, height: 600, visible: true },
      }),
      "window-a",
    );
    offer?.({ getSize: () => ({ width: 800, height: 600 }), toJPEG: () => Uint8Array.from([1]) });
    expect(
      await host.humanPresentation(
        request({ kind: "frame", presentationId, acknowledgement: 0 }),
        "window-a",
      ),
    ).toMatchObject({ status: "frame", sequence: 1 });
    const key = (type: "keyDown" | "keyUp" | "char", keyCode: string) =>
      host.humanPresentation(
        request({ kind: "input", presentationId, frameSequence: 1, input: { type, keyCode } }),
        "window-a",
      );
    expect(await key("keyDown", "Shift")).toEqual({ status: "accepted" });

    const personInput = vi.fn();
    const stopListening = host.onPersonInput(personInput);
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockImplementationOnce(
      async () => action,
    );
    const agentAction = host.act(contextId, { kind: "snapshot" });
    await vi.waitFor(() =>
      expect(created.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalled(),
    );
    // A held modifier released mid-action is released in the page, and new
    // typing is delivered and reported so the agent's snapshot goes stale.
    expect(await key("keyUp", "Shift")).toEqual({ status: "accepted" });
    expect(await key("keyDown", "a")).toEqual({ status: "accepted" });
    expect(delivered).toHaveBeenLastCalledWith({ type: "keyDown", keyCode: "a" });
    expect(personInput).toHaveBeenCalledWith(contextId);
    stopListening();
    releaseAction();
    await agentAction.catch(() => undefined);
  });

  it("refuses an agent keystroke or click the moment the person has typed, until the agent reads the page", async () => {
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockResolvedValue(undefined);
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const keyGate = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "before-input-event")?.[1];
    keyGate?.({ preventDefault: vi.fn() }, { type: "keyDown", key: "a" });
    const calls = vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mock.calls.length;

    // No poll has run: the host itself knows, synchronously.
    for (const kind of ["click", "type", "press"] as const) {
      await expect(
        host.act(contextId, { kind, target: "#name", value: "x" }),
      ).rejects.toBeInstanceOf(BrowserTargetStaleError);
    }
    expect(vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mock.calls).toHaveLength(
      calls,
    );
  });

  it("omits sensitive document text, hashes, and screenshots from observations", async () => {
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld)
      .mockResolvedValueOnce("one-time code 123456")
      .mockResolvedValueOnce({ width: 1280, height: 720 })
      .mockResolvedValueOnce(true);
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    const observation = await host.act(contextId, { kind: "screenshot" });
    expect(observation.extractedText).toBeUndefined();
    expect(observation.contentHash).toBeUndefined();
    expect(observation.screenshotDataUrl).toBeUndefined();
  });

  it("shrinks a picture too large for the observation instead of dropping it", async () => {
    // A busy page at full Retina size is several times the observation's
    // limit; the preview then showed only the title over an empty frame.
    const created = view();
    const small = {
      isEmpty: () => false,
      toJPEG: () => Uint8Array.from([1, 2, 3]),
      getSize: () => ({ width: 1_280, height: 800 }),
    };
    const resize = vi.fn(() => small);
    vi.mocked(created.webContents.capturePage).mockResolvedValue({
      isEmpty: () => false,
      toJPEG: () => new Uint8Array(80 * 1_024),
      getSize: () => ({ width: 2_560, height: 1_600 }),
      resize,
    });
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    const observation = await host.act(contextId, { kind: "screenshot" });

    expect(resize).toHaveBeenCalledWith({ width: 1_280 });
    expect(observation.screenshotDataUrl).toBe("data:image/jpeg;base64,AQID");
  });

  it("captures a detached surface's page through the renderer when compositing paints nothing", async () => {
    // A surface that is not in a window produces an empty capturePage image;
    // the renderer itself still holds the page, so the debugger takes the
    // picture directly.
    const created = view();
    vi.mocked(created.webContents.capturePage).mockResolvedValue({
      isEmpty: () => true,
      toJPEG: () => new Uint8Array(0),
    });
    vi.mocked(created.webContents.debugger.sendCommand).mockImplementation(async (method) =>
      method === "Page.captureScreenshot" ? { data: "aGk=" } : undefined,
    );
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    const observation = await host.act(contextId, { kind: "screenshot" });

    expect(created.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({ fromSurface: false }),
    );
    expect(observation.screenshotDataUrl).toBe("data:image/jpeg;base64,aGk=");
    expect(created.webContents.debugger.isAttached()).toBe(false);
  });

  it("answers a peek for a context whose page has not committed a document", async () => {
    // A fresh surface has no committed document, and Chromium never settles a
    // script evaluation queued against it: the probe would wait forever while
    // the renderer's poll repeats, so peek reports the empty page instead.
    const created = view();
    vi.mocked(created.webContents.getURL).mockReturnValue("");
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockReturnValue(
      new Promise(() => undefined),
    );
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await expect(host.peek(contextId)).resolves.toEqual({});
    expect(created.webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(created.webContents.capturePage).not.toHaveBeenCalled();
  });

  it("keeps the native context reusable after an agent closes its current tab", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await host.act(contextId, { kind: "close-tab" });
    expect(created.webContents.loadURL).toHaveBeenCalledWith("about:blank");
    expect(created.webContents.close).not.toHaveBeenCalled();
    await host.act(contextId, { kind: "navigate", target: "https://example.com/next" });
    expect(created.webContents.loadURL).toHaveBeenLastCalledWith("https://example.com/next");
  });

  it("reports a crashed native page so only that server context becomes stale", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    const gone = vi.fn();
    host.onContextGone(gone);
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const crashed = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "render-process-gone")?.[1];

    crashed?.();

    expect(gone).toHaveBeenCalledWith(contextId);
    expect(created.webContents.close).toHaveBeenCalledOnce();
    await expect(host.act(contextId, { kind: "extract-text" })).rejects.toThrow("unknown");
  });

  it("reports owner cleanup so the server does not retain an active native context", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    const gone = vi.fn();
    host.onContextGone(gone);
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await host.closeOwnerContexts("window-a");

    expect(gone).toHaveBeenCalledWith(contextId);
    expect(created.webContents.close).toHaveBeenCalledOnce();
  });

  it("does not execute a native action after its broker request is cancelled", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(host.act(contextId, { kind: "extract-text" }, abort.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(created.webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("drives page controls through trusted Chromium input instead of synthetic DOM events", async () => {
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld)
      .mockResolvedValueOnce({ x: 24, y: 36 })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(false);
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await host.act(contextId, { kind: "click", target: "#continue" });

    expect(created.webContents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(created.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 24, y: 36 }),
    );
    expect(created.webContents.debugger.detach).toHaveBeenCalledOnce();
  });
  it("lets the person reach a new origin without handing the agent that page", async () => {
    // Browsing is the person's own action, so a link they follow may leave the
    // origins approval granted. What must not follow is the agent inheriting
    // it: the page they reached is theirs to read, not the agent's.
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 4,
        sessionTimeoutMs: 300_000,
      },
    });
    const listener = (event: string) =>
      vi.mocked(created.webContents.on).mock.calls.find(([name]) => name === event)?.[1];

    listener("focus")?.();
    const followed = vi.fn();
    listener("will-navigate")?.({ preventDefault: followed }, { url: "https://research.test/a" });
    expect(followed).not.toHaveBeenCalled();
    const again = vi.fn();
    listener("will-navigate")?.({ preventDefault: again }, { url: "https://research.test/b" });
    expect(again).not.toHaveBeenCalled();

    vi.mocked(created.webContents.getURL).mockReturnValue("https://research.test/a");
    await expect(host.act(contextId, { kind: "extract-text" })).rejects.toThrow("allowed origins");
    await expect(
      host.act(contextId, { kind: "navigate", target: "https://research.test/a" }),
    ).rejects.toThrow("allowlist");
  });

  it("refuses a page the agent could not manage to leave", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    vi.mocked(created.webContents.getURL).mockReturnValue("https://research.test/a");

    await expect(
      host.act(contextId, { kind: "navigate", target: "https://example.com/next" }),
    ).rejects.toThrow("allowed origins");
  });

  it("lists a tab the person took to an unapproved site without its address or title", async () => {
    const views = [view(), view()];
    let opened = 0;
    const host = createBrowserSurfaceHost({ createView: () => views[opened++] ?? view() });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      },
    });
    await host.tabCommand(contextId, { windowId: "window-a", threadId }, { kind: "open" });
    vi.mocked(views[1]!.webContents.getURL).mockReturnValue("https://mail.example.org/inbox");
    vi.mocked(views[1]!.webContents.getTitle).mockReturnValue("Inbox (3)");
    await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "select", tabId: `${contextId}:1` },
    );

    const listed = await host.act(contextId, { kind: "tab-list" });

    expect(listed.tabs).toEqual([
      { tabId: "t1", url: "https://example.com/", title: "Example", active: true },
      { tabId: "t2", active: false },
    ]);
    await expect(host.act(contextId, { kind: "tab-select", tabId: "t2" })).rejects.toThrow(
      /outside this context's allowed origins/,
    );
    // With the person's tab in front, the agent can still list and move.
    await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "select", tabId: `${contextId}:2` },
    );
    expect((await host.act(contextId, { kind: "tab-list" })).tabs).toHaveLength(2);
    expect(
      (await host.act(contextId, { kind: "tab-select", tabId: "t1" })).tabs?.[0],
    ).toMatchObject({
      active: true,
    });
  });

  it("opens a second page in the same session and shows one tab at a time", async () => {
    const views = [view(), view(), view()];
    let opened = 0;
    const host = createBrowserSurfaceHost({
      createView: () => views[opened++] ?? view(),
    });
    const shellWindow = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      },
    });
    host.attach(contextId, { windowId: "window-a", threadId }, shellWindow, {
      x: 10,
      y: 20,
      width: 400,
      height: 300,
    });

    const twoTabs = await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "open" },
    );

    // One partition, so a sign-in in the first tab is a sign-in in the second.
    expect(opened).toBe(2);
    expect(views[1]?.webContents.loadURL).toHaveBeenCalledWith("about:blank");
    expect(twoTabs.tabs).toHaveLength(2);
    expect(twoTabs.activeTabId).toBe(twoTabs.tabs[1]?.tabId);
    // The outgoing tab leaves the window rather than merely turning invisible:
    // a hidden child view still holds the same rectangle.
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(views[1]?.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 400, height: 300 });
    await expect(
      host.tabCommand(contextId, { windowId: "window-a", threadId }, { kind: "open" }),
    ).rejects.toThrow("tab limit");

    const back = await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "select", tabId: twoTabs.tabs[0]!.tabId },
    );
    expect(back.activeTabId).toBe(twoTabs.tabs[0]?.tabId);

    const closed = await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "close", tabId: twoTabs.tabs[0]!.tabId },
    );
    expect(closed.tabs).toHaveLength(1);
    expect(closed.activeTabId).toBe(twoTabs.tabs[1]?.tabId);
    expect(views[0]?.webContents.close).toHaveBeenCalledOnce();
    await expect(
      host.tabCommand(
        contextId,
        { windowId: "window-a", threadId },
        { kind: "close", tabId: closed.tabs[0]!.tabId },
      ),
    ).rejects.toThrow("only tab");
  });

  it("keeps a research session when one of its tabs goes away on its own", async () => {
    const views = [view(), view()];
    let opened = 0;
    const host = createBrowserSurfaceHost({ createView: () => views[opened++] ?? view() });
    const gone = vi.fn();
    host.onContextGone(gone);
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 4,
        sessionTimeoutMs: 300_000,
      },
    });
    await host.tabCommand(contextId, { windowId: "window-a", threadId }, { kind: "open" });

    vi.mocked(views[1]!.webContents.on).mock.calls.find(
      ([event]) => event === "render-process-gone",
    )?.[1]?.();

    expect(gone).not.toHaveBeenCalled();
    const state = host.state(contextId);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.tabId);
  });

  it("refuses a tab command from a window that does not own the context", async () => {
    const host = createBrowserSurfaceHost({ createView: () => view() });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 4,
        sessionTimeoutMs: 300_000,
      },
    });

    await expect(
      host.tabCommand(contextId, { windowId: "window-b", threadId }, { kind: "open" }),
    ).rejects.toThrow("does not own");
  });

  it("reports errors, warnings when asked, failed requests, and 4xx and 5xx responses after a cursor, clearing nothing", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    await host.act(contextId, { kind: "navigate", target: "https://example.com/" });
    const onConsole = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "console-message")?.[1];
    const onFailed = vi.mocked(created.webContents.session.webRequest!.onErrorOccurred).mock
      .calls[0]?.[0];
    expect(onConsole).toBeDefined();
    expect(onFailed).toBeDefined();

    const onCompleted = vi.mocked(created.webContents.session.webRequest!.onCompleted!).mock
      .calls[0]?.[0];
    expect(onCompleted).toBeDefined();

    onConsole!({ level: "info", message: "ready" });
    onConsole!({ level: "warning", message: "careful" });
    onConsole!({ level: "error", message: "  boom  " });
    onFailed!({ url: "https://example.com/missing.js", method: "GET", error: "net::ERR_FAILED" });
    onCompleted!({ url: "https://example.com/ok.js", method: "GET", statusCode: 200 });
    onCompleted!({ url: "https://example.com/api?token=s3cret", method: "POST", statusCode: 503 });

    const first = await host.act(contextId, { kind: "observe-diagnostics" });
    expect(first.consoleErrors).toEqual([{ text: "boom", url: "https://example.com/", seq: 2 }]);
    expect(first.failedRequests).toEqual([
      { url: "https://example.com/missing.js", method: "GET", failure: "net::ERR_FAILED", seq: 3 },
    ]);
    // The address and status only, with a secret in the address redacted.
    expect(first.httpErrors).toEqual([
      { url: "https://example.com/api?token=redacted", method: "POST", status: 503, seq: 4 },
    ]);
    expect(first.consoleWarnings).toBeUndefined();
    expect(first.diagnosticsCursor).toBe(4);

    // A second reader with no cursor still sees everything; nothing was cleared.
    const again = await host.act(contextId, {
      kind: "observe-diagnostics",
      diagnosticsWarnings: true,
    });
    expect(again.consoleWarnings).toEqual([
      { text: "careful", url: "https://example.com/", seq: 1 },
    ]);
    expect(again.consoleErrors).toHaveLength(1);

    onConsole!({ level: "error", message: "later" });
    const second = await host.act(contextId, {
      kind: "observe-diagnostics",
      diagnosticsSince: 4,
    });
    expect(second.consoleErrors).toEqual([{ text: "later", url: "https://example.com/", seq: 5 }]);
    expect(second.failedRequests).toEqual([]);
    expect(second.httpErrors).toEqual([]);

    const navigated = await host.act(contextId, { kind: "screenshot" });
    expect(navigated.consoleErrors).toBeUndefined();
    expect(navigated.failedRequests).toBeUndefined();
  });

  it("reports a failed first navigation's request even though no document committed", async () => {
    const created = view();
    vi.mocked(created.webContents.getURL).mockReturnValue("");
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockRejectedValue(
      new Error("No document."),
    );
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const onFailed = vi.mocked(created.webContents.session.webRequest!.onErrorOccurred).mock
      .calls[0]?.[0];
    onFailed!({ url: "https://example.com/", method: "GET", error: "net::ERR_CONNECTION_REFUSED" });

    const read = await host.act(contextId, { kind: "observe-diagnostics" });

    expect(read.failedRequests).toEqual([
      {
        url: "https://example.com/",
        method: "GET",
        failure: "net::ERR_CONNECTION_REFUSED",
        seq: 1,
      },
    ]);
    expect(read.consoleErrors).toEqual([]);
  });

  it("keeps the newest diagnostics when a page reports more than the bound", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    await host.act(contextId, { kind: "navigate", target: "https://example.com/" });
    const onConsole = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "console-message")?.[1];
    for (let index = 0; index < 40; index += 1) {
      onConsole!({ level: "error", message: `error ${String(index)}` });
    }

    const read = await host.act(contextId, { kind: "observe-diagnostics" });
    expect(read.consoleErrors).toHaveLength(32);
    expect(read.consoleErrors?.[0]?.text).toBe("error 8");
    expect(read.consoleErrors?.at(-1)?.text).toBe("error 39");
  });
});

describe("BrowserSurfaceHost stored profiles", () => {
  const projectId = "40000000-0000-4000-8000-000000000001";
  const policyIn = (profile?: { kind: "personal" } | { kind: "project"; projectId: string }) =>
    ({
      profileMode: "isolated",
      ...(profile === undefined ? {} : { profile }),
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 2,
      sessionTimeoutMs: 300_000,
    }) as never;

  it("keeps a profile page in the profile's persistent partition, not one of its own", async () => {
    const createView = vi.fn((_options: { readonly partition: string }) => view());
    const host = createBrowserSurfaceHost({ createView });

    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "personal" }),
    });
    await host.createContext({
      contextId: "60000000-0000-4000-8000-000000000002",
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "project", projectId }),
    });

    expect(createView.mock.calls.map(([options]) => options.partition)).toEqual([
      "persist:octant-profile-personal",
      `persist:octant-profile-project-${projectId}`,
    ]);
  });

  it("shares one partition between two contexts of a profile so a sign-in carries over", async () => {
    const createView = vi.fn((_options: { readonly partition: string }) => view());
    const host = createBrowserSurfaceHost({ createView });
    for (const id of [contextId, "60000000-0000-4000-8000-000000000002"]) {
      await host.createContext({
        contextId: id,
        owner: { windowId: "window-a", threadId },
        policy: policyIn({ kind: "personal" }),
      });
    }

    const partitions = createView.mock.calls.map(([options]) => options.partition);
    expect(new Set(partitions).size).toBe(1);
  });

  it("installs the download block once on a session two contexts share", async () => {
    const shared = view();
    const sharedSession = shared.webContents.session;
    const second = view();
    Object.assign(second.webContents, { session: sharedSession });
    const views = [shared, second];
    const host = createBrowserSurfaceHost({ createView: () => views.shift() ?? view() });
    for (const id of [contextId, "60000000-0000-4000-8000-000000000002"]) {
      await host.createContext({
        contextId: id,
        owner: { windowId: "window-a", threadId },
        policy: policyIn({ kind: "personal" }),
      });
    }

    const downloads = vi
      .mocked(sharedSession.on)
      .mock.calls.filter(([event]) => event === "will-download");
    expect(downloads).toHaveLength(1);
  });

  it("keeps the Private partition for a policy with no profile", async () => {
    const createView = vi.fn((_options: { readonly partition: string }) => view());
    const host = createBrowserSurfaceHost({ createView });

    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: policyIn(),
    });

    expect(createView.mock.calls[0]?.[0].partition).toBe(`octant-browser-${contextId}`);
  });

  it("reports a failed request to the context whose page failed, even on a shared session", async () => {
    const first = view();
    const second = view();
    Object.assign(first.webContents, { id: 11 });
    Object.assign(second.webContents, { id: 22 });
    const sharedSession = first.webContents.session;
    Object.assign(second.webContents, { session: sharedSession });
    const views = [first, second];
    const host = createBrowserSurfaceHost({ createView: () => views.shift() ?? view() });
    const other = "60000000-0000-4000-8000-000000000002";
    for (const id of [contextId, other]) {
      await host.createContext({
        contextId: id,
        owner: { windowId: "window-a", threadId },
        policy: policyIn({ kind: "personal" }),
      });
    }
    // Electron keeps one listener per session: the last tab to register wins.
    const listener = vi.mocked(sharedSession.webRequest!.onErrorOccurred).mock.calls.at(-1)?.[0];

    listener?.({ url: "https://example.com/a.js", error: "net::ERR_FAILED", webContentsId: 11 });

    await host.act(contextId, { kind: "navigate", target: "https://example.com/" });
    await host.act(other, { kind: "navigate", target: "https://example.com/" });
    const firstRead = await host.act(contextId, { kind: "observe-diagnostics" });
    const secondRead = await host.act(other, { kind: "observe-diagnostics" });
    expect(firstRead.failedRequests).toEqual([
      { url: "https://example.com/a.js", failure: "net::ERR_FAILED", seq: 1 },
    ]);
    expect(secondRead.failedRequests ?? []).toEqual([]);
  });

  it("closes every page of one profile, tells the server each is gone, and leaves other profiles open", async () => {
    const closed: string[] = [];
    const host = createBrowserSurfaceHost({ createView: () => view() });
    host.onContextGone((id) => closed.push(id));
    const personal = "60000000-0000-4000-8000-000000000002";
    const privatePage = "60000000-0000-4000-8000-000000000003";
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "project", projectId }),
    });
    await host.createContext({
      contextId: personal,
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "personal" }),
    });
    await host.createContext({
      contextId: privatePage,
      owner: { windowId: "window-a", threadId },
      policy: policyIn(),
    });

    await host.closeProfileContexts({ kind: "personal" });

    expect(closed).toEqual([personal]);
    expect(() => host.state(personal)).toThrow(/unknown/);
    expect(host.state(contextId)).toBeDefined();
    expect(host.state(privatePage)).toBeDefined();
  });

  describe("pages offered to an extension of the same profile", () => {
    let nextId = 100;
    const identified = () => {
      const base = view();
      return { ...base, webContents: { ...base.webContents, id: (nextId += 1) } };
    };
    const shellWindow = () => ({
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    });
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    async function setup() {
      const host = createBrowserSurfaceHost({ createView: () => identified() });
      const owner = { windowId: "window-a", threadId };
      const personalPage = contextId;
      const privatePage = "60000000-0000-4000-8000-000000000003";
      const otherWindow = "60000000-0000-4000-8000-000000000004";
      await host.createContext({
        contextId: personalPage,
        owner,
        policy: policyIn({ kind: "personal" }),
      });
      await host.createContext({ contextId: privatePage, owner, policy: policyIn() });
      await host.createContext({
        contextId: otherWindow,
        owner: { windowId: "window-b", threadId },
        policy: policyIn({ kind: "personal" }),
      });
      host.attach(personalPage, owner, shellWindow(), bounds);
      return host;
    }

    it("lists the profile's own pages in the window and never a Private page or another window's", async () => {
      const host = await setup();
      const tabs = host.profileTabs({ kind: "personal" }, "window-a");
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({ url: "https://example.com/", active: true });
      expect(
        host.profileTabs({ kind: "project", projectId: projectId as never }, "window-a"),
      ).toEqual([]);
      expect(host.profileTabs({ kind: "personal" }, "window-c")).toEqual([]);
    });

    it("opens a page for an extension only at an origin the page already admits", async () => {
      const host = await setup();
      const refused = await host.openProfileTab(
        { kind: "personal" },
        "window-a",
        "https://elsewhere.test/",
      );
      expect(refused).toEqual({ status: "origin-refused" });
      const opened = await host.openProfileTab(
        { kind: "personal" },
        "window-a",
        "https://example.com/next",
      );
      expect(opened.status).toBe("tab");
      expect(host.profileTabs({ kind: "personal" }, "window-a")).toHaveLength(2);
      expect(await host.openProfileTab({ kind: "personal" }, "window-a", undefined)).toEqual({
        status: "tab-limit",
      });
    });

    it("does not let a redirect from an extension's navigation grant the destination origin", async () => {
      const views: ReturnType<typeof identified>[] = [];
      const host = createBrowserSurfaceHost({
        createView: () => {
          const next = identified();
          views.push(next);
          return next;
        },
      });
      const owner = { windowId: "window-a", threadId };
      await host.createContext({ contextId, owner, policy: policyIn({ kind: "personal" }) });
      host.attach(contextId, owner, shellWindow(), bounds);
      const page = views[0];
      if (page === undefined) throw new Error("no page");
      const listener = (name: string) =>
        vi.mocked(page.webContents.on).mock.calls.find((call) => call[0] === name)?.[1];
      // The person has been browsing, so the surface is theirs.
      listener("focus")?.();
      const redirect = () => {
        const preventDefault = vi.fn();
        listener("will-redirect")?.({ url: "https://redirected.test/", preventDefault });
        return preventDefault;
      };
      let refusedDuringLoad = false;
      vi.mocked(page.webContents.loadURL).mockImplementationOnce(async () => {
        refusedDuringLoad = redirect().mock.calls.length > 0;
      });
      const [tab] = host.profileTabs({ kind: "personal" }, "window-a");

      await host.updateProfileTab({ kind: "personal" }, "window-a", tab?.id ?? -1, {
        url: "https://example.com/next",
      });

      expect(refusedDuringLoad).toBe(true);
      // Once the extension's load is over, the person's own redirect grants again.
      expect(redirect()).not.toHaveBeenCalled();
    });

    it("has no page to open into when the profile is not on screen in that window", async () => {
      const host = await setup();
      expect(
        await host.openProfileTab({ kind: "personal" }, "window-b", "https://example.com/"),
      ).toEqual({
        status: "no-page",
      });
    });

    it("navigates and selects only a page of that profile and window", async () => {
      const host = await setup();
      const [page] = host.profileTabs({ kind: "personal" }, "window-a");
      const moved = await host.updateProfileTab({ kind: "personal" }, "window-a", page?.id ?? -1, {
        url: "https://example.com/other",
      });
      expect(moved.status).toBe("tab");
      expect(
        await host.updateProfileTab({ kind: "personal" }, "window-a", page?.id ?? -1, {
          url: "https://elsewhere.test/",
        }),
      ).toEqual({ status: "origin-refused" });
      expect(
        await host.updateProfileTab(
          { kind: "project", projectId: projectId as never },
          "window-a",
          page?.id ?? -1,
          {},
        ),
      ).toEqual({
        status: "no-page",
      });
    });
  });
});

function scriptView() {
  const base = view();
  const protocol = new EventEmitter();
  const events = new EventEmitter();
  let attached = false;
  let unique = 1;
  let realm = createContext({ TextEncoder });
  let reply: ((expression: string) => Promise<unknown>) | undefined;
  const context = () => ({
    id: unique,
    uniqueId: `document-${unique}`,
    name: "octant-page-scripts",
  });
  const created: BrowserSurfaceViewPort = {
    ...base,
    webContents: {
      ...base.webContents,
      on: vi.fn((event, listener) => {
        events.on(event, listener);
      }),
      debugger: {
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        isAttached: () => attached,
        on: (event, listener) => {
          protocol.on(event, listener);
        },
        removeListener: (event, listener) => {
          protocol.removeListener(event, listener);
        },
        sendCommand: vi.fn(async (method, params) => {
          if (method === "Runtime.enable")
            protocol.emit("message", {}, "Runtime.executionContextCreated", { context: context() });
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" } } };
          if (method === "Page.createIsolatedWorld") {
            protocol.emit("message", {}, "Runtime.executionContextCreated", { context: context() });
            return { executionContextId: unique };
          }
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression);
            if (reply !== undefined && expression.startsWith("this.__octantBoundedScript("))
              return reply(expression);
            return { result: { value: runInContext(expression, realm, { timeout: 150 }) } };
          }
          return undefined;
        }),
      },
    },
  };
  return {
    created,
    events,
    protocol,
    setReply: (next: typeof reply) => {
      reply = next;
    },
    nextDocument: () => {
      unique++;
      realm = createContext({ TextEncoder });
    },
  };
}
const scriptOwner = { windowId: "10000000-0000-4000-8000-000000000001", threadId };
function scriptCommand(input: Record<string, unknown>) {
  return decodeBrowserPageScriptNativeCommand({ contextId, owner: scriptOwner, ...input });
}
async function scriptHost() {
  const fixture = scriptView();
  const host = createBrowserSurfaceHost({ createView: () => fixture.created });
  await host.createContext({
    contextId,
    owner: scriptOwner,
    policy: {
      profileMode: "isolated",
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 1,
      sessionTimeoutMs: 300000,
    },
  });
  return { ...fixture, host };
}
async function preparedScript(host: ReturnType<typeof createBrowserSurfaceHost>, source = "42") {
  const prepared = await host.runPageScript(
    scriptCommand({ operation: "prepare", source, expectedUrl: "https://example.com/" }),
    new AbortController().signal,
  );
  if (prepared.status !== "prepared") throw new Error("Expected prepared native script");
  return prepared.planId;
}

describe("native page script ownership", () => {
  it("reuses the private kernel after debugger reattachment and bounds retained unknown documents", async () => {
    const f = await scriptHost();
    try {
      const first = await preparedScript(f.host, "JSON.stringify=()=>{while(true){}};42");
      expect(
        await f.host.runPageScript(
          scriptCommand({ operation: "execute", planId: first }),
          new AbortController().signal,
        ),
      ).toMatchObject({ status: "completed", valueJson: "42" });
      const next = await preparedScript(f.host);
      expect(
        await f.host.runPageScript(
          scriptCommand({ operation: "execute", planId: next }),
          new AbortController().signal,
        ),
      ).toMatchObject({ status: "completed", valueJson: "42" });
      for (let i = 0; i < 30; i++) {
        f.nextDocument();
        const plan = await preparedScript(f.host);
        await f.host.runPageScript(
          scriptCommand({ operation: "cancel", planId: plan }),
          new AbortController().signal,
        );
      }
      f.nextDocument();
      expect(
        await f.host.runPageScript(
          scriptCommand({
            operation: "prepare",
            source: "42",
            expectedUrl: "https://example.com/",
          }),
          new AbortController().signal,
        ),
      ).toMatchObject({ status: "refused", effect: "none", reason: "unavailable" });
    } finally {
      await f.host.closeAll();
    }
  });

  it("prepares a script on a hash-routed page whose snapshot reported the redacted address", async () => {
    const f = await scriptHost();
    try {
      vi.mocked(f.created.webContents.getURL).mockReturnValue(
        "https://example.com/app?token=fixture#/dashboard",
      );
      const prepared = await f.host.runPageScript(
        scriptCommand({
          operation: "prepare",
          source: "42",
          expectedUrl: "https://example.com/app?token=redacted",
        }),
        new AbortController().signal,
      );
      expect(prepared).toMatchObject({ status: "prepared" });
      expect(
        await f.host.runPageScript(
          scriptCommand({
            operation: "prepare",
            source: "42",
            expectedUrl: "https://example.com/elsewhere",
          }),
          new AbortController().signal,
        ),
      ).toMatchObject({ status: "refused", effect: "none", reason: "stale" });
    } finally {
      await f.host.closeAll();
    }
  });

  it("does not mint a person origin grant for script navigation even if focus changes while held", async () => {
    const f = await scriptHost();
    const preventDefault = vi.fn();
    try {
      const planId = await preparedScript(f.host);
      f.setReply(async () => {
        f.events.emit("focus");
        f.events.emit("will-navigate", {
          url: "https://unapproved.example/",
          isMainFrame: true,
          preventDefault,
        });
        return { result: { value: '{"status":"completed","value":42}' } };
      });
      await f.host.runPageScript(
        scriptCommand({ operation: "execute", planId }),
        new AbortController().signal,
      );
      expect(preventDefault).toHaveBeenCalledOnce();
    } finally {
      await f.host.closeAll();
    }
  });

  it("retires a quarantined document after the view drops its WebContents wrapper", async () => {
    const f = await scriptHost();
    const contents = f.created.webContents;
    const gone = vi.fn();
    f.host.onContextGone(gone);
    const planId = await preparedScript(f.host);
    f.setReply(async () => {
      throw new Error("transport disconnected");
    });
    await f.host.runPageScript(
      scriptCommand({ operation: "execute", planId }),
      new AbortController().signal,
    );
    vi.mocked(contents.isDestroyed).mockReturnValue(true);
    Object.defineProperty(f.created, "webContents", { value: undefined });
    expect(() => f.events.emit("destroyed")).not.toThrow();
    expect(gone).toHaveBeenCalledWith(contextId);
    await f.host.closeAll();
  });

  it("keeps uncertain script custody through navigation notifications until the exact context is destroyed", async () => {
    const f = await scriptHost();
    try {
      const planId = await preparedScript(f.host);
      f.setReply(async () => {
        throw new Error("transport disconnected");
      });
      expect(
        await f.host.runPageScript(
          scriptCommand({ operation: "execute", planId }),
          new AbortController().signal,
        ),
      ).toMatchObject({ status: "execution-uncertain", effect: "possible" });
      f.events.emit("did-start-navigation");
      f.events.emit("did-navigate");
      await expect(f.host.peek(contextId)).rejects.toThrow("script holds agent observations");
      f.protocol.emit("message", {}, "Runtime.executionContextDestroyed", {
        executionContextId: 1,
        executionContextUniqueId: "other-document",
      });
      await expect(f.host.peek(contextId)).rejects.toThrow("script holds agent observations");
      f.protocol.emit("message", {}, "Runtime.executionContextDestroyed", {
        executionContextId: 1,
        executionContextUniqueId: "document-1",
      });
      await expect(f.host.peek(contextId)).resolves.toBeDefined();
    } finally {
      await f.host.closeAll();
    }
  });
});
