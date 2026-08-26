import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HostRuntimePathError,
  prepareHostRuntimePaths,
  resolveHostRuntimePaths,
} from "@octant/host-runtime";
import {
  AutomaticHostStartupDisabled,
  ServerReadyTimeout,
  assertAutomaticHostStartupEnabled,
  formatDesktopStartupFailure,
  ManagedServerCleanupFailed,
  createSingleFlight,
  managedServerNeedsStart,
  probeHostInfoReceipt,
  probeLocalHost,
  reserveLoopbackPort,
  resolveStableHostAttachment,
  resolveManagedServerUrl,
  resolvePackagedServerPath,
  serverSpawnSpec,
  shutdownManagedServer,
  waitForStorageReady,
} from "./serverProcess";

describe("automatic desktop host startup policy", () => {
  it("blocks the desktop launcher when the persisted policy is disabled", async () => {
    await expect(
      assertAutomaticHostStartupEnabled({
        read: vi.fn(async () => ({
          schemaVersion: 1 as const,
          enabled: false,
          updatedAt: "2026-08-10T10:00:00.000Z",
        })),
      }),
    ).rejects.toBeInstanceOf(AutomaticHostStartupDisabled);
  });

  it("permits the desktop launcher when the persisted policy is enabled", async () => {
    await expect(
      assertAutomaticHostStartupEnabled({
        read: vi.fn(async () => ({
          schemaVersion: 1 as const,
          enabled: true,
          updatedAt: "2026-08-10T10:00:00.000Z",
        })),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveManagedServerUrl", () => {
  it("uses the newly reserved port when restarting a dead managed server", () => {
    expect(
      resolveManagedServerUrl({
        needsServerStart: true,
        activeServerUrl: "http://127.0.0.1:13773/",
        reservedPort: 43123,
      }),
    ).toBe("http://127.0.0.1:43123/");
  });

  it("reuses the active URL while the managed server is still running", () => {
    expect(
      resolveManagedServerUrl({
        needsServerStart: false,
        activeServerUrl: "http://127.0.0.1:13773/",
        reservedPort: undefined,
      }),
    ).toBe("http://127.0.0.1:13773/");
  });

  it("fails closed when no running or reserved server URL exists", () => {
    expect(() =>
      resolveManagedServerUrl({
        needsServerStart: true,
        activeServerUrl: undefined,
        reservedPort: undefined,
      }),
    ).toThrow("Octant managed server URL is unavailable.");
  });
});

describe("probeLocalHost", () => {
  it("attaches only to a healthy Octant host and preserves activity facts", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        product: "Octant",
        status: "ok",
        storage: "ready",
        version: "0.0.0-dev",
        instanceId: "headless-instance",
        activeAgentCount: 2,
        attentionRequired: true,
      }),
    );

    await expect(probeLocalHost({ url: "http://127.0.0.1:13773/", fetch })).resolves.toEqual({
      url: "http://127.0.0.1:13773/",
      instanceId: "headless-instance",
      version: "0.0.0-dev",
      activeAgentCount: 2,
      attentionRequired: true,
    });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:13773/health", {
      signal: expect.any(AbortSignal),
    });
  });

  it("fails closed for a non-Octant health response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ product: "OtherApp", status: "ok", storage: "ready" }));

    await expect(
      probeLocalHost({ url: "http://127.0.0.1:13773/", fetch }),
    ).resolves.toBeUndefined();
  });

  it("fails closed before fetching malformed or non-loopback URLs", async () => {
    const fetch = vi.fn();

    await expect(probeLocalHost({ url: "http://10.0.0.8:13773/", fetch })).resolves.toBeUndefined();
    await expect(probeLocalHost({ url: "not-a-url", fetch })).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("probeHostInfoReceipt", () => {
  const receipt = {
    schemaVersion: 1 as const,
    hostId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
    url: "http://127.0.0.1:43124/",
    controlEndpoint: "/tmp/octant-owner.sock",
    serviceMode: "foreground" as const,
    serverVersion: "1.2.3",
    wireVersion: "1",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };

  it("accepts only a receipt whose host, wire, endpoint, and live instance agree", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        product: "Octant",
        status: "ok",
        storage: "ready",
        version: "1.2.3",
        instanceId: receipt.instanceId,
      }),
    );

    await expect(
      probeHostInfoReceipt({
        receipt,
        expectedHostId: receipt.hostId,
        expectedWireVersion: "1",
        expectedControlEndpoint: receipt.controlEndpoint,
        fetch,
      }),
    ).resolves.toMatchObject({ instanceId: receipt.instanceId, url: receipt.url });

    await expect(
      probeHostInfoReceipt({
        receipt: { ...receipt, instanceId: "33333333-3333-4333-8333-333333333333" },
        expectedHostId: receipt.hostId,
        expectedWireVersion: "1",
        expectedControlEndpoint: receipt.controlEndpoint,
        fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched receipt authority before probing the URL", async () => {
    const fetch = vi.fn();

    await expect(
      probeHostInfoReceipt({
        receipt,
        expectedHostId: "44444444-4444-4444-8444-444444444444",
        expectedWireVersion: "1",
        expectedControlEndpoint: receipt.controlEndpoint,
        fetch,
      }),
    ).resolves.toBeUndefined();
    await expect(
      probeHostInfoReceipt({
        receipt,
        expectedHostId: receipt.hostId,
        expectedWireVersion: "2",
        expectedControlEndpoint: receipt.controlEndpoint,
        fetch,
      }),
    ).resolves.toBeUndefined();
    await expect(
      probeHostInfoReceipt({
        receipt,
        expectedHostId: receipt.hostId,
        expectedWireVersion: "1",
        expectedControlEndpoint: "/tmp/other-owner.sock",
        fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("resolveStableHostAttachment", () => {
  const receipt = {
    schemaVersion: 1 as const,
    hostId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
    url: "http://127.0.0.1:43124/",
    controlEndpoint: "/tmp/octant-owner.sock",
    serviceMode: "foreground" as const,
    serverVersion: "1.2.3",
    wireVersion: "1",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };

  it("returns one stable receipt, probe, and bridge-secret generation", async () => {
    const readReceipt = vi.fn().mockResolvedValue(receipt);
    const readBridgeSecret = vi.fn().mockReturnValue("stable-secret");

    await expect(
      resolveStableHostAttachment({
        readReceipt,
        readBridgeSecret,
        probeReceipt: vi.fn().mockResolvedValue({
          url: receipt.url,
          instanceId: receipt.instanceId,
          version: receipt.serverVersion,
        }),
      }),
    ).resolves.toEqual({
      bridgeSecret: "stable-secret",
      probe: {
        url: receipt.url,
        instanceId: receipt.instanceId,
        version: receipt.serverVersion,
      },
    });
    expect(readReceipt).toHaveBeenCalledTimes(2);
    expect(readBridgeSecret).toHaveBeenCalledTimes(2);
  });

  it("rejects a receipt or bridge-secret generation change during the probe", async () => {
    const replacement = {
      ...receipt,
      instanceId: "33333333-3333-4333-8333-333333333333",
      updatedAt: "2026-08-09T10:00:01.000Z",
    };
    await expect(
      resolveStableHostAttachment({
        readReceipt: vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce(replacement),
        readBridgeSecret: vi.fn().mockReturnValue("stable-secret"),
        probeReceipt: vi.fn().mockResolvedValue({
          url: receipt.url,
          instanceId: receipt.instanceId,
        }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveStableHostAttachment({
        readReceipt: vi.fn().mockResolvedValue(receipt),
        readBridgeSecret: vi
          .fn()
          .mockReturnValueOnce("old-secret")
          .mockReturnValueOnce("new-secret"),
        probeReceipt: vi.fn().mockResolvedValue({
          url: receipt.url,
          instanceId: receipt.instanceId,
        }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("serverSpawnSpec", () => {
  it("adds trusted macOS package-manager paths for packaged servers", () => {
    expect(
      resolvePackagedServerPath(
        "/tmp/user-bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/bin",
        "darwin",
      ),
    ).toBe("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
    expect(resolvePackagedServerPath("/usr/bin:/bin", "linux")).toBe("/usr/bin:/bin");
  });

  it("uses Bun only for source development", () => {
    expect(
      serverSpawnSpec({
        browserBrokerToken: "browser-token",
        browserBrokerUrl: "http://127.0.0.1:42000/",
        codeFileHelperPath: "/repo/apps/desktop/dist/native/octant-code-file-helper",
        credentialBrokerToken: "broker-token",
        credentialBrokerUrl: "http://127.0.0.1:41000/",
        desktopBridgeSecret: "desktop-secret",
        root: "/repo",
        port: 13_773,
        instanceId: "managed-instance",
        packaged: false,
        execPath: "/Applications/Octant.app/Contents/MacOS/Octant",
        env: { PATH: "/development/bin", OCTANT_DEV_WEB_BOOTSTRAP: "1" },
      }),
    ).toEqual({
      command: "bun",
      args: ["run", "--cwd", "/repo/apps/server", "start"],
      env: {
        PATH: "/development/bin",
        OCTANT_DEV_WEB_BOOTSTRAP: "1",
        OCTANT_BROWSER_BROKER_TOKEN: "browser-token",
        OCTANT_BROWSER_BROKER_URL: "http://127.0.0.1:42000/",
        OCTANT_CODE_FILE_HELPER_PATH: "/repo/apps/desktop/dist/native/octant-code-file-helper",
        OCTANT_SERVER_INSTANCE_ID: "managed-instance",
        OCTANT_SERVER_PORT: "13773",
        OCTANT_DESKTOP_BRIDGE_SECRET: "desktop-secret",
        OCTANT_CREDENTIAL_BROKER_TOKEN: "broker-token",
        OCTANT_CREDENTIAL_BROKER_URL: "http://127.0.0.1:41000/",
        OCTANT_DESKTOP_PARENT_WATCH: "1",
        OCTANT_HOST_SERVICE_MODE: "desktop",
      },
      stdio: ["pipe", "inherit", "inherit"],
    });
  });

  it("uses the packaged Electron executable in Node mode without Bun", () => {
    expect(
      serverSpawnSpec({
        browserBrokerToken: "browser-token",
        browserBrokerUrl: "http://127.0.0.1:42000/",
        codeFileHelperPath:
          "/Applications/Octant.app/Contents/Resources/native/octant-code-file-helper",
        credentialBrokerToken: "broker-token",
        credentialBrokerUrl: "http://127.0.0.1:41000/",
        desktopBridgeSecret: "desktop-secret",
        root: "/repo",
        port: 13_773,
        instanceId: "managed-instance",
        packaged: true,
        execPath: "/Applications/Octant.app/Contents/MacOS/Octant",
        env: { PATH: "/usr/bin:/bin" },
      }),
    ).toEqual({
      command: "/Applications/Octant.app/Contents/MacOS/Octant",
      args: ["/repo/apps/server/dist/main.mjs"],
      env: {
        PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
        ELECTRON_RUN_AS_NODE: "1",
        OCTANT_BROWSER_BROKER_TOKEN: "browser-token",
        OCTANT_BROWSER_BROKER_URL: "http://127.0.0.1:42000/",
        OCTANT_CODE_FILE_HELPER_PATH:
          "/Applications/Octant.app/Contents/Resources/native/octant-code-file-helper",
        OCTANT_SERVER_INSTANCE_ID: "managed-instance",
        OCTANT_SERVER_PORT: "13773",
        OCTANT_DESKTOP_BRIDGE_SECRET: "desktop-secret",
        OCTANT_CREDENTIAL_BROKER_TOKEN: "broker-token",
        OCTANT_CREDENTIAL_BROKER_URL: "http://127.0.0.1:41000/",
        OCTANT_DESKTOP_PARENT_WATCH: "1",
        OCTANT_HOST_SERVICE_MODE: "desktop",
        OCTANT_PACKAGED_RUNTIME: "1",
      },
      stdio: ["pipe", "inherit", "inherit"],
    });
  });

  it("strips development bootstrap controls from the packaged server environment", () => {
    const spec = serverSpawnSpec({
      browserBrokerToken: "browser-token",
      browserBrokerUrl: "http://127.0.0.1:42000/",
      codeFileHelperPath:
        "/Applications/Octant.app/Contents/Resources/native/octant-code-file-helper",
      credentialBrokerToken: "broker-token",
      credentialBrokerUrl: "http://127.0.0.1:41000/",
      desktopBridgeSecret: "desktop-secret",
      root: "/repo",
      port: 13_773,
      instanceId: "managed-instance",
      packaged: true,
      execPath: "/Applications/Octant.app/Contents/MacOS/Octant",
      env: {
        PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
        OCTANT_DEV_WEB_BOOTSTRAP: "1",
      },
    });

    const env = spec.env as NodeJS.ProcessEnv;
    expect(env.OCTANT_DEV_WEB_BOOTSTRAP).toBeUndefined();
    expect(env.OCTANT_PACKAGED_RUNTIME).toBe("1");
  });

  it("keeps the bootstrap secret only in the child environment", () => {
    const parentEnv: NodeJS.ProcessEnv = {};
    const spec = serverSpawnSpec({
      browserBrokerToken: "browser-token",
      browserBrokerUrl: "http://127.0.0.1:42000/",
      codeFileHelperPath: "/repo/apps/desktop/dist/native/octant-code-file-helper",
      credentialBrokerToken: "process-private-broker-token",
      credentialBrokerUrl: "http://127.0.0.1:41000/",
      desktopBridgeSecret: "process-private-secret",
      root: "/repo",
      port: 13_773,
      instanceId: "managed-instance",
      packaged: false,
      execPath: "/Applications/Octant.app/Contents/MacOS/Octant",
      env: parentEnv,
    });

    expect(spec.env.OCTANT_DESKTOP_BRIDGE_SECRET).toBe("process-private-secret");
    expect(spec.env.OCTANT_CREDENTIAL_BROKER_TOKEN).toBe("process-private-broker-token");
    expect(spec.env.OCTANT_CODE_FILE_HELPER_PATH).toBe(
      "/repo/apps/desktop/dist/native/octant-code-file-helper",
    );
    expect(JSON.stringify(spec.args)).not.toContain("process-private-secret");
    expect(JSON.stringify(spec.args)).not.toContain("process-private-broker-token");
    expect(JSON.stringify(spec.args)).not.toContain("octant-code-file-helper");
    expect(parentEnv.OCTANT_CODE_FILE_HELPER_PATH).toBeUndefined();
    expect(parentEnv.OCTANT_CREDENTIAL_BROKER_TOKEN).toBeUndefined();
  });
});

describe("reserveLoopbackPort", () => {
  it("reserves an unused loopback port and releases it", async () => {
    const reservation = await reserveLoopbackPort();
    expect(reservation.port).toBeGreaterThan(0);
    expect(reservation.port).toBeLessThanOrEqual(65_535);
    await expect(reservation.close()).resolves.toBeUndefined();
  });
});

describe("waitForStorageReady", () => {
  it("returns a separately managed winner when the desktop child loses the owner race", async () => {
    const attached = {
      url: "http://127.0.0.1:43124/",
      instanceId: "foreground-winner",
      version: "1.2.3",
    };
    const resolveAttachedHost = vi
      .fn<() => Promise<typeof attached | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(attached);
    let now = 0;

    await expect(
      waitForStorageReady({
        serverUrl: "http://127.0.0.1:43123/",
        instanceId: "desktop-loser",
        fetch: vi.fn().mockRejectedValue(new Error("desktop child exited after attaching")),
        resolveAttachedHost,
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).resolves.toEqual(attached);
    expect(resolveAttachedHost).toHaveBeenCalledTimes(2);
  });

  it("keeps the total wait within the overall deadline when polling is slower", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    await expect(
      waitForStorageReady({
        serverUrl: "http://127.0.0.1:13773",
        instanceId: "managed-instance",
        fetch: vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
        timeoutMs: 20,
        pollIntervalMs: 100,
        now: () => now,
        sleep,
      }),
    ).rejects.toBeInstanceOf(ServerReadyTimeout);

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(20);
    expect(now).toBe(20);
  });

  it("keeps the one-argument ServerReadyTimeout constructor compatible", () => {
    expect(new ServerReadyTimeout(20)).toMatchObject({
      attemptCount: 0,
      lastProbeOutcome: "not-attempted",
    });
  });

  it("retries after a stalled probe reaches the 500ms probe budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("missing abort signal");
      signals.push(signal);
      if (signals.length === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Response.json({
        product: "Octant",
        status: "ok",
        storage: "ready",
        instanceId: "managed-instance",
      });
    });
    try {
      await expect(
        waitForStorageReady({
          serverUrl: "http://127.0.0.1:13773",
          instanceId: "managed-instance",
          fetch,
          timeoutMs: 2_000,
          pollIntervalMs: 0,
        }),
      ).resolves.toBeUndefined();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(timeoutSpy).toHaveBeenNthCalledWith(1, 500);
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("caps a final probe to less than the 500ms probe budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    let now = 0;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          product: "Octant",
          status: "ok",
          storage: "ready",
          instanceId: "managed-instance",
        }),
      );

    try {
      await expect(
        waitForStorageReady({
          serverUrl: "http://127.0.0.1:13773",
          instanceId: "managed-instance",
          fetch,
          timeoutMs: 600,
          pollIntervalMs: 200,
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
        }),
      ).resolves.toBeUndefined();

      expect(timeoutSpy).toHaveBeenNthCalledWith(1, 500);
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 400);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("waits through unavailable responses until health reports storage ready", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("not listening"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", storage: "starting" })))
      .mockResolvedValueOnce(
        Response.json({
          product: "Octant",
          status: "ok",
          storage: "ready",
          version: "test",
          instanceId: "managed-instance",
        }),
      );

    await expect(
      waitForStorageReady({
        serverUrl: "http://127.0.0.1:13773",
        instanceId: "managed-instance",
        fetch,
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: (() => {
          let now = 0;
          return () => (now += 10);
        })(),
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:13773/health", {
      signal: expect.any(AbortSignal),
    });
  });

  it("fails with a bounded actionable timeout", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));

    await expect(
      waitForStorageReady({
        serverUrl: "http://127.0.0.1:13773",
        instanceId: "managed-instance",
        fetch,
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: (() => {
          let now = 0;
          return () => (now += 10);
        })(),
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ServerReadyTimeout);
  });

  it.each([
    [
      "request failure",
      vi.fn().mockRejectedValue(new Error("private request path")),
      "request-failed",
    ],
    [
      "request abort",
      vi.fn().mockRejectedValue(new DOMException("private abort reason", "AbortError")),
      "request-failed",
    ],
    [
      "HTTP error",
      vi.fn().mockResolvedValue(new Response("private response body", { status: 404 })),
      "http-not-ok",
    ],
    [
      "invalid JSON",
      vi.fn().mockResolvedValue(new Response("private invalid JSON")),
      "invalid-json",
    ],
    [
      "null health payload",
      vi.fn().mockResolvedValue(Response.json(null)),
      "invalid-health-payload",
    ],
    [
      "array health payload",
      vi.fn().mockResolvedValue(Response.json(["private array value"])),
      "invalid-health-payload",
    ],
    [
      "primitive health payload",
      vi.fn().mockResolvedValue(Response.json("private primitive value")),
      "invalid-health-payload",
    ],
    [
      "storage not ready",
      vi.fn().mockResolvedValue(
        Response.json({
          product: "Octant",
          status: "ok",
          storage: "private-starting-state",
          instanceId: "managed-instance",
        }),
      ),
      "storage-not-ready",
    ],
    [
      "instance mismatch",
      vi.fn().mockResolvedValue(
        Response.json({
          product: "Octant",
          status: "ok",
          storage: "ready",
          instanceId: "private-unrelated-instance",
        }),
      ),
      "instance-mismatch",
    ],
  ])("reports a sanitized final outcome for %s", async (_name, fetch, lastProbeOutcome) => {
    let now = 0;
    let thrown: unknown;
    try {
      await waitForStorageReady({
        serverUrl: "http://127.0.0.1:13773",
        instanceId: "managed-instance",
        fetch,
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: () => now,
        sleep: async () => {
          now = 20;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "ServerReadyTimeout",
      category: "server-unavailable",
      attemptCount: 1,
      lastProbeOutcome,
    });
    const exposed = `${String(thrown)} ${JSON.stringify(thrown)}`;
    expect(exposed).not.toMatch(/private|response body|request path|abort reason/i);
  });

  it("does not accept readiness from an unrelated Octant server", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          product: "Octant",
          status: "ok",
          storage: "ready",
          version: "test",
          instanceId: "unrelated-instance",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          product: "Octant",
          status: "ok",
          storage: "ready",
          version: "test",
          instanceId: "managed-instance",
        }),
      );

    await expect(
      waitForStorageReady({
        serverUrl: "http://127.0.0.1:13773",
        instanceId: "managed-instance",
        fetch,
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: (() => {
          let now = 0;
          return () => (now += 10);
        })(),
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("desktop startup failure copy", () => {
  it("reports an unsafe data-directory mode instead of a storage-ready timeout", async () => {
    const temporaryRoot = await mkdtemp(join(await realpath(tmpdir()), "octant-unsafe-mode-"));
    const directory = join(temporaryRoot, "data");
    try {
      const paths = resolveHostRuntimePaths({
        env: { OCTANT_DATA_DIR: directory },
        platform: process.platform === "darwin" ? "darwin" : "linux",
        home: join(temporaryRoot, "home"),
        temporaryDirectory: temporaryRoot,
        uid: process.getuid?.() ?? 0,
      });
      await prepareHostRuntimePaths(paths);
      await chmod(paths.dataDirectory, 0o755);

      let thrown: unknown;
      try {
        await prepareHostRuntimePaths(paths);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(HostRuntimePathError);
      expect(thrown).toMatchObject({
        code: "unsafe-mode",
        path: paths.dataDirectory,
      });

      const message = formatDesktopStartupFailure(thrown);
      expect(message).toContain("unsafe-mode");
      expect(message).toContain(paths.dataDirectory);
      expect(message).toContain("0700");
      expect(message).toMatch(/group or other/i);
      expect(message).not.toMatch(/did not become ready|15000ms|request-failed/i);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps an unrelated startup error as its original message", () => {
    expect(formatDesktopStartupFailure(new ServerReadyTimeout(15_000, "request-failed", 147))).toBe(
      "Octant storage did not become ready within 15000ms (last probe: request-failed; attempts: 147).",
    );
  });
});

describe("shutdownManagedServer", () => {
  it("requests graceful termination and does not force-kill an exited child", async () => {
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    };

    await shutdownManagedServer(child, {
      gracePeriodMs: 100,
      waitForExit: async () => true,
    });

    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("escalates from SIGTERM to SIGKILL after the termination window", async () => {
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    };

    const waitForExit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await shutdownManagedServer(child, {
      gracePeriodMs: 100,
      forceKillWaitMs: 25,
      waitForExit,
    });

    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(waitForExit.mock.calls).toEqual([
      [child, 100],
      [child, 25],
    ]);
  });

  it.each([
    ["SIGTERM", vi.fn().mockReturnValue(false), vi.fn()],
    [
      "SIGKILL",
      vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      vi.fn().mockResolvedValue(false),
    ],
  ])("reports typed cleanup failure when %s delivery fails", async (_signal, kill, waitForExit) => {
    const child = { exitCode: null, signalCode: null, kill };

    await expect(
      shutdownManagedServer(child, { gracePeriodMs: 10, forceKillWaitMs: 5, waitForExit }),
    ).rejects.toBeInstanceOf(ManagedServerCleanupFailed);
  });

  it("reports typed cleanup failure when forced exit is not observed", async () => {
    const child = { exitCode: null, signalCode: null, kill: vi.fn().mockReturnValue(true) };

    await expect(
      shutdownManagedServer(child, {
        gracePeriodMs: 10,
        forceKillWaitMs: 5,
        waitForExit: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toMatchObject({ name: "ManagedServerCleanupFailed", stage: "exit-timeout" });
  });

  it("does nothing when the child already exited", async () => {
    const child = { exitCode: 0, signalCode: null, kill: vi.fn() };

    await shutdownManagedServer(child, { gracePeriodMs: 100, waitForExit: vi.fn() });

    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("managedServerNeedsStart", () => {
  it("reuses a live managed server and restarts only an absent or exited child", () => {
    expect(managedServerNeedsStart(undefined)).toBe(true);
    expect(managedServerNeedsStart({ exitCode: null, signalCode: null, kill: vi.fn() })).toBe(
      false,
    );
    expect(managedServerNeedsStart({ exitCode: 0, signalCode: null, kill: vi.fn() })).toBe(true);
    expect(managedServerNeedsStart({ exitCode: null, signalCode: "SIGTERM", kill: vi.fn() })).toBe(
      true,
    );
  });
});

describe("createSingleFlight", () => {
  it("shares one deferred operation across concurrent callers and permits a later retry", async () => {
    let release: (() => void) | undefined;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await deferred;
      return "created";
    });
    const run = createSingleFlight(operation);

    const first = run();
    const second = run();
    expect(operation).toHaveBeenCalledOnce();
    expect(second).toBe(first);

    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual(["created", "created"]);
    await run();
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
