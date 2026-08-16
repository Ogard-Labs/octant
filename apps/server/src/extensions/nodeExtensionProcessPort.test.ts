import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionSupervisor } from "./extensionSupervisor";
import { createNodeExtensionProcessPort } from "./nodeExtensionProcessPort";

const receiptDirectories: string[] = [];
const macosOnly = process.platform === "darwin" ? it : it.skip;

const startInput = {
  extensionId: "42700000-0000-4000-8000-000000000001",
  packageId: "42700000-0000-4000-8000-000000000002",
  componentId: "server",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  command: process.execPath,
  args: [
    "-e",
    "process.stdout.write('OCTANT_EXTENSION_READY\\n'); setInterval(() => undefined, 1000)",
  ],
  cwd: process.cwd(),
  env: { OCTANT_EXTENSION_ID: "42700000-0000-4000-8000-000000000001" },
  maxOutputBytes: 1024,
  signal: new AbortController().signal,
};

afterEach(async () => {
  await Promise.all(
    receiptDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("node extension process port", () => {
  it("constructs a network-denied macOS sandbox launch", async () => {
    let observed: { command: string; args: ReadonlyArray<string> } | undefined;
    const spawn = ((...input: Parameters<typeof nodeSpawn>) => {
      const [command, args] = input;
      observed = { command, args };
      return nodeSpawn(...input);
    }) as typeof nodeSpawn;
    const port = createNodeExtensionProcessPort({
      spawn,
      shutdownTimeoutMs: 100,
      platform: "darwin",
      sandboxPath: process.execPath,
    });
    const child = await port.start({
      ...startInput,
      readiness: "spawn",
      sandbox: {
        kind: "macos-seatbelt",
        scope: {
          hostId: "local",
          mode: "chat",
          projectId: null,
          threadId: "thread-1",
          providerFamily: "openai-compatible",
        },
        allowRead: [process.cwd()],
        allowWrite: [tmpdir()],
        allowNetwork: false,
      },
    });
    try {
      await child.ready;
      expect(observed?.command).toBe(process.execPath);
      expect(observed?.args).toEqual(expect.arrayContaining(["--", process.execPath]));
      expect(observed?.args[1]).toContain("(deny default)");
      expect(observed?.args[1]).not.toContain("(allow network");
    } finally {
      await child.stop().catch(() => undefined);
    }
  });

  macosOnly("denies sandboxed extension reads outside the declared roots", async () => {
    const secretDirectory = await mkdtemp(join(homedir(), ".octant-extension-sandbox-test-"));
    receiptDirectories.push(secretDirectory);
    const secretPath = join(secretDirectory, "private.txt");
    await writeFile(secretPath, "private");
    const port = createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 });
    const child = await port.start({
      ...startInput,
      args: ["-e", `require("node:fs").readFileSync(${JSON.stringify(secretPath)})`],
      readiness: "spawn",
      sandbox: {
        kind: "macos-seatbelt",
        scope: {
          hostId: "local",
          mode: "chat",
          projectId: null,
          threadId: "thread-1",
          providerFamily: "openai-compatible",
        },
        allowRead: [process.cwd()],
        allowWrite: [tmpdir()],
        allowNetwork: false,
      },
    } as never);

    const exit = await child.wait;
    expect(exit.code).not.toBe(0);
  });
  it("owns a detached child process and reaps its process group on stop", async () => {
    const port = createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 });
    const child = await port.start(startInput);
    expect(child.pid).toBeGreaterThan(0);
    await child.ready;
    await child.stop();
    await vi.waitFor(() => expect(() => process.kill(child.pid, 0)).toThrow(), { timeout: 2_000 });
  });

  it("cancels a started child when its signal is aborted", async () => {
    const controller = new AbortController();
    const port = createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 });
    const child = await port.start({ ...startInput, signal: controller.signal });
    controller.abort();
    await expect(child.wait).resolves.toMatchObject({ signal: expect.any(String) });
  });

  it("does not report ready when a spawned child exits before the handshake", async () => {
    const port = createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 });
    const child = await port.start({
      ...startInput,
      args: ["-e", "process.exit(0)"],
    });

    await expect(child.ready).rejects.toThrow("readiness handshake");
    await expect(child.wait).resolves.toMatchObject({ code: 0 });
  });

  it("keeps a spawned child unavailable until the bounded supervisor timeout", async () => {
    const port = createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 });
    const evidence: unknown[] = [];
    const runtime = new ExtensionSupervisor({
      process: port,
      clock: () => "2026-07-29T12:00:00.000Z",
      authorizeLaunch: async () => true,
      evidence: (event) => evidence.push(event),
      limits: { startupTimeoutMs: 25, drainTimeoutMs: 100 },
    });

    await expect(
      runtime.start({
        extensionId: startInput.extensionId,
        packageId: startInput.packageId,
        componentId: startInput.componentId,
        version: startInput.version,
        digest: startInput.digest,
        entryPoint: process.execPath,
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        cwd: process.cwd(),
        env: startInput.env,
        effective: true,
        approved: true,
        authority: { kind: "trusted-extension", extensionId: startInput.extensionId },
      }),
    ).rejects.toMatchObject({ category: "waiting" });
    expect(evidence).not.toContainEqual(expect.objectContaining({ state: "ready" }));
  });

  it("terminates a child that exceeds the bounded output budget", async () => {
    const port = createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 });
    const child = await port.start({
      ...startInput,
      args: ["-e", "process.stdout.write('x'.repeat(2048)); setInterval(() => undefined, 1000)"],
      maxOutputBytes: 1024,
    });

    await expect(child.wait).resolves.toMatchObject({ signal: expect.any(String) });
  });

  it("does not count interactive MCP protocol stdout against the diagnostic budget", async () => {
    const port = createNodeExtensionProcessPort({ shutdownTimeoutMs: 100 });
    const child = await port.start({
      ...startInput,
      args: ["-e", "process.stdout.write('x'.repeat(2048)); setInterval(() => undefined, 1000)"],
      maxOutputBytes: 1024,
      readiness: "spawn",
    });

    await child.ready;
    const state = await Promise.race([
      child.wait.then(() => "exited" as const),
      new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 50)),
    ]);
    expect(state).toBe("running");
    await child.stop();
  });

  it("persists redacted ownership receipts and lets a fresh port reconcile an orphan", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-extension-receipts-"));
    receiptDirectories.push(receiptDirectory);
    const firstPort = createNodeExtensionProcessPort({ receiptDirectory, shutdownTimeoutMs: 100 });
    const child = await firstPort.start(startInput);
    const receiptFile = (await readdir(receiptDirectory))[0];
    expect(receiptFile).toMatch(/^receipt-[a-f0-9]{64}\.json$/);
    const stored = await readFile(join(receiptDirectory, receiptFile!), "utf8");
    expect(stored).not.toContain(process.cwd());
    expect(stored).not.toContain("setInterval");

    const freshPort = createNodeExtensionProcessPort({ receiptDirectory, shutdownTimeoutMs: 100 });
    await expect(freshPort.receipts()).resolves.toMatchObject([
      { extensionId: startInput.extensionId, packageId: startInput.packageId, state: "running" },
    ]);
    const runtime = new ExtensionSupervisor({
      process: freshPort,
      clock: () => "2026-07-29T12:00:00.000Z",
      authorizeLaunch: async () => true,
      limits: { drainTimeoutMs: 100 },
    });
    await runtime.reconcile();
    await vi.waitFor(async () => expect(await freshPort.receipts()).toHaveLength(0));
    await vi.waitFor(() => expect(() => process.kill(child.pid, 0)).toThrow());
  });

  it("persists a strong process identity in the durable ownership receipt", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-extension-receipts-"));
    receiptDirectories.push(receiptDirectory);
    const processIdentity = `sha256:${"b".repeat(64)}`;
    const port = createNodeExtensionProcessPort({
      receiptDirectory,
      shutdownTimeoutMs: 100,
      processIdentity: async () => processIdentity,
    });
    const child = await port.start(startInput);

    try {
      const receiptFile = (await readdir(receiptDirectory))[0];
      const stored = JSON.parse(await readFile(join(receiptDirectory, receiptFile!), "utf8"));
      expect(stored).toMatchObject({ schemaVersion: 2, processIdentity });
    } finally {
      await child.stop().catch(() => undefined);
    }
  });

  it("deletes a stale receipt without killing a reused pid with a different process identity", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-extension-receipts-"));
    receiptDirectories.push(receiptDirectory);
    const originalIdentity = `sha256:${"c".repeat(64)}`;
    const reusedIdentity = `sha256:${"d".repeat(64)}`;
    let observedIdentity = originalIdentity;
    const processIdentity = vi.fn(async () => observedIdentity);
    const firstPort = createNodeExtensionProcessPort({
      receiptDirectory,
      shutdownTimeoutMs: 100,
      processIdentity,
    });
    const child = await firstPort.start(startInput);

    try {
      observedIdentity = reusedIdentity;
      const freshPort = createNodeExtensionProcessPort({
        receiptDirectory,
        shutdownTimeoutMs: 100,
        processIdentity,
      });
      const runtime = new ExtensionSupervisor({
        process: freshPort,
        clock: () => "2026-07-29T12:00:00.000Z",
        authorizeLaunch: async () => true,
        limits: { drainTimeoutMs: 100 },
      });

      await runtime.reconcile();

      expect(() => process.kill(child.pid, 0)).not.toThrow();
      await expect(freshPort.receipts()).resolves.toEqual([]);
    } finally {
      observedIdentity = originalIdentity;
      await child.stop().catch(() => undefined);
    }
  });

  it("rechecks process identity immediately before stopping a discovered orphan", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-extension-receipts-"));
    receiptDirectories.push(receiptDirectory);
    const originalIdentity = `sha256:${"e".repeat(64)}`;
    const reusedIdentity = `sha256:${"f".repeat(64)}`;
    let observedIdentity = originalIdentity;
    const processIdentity = vi.fn(async () => observedIdentity);
    const firstPort = createNodeExtensionProcessPort({
      receiptDirectory,
      shutdownTimeoutMs: 100,
      processIdentity,
    });
    const child = await firstPort.start(startInput);

    try {
      const freshPort = createNodeExtensionProcessPort({
        receiptDirectory,
        shutdownTimeoutMs: 100,
        processIdentity,
      });
      const [receipt] = await freshPort.receipts();
      expect(receipt).toBeDefined();

      observedIdentity = reusedIdentity;
      await receipt?.stop?.();

      expect(() => process.kill(child.pid, 0)).not.toThrow();
    } finally {
      observedIdentity = originalIdentity;
      await child.stop().catch(() => undefined);
    }
  });
});
