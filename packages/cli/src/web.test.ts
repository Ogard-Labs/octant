import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveWebRoot,
  runWebCommand,
  type WebCommandOptions,
  type WebCommandOutput,
} from "./web";
import type { HostLauncherDependencies } from "./hostLauncher";
import { resolveHostInfoFilePath, type BridgeSecretFileInput } from "./bridgeSecretFile";

it("resolves the Vite root as a filesystem path", () => {
  expect(resolveWebRoot()).not.toMatch(/^file:/);
  expect(resolveWebRoot()).toMatch(/\/apps\/web$/);
});

const bridgeSecret = `${"S".repeat(42)}A`;
const launchToken = `${"T".repeat(42)}A`;

/** The owner-only receipt a host writes when it starts; the CLI sends its secret only there. */
async function writeOwnerReceipt(directory: string, url: string, instanceId = "instance-1") {
  await writeFile(join(directory, "octant-host.json"), JSON.stringify({ url, instanceId }), {
    mode: 0o600,
  });
}

// The default input names no OCTANT_DATA_DIR, so development mode keeps the
// canonical Machine store; the receipt sits where that store's runtime reads it.
let ownerDirectory = "";
let ownerInput: BridgeSecretFileInput = { env: {}, platform: "linux", home: "/home/user" };
beforeAll(async () => {
  ownerDirectory = await mkdtemp(join(tmpdir(), "octant-web-owner-"));
  ownerInput = { env: { XDG_DATA_HOME: ownerDirectory }, platform: "linux", home: "/home/user" };
  const receiptPath = resolveHostInfoFilePath(ownerInput);
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  await writeOwnerReceipt(dirname(receiptPath), "http://127.0.0.1:13773");
});
afterAll(async () => {
  await rm(ownerDirectory, { recursive: true, force: true });
});

/** A host that admits the renderer and mints a launch token for the bridge secret. */
function hostFetch(hostBridgeSecret = bridgeSecret) {
  return vi.fn(async (input: URL, init: RequestInit) => {
    if (input.pathname === "/api/desktop/launch-sessions") {
      const headers = init.headers as Record<string, string>;
      if (headers["x-octant-desktop-secret"] !== hostBridgeSecret) {
        return new Response("{}", { status: 401 });
      }
      return Response.json({ launchToken, expiresAt: 1 }, { status: 201 });
    }
    return new Response(null, { status: 204 });
  });
}

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
    })),
    openBrowser: vi.fn(),
    fetch: hostFetch(),
    startDevServer: vi.fn(async () => "http://127.0.0.1:5173"),
    stdout: { write: vi.fn((chunk: string) => chunk.length > 0) },
    stderr: { write: vi.fn((chunk: string) => chunk.length > 0) },
    bridgeSecretInput: ownerInput,
    ...overrides,
  } as unknown as WebCommandOptions;
}

