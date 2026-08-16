import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNodeComputerUseProcessPort } from "./nodeComputerUseProcessPort";

class FakeStream extends EventEmitter {
  readonly chunks: string[] = [];
  end(value?: string) {
    if (value !== undefined) this.chunks.push(value);
  }
}

class FakeChild extends EventEmitter {
  readonly pid = 4321;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStream();
  readonly kill = vi.fn(() => true);
}

describe("node computer-use process port", () => {
  it("spawns without a shell or inherited secrets and keeps text on stdin", async () => {
    const child = new FakeChild();
    const spawn = vi.fn((..._arguments: unknown[]) => child);
    const port = createNodeComputerUseProcessPort({ spawn: spawn as never });
    const running = port.run({
      executable: "/usr/bin/osascript",
      arguments: ["-l", "JavaScript", "--", "type-text"],
      stdin: "secret text",
      signal: new AbortController().signal,
    });
    child.stdout.emit("data", Buffer.from('{"ok":true}'));
    child.emit("close", 0);

    await expect(running).resolves.toEqual({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
    expect(child.stdin.chunks).toEqual(["secret text"]);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "--", "type-text"],
      expect.objectContaining({
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const spawnOptions = spawn.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined;
    expect(spawnOptions?.env).toEqual({ LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" });
  });

  it("aborts only the owned child and rejects as interrupted", async () => {
    const child = new FakeChild();
    const port = createNodeComputerUseProcessPort({ spawn: (() => child) as never });
    const controller = new AbortController();
    const running = port.run({
      executable: "/usr/bin/osascript",
      arguments: [],
      signal: controller.signal,
    });
    const settled = vi.fn();
    void running.catch(settled);
    controller.abort();

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds helper output and waits for the owned child to close before rejecting", async () => {
    const child = new FakeChild();
    const port = createNodeComputerUseProcessPort({ spawn: (() => child) as never });
    const running = port.run({
      executable: "/usr/bin/osascript",
      arguments: [],
      signal: new AbortController().signal,
    });
    const settled = vi.fn();
    void running.catch(settled);

    child.stdout.emit("data", Buffer.alloc(64 * 1024 + 1));
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);
    await expect(running).rejects.toThrow("output exceeded its limit");
  });

  it("writes a receipt before a clean helper exit removes it", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-computer-use-receipts-"));
    try {
      const child = new FakeChild();
      const port = createNodeComputerUseProcessPort({
        spawn: (() => child) as never,
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
      });
      const running = port.run({
        executable: "/usr/bin/osascript",
        arguments: [],
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      child.emit("close", 0);
      await running;
      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(0));
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("terminates and rejects when receipt persistence fails while the helper runs", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-computer-use-receipts-"));
    try {
      const child = new FakeChild();
      const port = createNodeComputerUseProcessPort({
        spawn: (() => child) as never,
        receiptDirectory,
        processIdentity: async () => {
          throw new Error("identity unavailable");
        },
      });
      const running = port.run({
        executable: "/usr/bin/osascript",
        arguments: [],
        signal: new AbortController().signal,
      });

      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
      child.emit("close", null);
      await expect(running).rejects.toThrow("identity unavailable");
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("signals the detached process group and verifies descendants are gone", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-computer-use-receipts-"));
    try {
      const child = new FakeChild();
      let groupExists = true;
      const signals: Array<[number, NodeJS.Signals]> = [];
      const port = createNodeComputerUseProcessPort({
        spawn: (() => child) as never,
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
        processGroupExists: () => groupExists,
        killProcessGroup: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === "SIGKILL") groupExists = false;
        },
        shutdownTimeoutMs: 10,
      });
      const controller = new AbortController();
      const running = port.run({
        executable: "/usr/bin/osascript",
        arguments: [],
        signal: controller.signal,
      });
      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(1));
      controller.abort();
      child.emit("close", null);

      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(signals).toEqual([
        [-child.pid, "SIGTERM"],
        [-child.pid, "SIGKILL"],
      ]);
      expect(await readdir(receiptDirectory)).toHaveLength(0);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });
});
