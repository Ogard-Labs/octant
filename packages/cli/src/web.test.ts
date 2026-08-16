import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveWebRoot,
  runWebCommand,
  type WebCommandOptions,
  type WebCommandOutput,
} from "./web";
import type { HostLauncherDependencies } from "./hostLauncher";

it("resolves the Vite root as a filesystem path", () => {
  expect(resolveWebRoot()).not.toMatch(/^file:/);
  expect(resolveWebRoot()).toMatch(/\/apps\/web$/);
});

const bridgeSecret = `${"S".repeat(42)}A`;
const windowId = randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
const capability = `${"C".repeat(42)}A`;
const launchToken = `${"A".repeat(42)}A`;

function baseOptions(overrides: Partial<WebCommandOptions> = {}): WebCommandOptions {
  return {
    bridgeSecret,
    hostname: "127.0.0.1",
    port: 13773,
    noOpen: false,
    dev: false,
    attachOrCreateHost: vi.fn(async () => ({
      kind: "attached" as const,
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
      developmentWebBootstrap: true,
    })),
    createLaunchSession: vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    })),
    openBrowser: vi.fn(),
    startDevServer: vi.fn(async () => "http://127.0.0.1:5173"),
    generateWindowId: () => windowId,
    generateCapability: () => capability,
    stdout: { write: vi.fn((chunk: string) => chunk.length > 0) },
    stderr: { write: vi.fn((chunk: string) => chunk.length > 0) },
    ...overrides,
  } as unknown as WebCommandOptions;
}