describe("runWebCommand", () => {
  it("injects the persisted service policy store when the caller does not supply one", async () => {
    const attachOrCreateHost = vi.fn(async (options: HostLauncherDependencies) => {
      expect(options.policyStore).toBeDefined();
      expect(typeof options.policyStore?.read).toBe("function");
      return { kind: "disabled" as const, reason: "automatic startup disabled" };
    });

    const result = await runWebCommand(baseOptions({ attachOrCreateHost }));

    expect(result).toEqual({ kind: "disabled", reason: "automatic startup disabled" });
    expect(attachOrCreateHost).toHaveBeenCalledOnce();
  });

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

  it("opens the canonical host with a one-time launch token bound to its origin", async () => {
    const fetch = hostFetch();
    const openBrowser = vi.fn();
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(baseOptions({ fetch, openBrowser, stdout }));
    expect(result.kind).toBe("opened");
    const opened = openBrowser.mock.calls[0]?.[0] as URL;
    expect(opened.origin).toBe("http://127.0.0.1:13773");
    expect(opened.hash).toBe(`#launchToken=${launchToken}`);
    const minted = fetch.mock.calls.find(
      ([url]) => url.pathname === "/api/desktop/launch-sessions",
    );
    expect(JSON.parse(String(minted?.[1].body))).toMatchObject({
      origin: "http://127.0.0.1:13773",
    });
    // The token is consumed by the browser; the terminal shows the plain address.
    expect(stdout.write).toHaveBeenCalledWith(
      "Octant web client opened at http://127.0.0.1:13773/\n",
    );
    expect(stdout.write).not.toHaveBeenCalledWith(expect.stringContaining(launchToken));
  });

  it("prints the one-time launch URL without opening the browser when --no-open is set", async () => {
    const openBrowser = vi.fn();
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(baseOptions({ noOpen: true, openBrowser, stdout }));
    expect(result.kind).toBe("served");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalledWith(
      `Octant web client ready at http://127.0.0.1:13773/?serverUrl=http%3A%2F%2F127.0.0.1%3A13773%2F#launchToken=${launchToken}\n`,
    );
  });

  it.each([
    ["answers on a port the receipt does not name", "http://127.0.0.1:13999", "instance-1"],
    ["claims a different instance than the receipt", "http://127.0.0.1:13773", "impostor"],
  ])("never sends the bridge secret to a host that %s", async (_, hostUrl, instanceId) => {
    const fetch = hostFetch();
    const openBrowser = vi.fn();
    const stderr = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(
      baseOptions({
        fetch,
        openBrowser,
        stderr,
        attachOrCreateHost: vi.fn(async () => ({
          kind: "attached" as const,
          url: new URL(hostUrl),
          instanceId,
        })),
      }),
    );
    expect(result.kind).toBe("auth-failed");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => url.pathname === "/api/desktop/launch-sessions")).toBe(
      false,
    );
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("host receipt"));
  });

  it("opens no browser when the host refuses to mint a launch token for this bridge secret", async () => {
    const openBrowser = vi.fn();
    const stderr = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(
      baseOptions({ bridgeSecret: `${"W".repeat(42)}A`, openBrowser, stderr }),
    );
    expect(result.kind).toBe("auth-failed");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("OS user"));
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
    expect(stdout.write).toHaveBeenCalledWith(
      "Octant development renderer uses the canonical Machine store.\n",
    );
  });

  it("uses the canonical Machine store when only the renderer is in development mode", async () => {
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "attached" as const,
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
    }));
    await runWebCommand(
      baseOptions({
        attachOrCreateHost,
        dev: true,
        resolveDevelopmentCodeFileHelperPath: () => "/repo/dist/octant-code-file-helper",
        servicePolicyStore: {
          read: vi.fn(async () => ({
            schemaVersion: 1 as const,
            enabled: true,
            updatedAt: "2026-09-01T12:00:00.000Z",
          })),
        },
      }),
    );

    expect(attachOrCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: {
          OCTANT_WEB_URL: "http://127.0.0.1:5173",
          OCTANT_CODE_FILE_HELPER_PATH: "/repo/dist/octant-code-file-helper",
        },
      }),
    );
  });

  it("keeps an explicit process data directory visible in development mode", async () => {
    const previous = process.env.OCTANT_DATA_DIR;
    const directory = "/tmp/octant-explicit-development-data";
    process.env.OCTANT_DATA_DIR = directory;
    try {
      const attachOrCreateHost = vi.fn(async () => ({
        kind: "attached" as const,
        url: new URL("http://127.0.0.1:13773"),
        instanceId: "instance-1",
        version: "0.0.0-dev",
      }));
      const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };

      await runWebCommand(
        baseOptions({
          attachOrCreateHost,
          dev: true,
          stdout,
        }),
      );

      expect(attachOrCreateHost).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.objectContaining({ OCTANT_DATA_DIR: directory }),
        }),
      );
      expect(stdout.write).toHaveBeenCalledWith(
        `Octant isolated development history persists in ${directory}.\n`,
      );
    } finally {
      if (previous === undefined) delete process.env.OCTANT_DATA_DIR;
      else process.env.OCTANT_DATA_DIR = previous;
    }
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

  it("reads the bridge secret from the data-dir file when no env secret is provided", async () => {
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "attached" as const,
      url: new URL("http://127.0.0.1:13773"),
      instanceId: "instance-1",
      version: "0.0.0-dev",
    }));
    const directory = await mkdtemp(join(tmpdir(), "octant-web-secret-"));
    try {
      await writeFile(join(directory, "octant-bridge-secret"), bridgeSecret);
      await writeOwnerReceipt(directory, "http://127.0.0.1:13773");
      const result = await runWebCommand(
        baseOptions({
          bridgeSecret: undefined,
          attachOrCreateHost,
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );
      expect(result.kind).toBe("opened");
      expect(attachOrCreateHost).toHaveBeenCalledWith(expect.objectContaining({ bridgeSecret }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the stable endpoint instead of restarting on a stale receipt port", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-web-host-"));
    const attachOrCreateHost = vi.fn(async () => {
      // The host this command starts rewrites the stale receipt.
      await writeOwnerReceipt(directory, "http://127.0.0.1:13773");
      return {
        kind: "started" as const,
        url: new URL("http://127.0.0.1:13773"),
        instanceId: "instance-1",
        version: "0.0.0-dev",
      };
    });
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
          hostname: undefined,
          port: undefined,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let a persisted receipt override an explicit endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-web-explicit-port-"));
    const attachOrCreateHost = vi.fn(async (options: HostLauncherDependencies) => {
      expect(options.resolveAttachedHost).toBeUndefined();
      await writeOwnerReceipt(directory, "http://127.0.0.1:14000");
      return {
        kind: "started" as const,
        url: new URL("http://127.0.0.1:14000"),
      };
    });
    try {
      await writeFile(
        join(directory, "octant-host.json"),
        JSON.stringify({ url: "http://127.0.0.1:13773", instanceId: "canonical-host" }),
      );

      const result = await runWebCommand(
        baseOptions({
          port: 14_000,
          attachOrCreateHost,
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );

      expect(result.kind).toBe("opened");
      expect(result.kind === "opened" ? result.url.origin : undefined).toBe(
        "http://127.0.0.1:14000",
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
    const generatedSecret = `${"G".repeat(42)}A`;
    const result = await runWebCommand(
      baseOptions({
        bridgeSecret: undefined,
        attachOrCreateHost,
        fetch: hostFetch(generatedSecret),
        generateBridgeSecret: () => generatedSecret,
        bridgeSecretInput: ownerInput,
      }),
    );
    expect(result.kind).toBe("opened");
    expect(attachOrCreateHost).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeSecret: generatedSecret }),
    );
  });

  it("preserves an explicitly supplied bridge secret over a stale persisted secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-web-explicit-secret-"));
    const explicitSecret = `${"E".repeat(42)}A`;
    const staleSecret = `${"X".repeat(42)}A`;
    const attachOrCreateHost = vi.fn(async () => ({
      kind: "attached" as const,
      url: new URL("http://127.0.0.1:13773"),
    }));
    try {
      await writeFile(join(directory, "octant-bridge-secret"), staleSecret, { mode: 0o600 });
      await writeOwnerReceipt(directory, "http://127.0.0.1:13773");
      const result = await runWebCommand(
        baseOptions({
          bridgeSecret: explicitSecret,
          attachOrCreateHost,
          fetch: hostFetch(explicitSecret),
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );

      expect(result.kind).toBe("opened");
      expect(attachOrCreateHost).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeSecret: explicitSecret }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reloads a competing winner's persisted URL and authority while waiting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-web-winning-endpoint-"));
    const winningSecret = `${"W".repeat(42)}A`;
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
          hostname: undefined,
          port: undefined,
          attachOrCreateHost,
          fetch: hostFetch(winningSecret),
          bridgeSecretInput: {
            env: { OCTANT_DATA_DIR: directory },
            platform: "linux",
            home: "/home/user",
          },
        }),
      );

      // The launch token is minted with the winner's secret, read back from
      // the owner-only runtime directory after the race settled.
      expect(result.kind).toBe("opened");
      expect(result.kind === "opened" ? result.url.origin : undefined).toBe(
        "http://127.0.0.1:4000",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens the Vite renderer with a launch token bound to the renderer origin when --dev is set", async () => {
    const fetch = hostFetch();
    const startDevServer = vi.fn(async () => "http://127.0.0.1:5173");
    const openBrowser = vi.fn();
    const stdout = { write: vi.fn((chunk: string) => chunk.length > 0) };
    const result = await runWebCommand(
      baseOptions({ dev: true, fetch, startDevServer, openBrowser, stdout }),
    );
    expect(result.kind).toBe("dev");
    const openedUrl = openBrowser.mock.calls[0]?.[0] as URL;
    expect(openedUrl.origin).toBe("http://127.0.0.1:5173");
    expect(openedUrl.searchParams.get("serverUrl")).toBe("http://127.0.0.1:13773/");
    expect(openedUrl.hash).toBe(`#launchToken=${launchToken}`);
    const minted = fetch.mock.calls.find(
      ([url]) => url.pathname === "/api/desktop/launch-sessions",
    );
    expect(JSON.parse(String(minted?.[1].body))).toMatchObject({
      origin: "http://127.0.0.1:5173",
    });
  });

  it("uses an already-running canonical host without restarting it for Vite", async () => {
    const result = await runWebCommand(
      baseOptions({
        dev: true,
        attachOrCreateHost: vi.fn(async () => ({
          kind: "attached" as const,
          url: new URL("http://127.0.0.1:13773"),
        })),
      }),
    );

    expect(result).toMatchObject({ kind: "dev" });
  });

  it("refuses to open a Vite renderer that an already-running host would refuse", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 403 }));
    const startDevServer = vi.fn(async () => "http://127.0.0.1:5173");
    const openBrowser = vi.fn();
    const stderr = { write: vi.fn((chunk: string) => chunk.length > 0) };

    const result = await runWebCommand(
      baseOptions({ dev: true, fetch, startDevServer, openBrowser, stderr }),
    );

    expect(result.kind).toBe("renderer-refused");
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/shell/local-session"),
      expect.objectContaining({
        method: "OPTIONS",
        headers: expect.objectContaining({ origin: "http://127.0.0.1:5173" }),
      }),
    );
    expect(startDevServer).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("OCTANT_WEB_URL=http://127.0.0.1:5173"),
    );
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