describe("runWebCommand", () => {
  it("passes the persisted service policy to the automatic host launcher", async () => {
    const policyStore = {
      read: vi.fn(async () => ({
        schemaVersion: 1 as const,
        enabled: false,
        updatedAt: "2026-08-10T10:00:00.000Z",
      })),
    };
    const attachOrCreateHost = vi.fn(async (options: HostLauncherDependencies) => {
      expect(
        (options as HostLauncherDependencies & { readonly policyStore: typeof policyStore })
          .policyStore,
      ).toBe(policyStore);
      return { kind: "disabled" as const, reason: "automatic startup disabled" };
    });

    const result = await runWebCommand(
      baseOptions({
        attachOrCreateHost,
        servicePolicyStore: policyStore,
      } as unknown as Partial<WebCommandOptions>),
    );

    expect(result).toEqual({ kind: "disabled", reason: "automatic startup disabled" });
  });

  it("resolves the Vite renderer from the repository file URL", () => {
    expect(resolveWebRoot()).toMatch(/\/apps\/web$/);
    expect(resolveWebRoot()).not.toMatch(/^file:/);
  });

  it("attaches to a host, mints a launch token, and opens the browser at the fragment URL", async () => {
    const openBrowser = vi.fn();
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(baseOptions({ openBrowser, stdout }));
    expect(result.kind).toBe("opened");
    expect(openBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ hash: `#launchToken=${launchToken}` }),
    );
    expect(stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("http://127.0.0.1:13773/?serverUrl="),
    );
  });

  it("prints the URL without opening the browser when --no-open is set", async () => {
    const openBrowser = vi.fn();
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(baseOptions({ noOpen: true, openBrowser, stdout }));
    expect(result.kind).toBe("served");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("http://127.0.0.1:13773/?serverUrl="),
    );
  });

  it("starts the Vite dev server and prints its URL when --dev is set", async () => {
    const startDevServer = vi.fn(async () => "http://127.0.0.1:5173");
    const openBrowser = vi.fn();
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(
      baseOptions({ dev: true, startDevServer, openBrowser, stdout }),
    );
    expect(result.kind).toBe("dev");
    expect(startDevServer).toHaveBeenCalled();
    expect(openBrowser).toHaveBeenCalledWith(expect.any(URL));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Vite renderer"));
  });

  it("fails closed when the host is disabled", async () => {
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "disabled" as const,
      reason: "storage not ready",
    }));
    const result = await runWebCommand(baseOptions({ attachOrCreateHost }));
    expect(result.kind).toBe("disabled");
    expect((result as WebCommandOutput & { reason: string }).reason).toContain("storage not ready");
  });

  it("fails closed when the host cannot start", async () => {
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "start-failed" as const,
      reason: "port in use",
    }));
    const result = await runWebCommand(baseOptions({ attachOrCreateHost }));
    expect(result.kind).toBe("start-failed");
  });

  it("fails closed when the launch session cannot be minted", async () => {
    const createLaunchSession = vi.fn(async () => undefined);
    const result = await runWebCommand(baseOptions({ createLaunchSession }));
    expect(result.kind).toBe("auth-failed");
  });

  it("fails closed when the launch session transport rejects", async () => {
    const createLaunchSession = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await runWebCommand(baseOptions({ createLaunchSession }));
    expect(result.kind).toBe("auth-failed");
    expect((result as WebCommandOutput & { reason: string }).reason).toContain(
      "could not reach its launch session service",
    );
  });

  it("reads the bridge secret from the data-dir file when no env secret is provided", async () => {
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "attached" as const,
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
    }));
    const createLaunchSession = vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    }));
    const directory = await mkdtemp(join(tmpdir(), "octant-web-secret-"));
    try {
      await writeFile(join(directory, "octant-bridge-secret"), bridgeSecret);
      const result = await runWebCommand(
        baseOptions({
          bridgeSecret: undefined,
          attachOrCreateHost,
          createLaunchSession,
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );
      expect(result.kind).toBe("opened");
      expect(createLaunchSession).toHaveBeenCalledWith(expect.objectContaining({ bridgeSecret }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads the host URL from the data-dir host info file when no port is provided", async () => {
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "attached" as const,
      url: new URL("http://127.0.0.1:9999"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
    }));
    const createLaunchSession = vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    }));
    const directory = await mkdtemp(join(tmpdir(), "octant-web-host-"));
    try {
      await writeFile(
        join(directory, "octant-host.json"),
        JSON.stringify({ url: "http://127.0.0.1:9999", instanceId: "inst-1" }),
      );
      const result = await runWebCommand(
        baseOptions({
          port: undefined,
          hostname: undefined,
          attachOrCreateHost,
          createLaunchSession,
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );
      expect(result.kind).toBe("opened");
      expect(attachOrCreateHost).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: "127.0.0.1",
          port: 9999,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("generates a fresh bridge secret when none is available for a fresh host start", async () => {
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "started" as const,
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
    }));
    const createLaunchSession = vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    }));
    const generatedSecret = `${"G".repeat(42)}A`;
    const result = await runWebCommand(
      baseOptions({
        bridgeSecret: undefined,
        attachOrCreateHost,
        createLaunchSession,
        generateBridgeSecret: () => generatedSecret,
        bridgeSecretInput: {
          env: {},
          platform: "darwin",
          home: "/nonexistent-home",
        },
      }),
    );
    expect(result.kind).toBe("opened");
    expect(attachOrCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeSecret: generatedSecret }),
    );
  });

  it("reloads the winning persisted bridge secret after a competing fresh start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-web-winning-secret-"));
    const losingSecret = `${"L".repeat(42)}A`;
    const winningSecret = `${"W".repeat(42)}A`;
    const createLaunchSession = vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    }));
    try {
      const result = await runWebCommand(
        baseOptions({
          bridgeSecret: undefined,
          attachOrCreateHost: vi.fn(async () => {
            await writeFile(
              join(directory, "octant-host.json"),
              JSON.stringify({
                url: "http://127.0.0.1:13773",
                instanceId: "winning-instance",
              }),
              { mode: 0o600 },
            );
            await writeFile(join(directory, "octant-bridge-secret"), winningSecret, {
              mode: 0o600,
            });
            return {
              kind: "started" as const,
              url: new URL("http://127.0.0.1:13773"),
              instanceId: "winning-instance",
              version: "0.0.0-dev",
            };
          }),
          createLaunchSession,
          generateBridgeSecret: () => losingSecret,
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );

      expect(result.kind).toBe("opened");
      expect(createLaunchSession).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeSecret: winningSecret }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an explicitly supplied bridge secret over a stale persisted secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-web-explicit-secret-"));
    const explicitSecret = `${"E".repeat(42)}A`;
    const staleSecret = `${"X".repeat(42)}A`;
    const createLaunchSession = vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    }));
    try {
      await writeFile(join(directory, "octant-bridge-secret"), staleSecret, { mode: 0o600 });
      const result = await runWebCommand(
        baseOptions({
          bridgeSecret: explicitSecret,
          createLaunchSession,
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );

      expect(result.kind).toBe("opened");
      expect(createLaunchSession).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeSecret: explicitSecret }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reloads a competing winner's persisted URL and authority while waiting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-web-winning-endpoint-"));
    const winningSecret = `${"W".repeat(42)}A`;
    const createLaunchSession = vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    }));
    const attachOrCreateHost = vi.fn(async (options: HostLauncherDependencies) => {
      await writeFile(
        join(directory, "octant-host.json"),
        JSON.stringify({ url: "http://127.0.0.1:4000", instanceId: "foreground-winner" }),
        { mode: 0o600 },
      );
      await writeFile(join(directory, "octant-bridge-secret"), winningSecret, { mode: 0o600 });
      expect(await options.resolveAttachedHost?.()).toEqual({
        url: new URL("http://127.0.0.1:4000/"),
        instanceId: "foreground-winner",
      });
      return {
        kind: "started" as const,
        url: new URL("http://127.0.0.1:4000/"),
        instanceId: "foreground-winner",
        version: "0.0.0-dev",
      };
    });
    try {
      const result = await runWebCommand(
        baseOptions({
          bridgeSecret: undefined,
          attachOrCreateHost,
          createLaunchSession,
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );

      expect(result.kind).toBe("opened");
      expect(createLaunchSession).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeSecret: winningSecret,
          serverUrl: new URL("http://127.0.0.1:4000/"),
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens a token-free bootstrap URL when --dev is set", async () => {
    const startDevServer = vi.fn(async () => "http://127.0.0.1:5173");
    const openBrowser = vi.fn();
    const createLaunchSession = vi.fn(async () => ({
      launchToken,
      expiresAt: Date.now() + 60_000,
    }));
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(
      baseOptions({ dev: true, startDevServer, openBrowser, stdout, createLaunchSession }),
    );
    expect(result.kind).toBe("dev");
    const openedUrl = openBrowser.mock.calls[0]![0] as URL;
    expect(openedUrl.searchParams.get("serverUrl")).toBe("http://127.0.0.1:13773/");
    expect(openedUrl.searchParams.get("developmentWebBootstrap")).toBe("1");
    expect(openedUrl.hash).toBe("");
    expect(createLaunchSession).not.toHaveBeenCalled();
  });

  it("fails with a restart instruction when an attached host lacks dev bootstrap", async () => {
    const result = await runWebCommand(
      baseOptions({
        dev: true,
        attachOrCreateHost: vi.fn(async () => ({
          kind: "attached" as const,
          url: new URL("http://127.0.0.1:13773"),
          developmentWebBootstrap: false,
        })),
      }),
    );

    expect(result).toMatchObject({ kind: "auth-failed" });
    expect((result as { reason: string }).reason).toContain("restart");
  });

  it("prints the URL manually when the browser opener throws", async () => {
    const openBrowser = vi.fn(() => {
      throw new Error("no xdg-open");
    });
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(baseOptions({ openBrowser, stdout }));
    expect(result.kind).toBe("opened");
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Open this URL manually"));
  });
});
