import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decodeAgentRunId } from "@octant/contracts/agent-run";
import { createNodeAgentRunProcessPort } from "./nodeAgentRunProcessPort";

describe("createNodeAgentRunProcessPort", () => {
  it("starts a real detached child and confirms bounded termination", async () => {
    let exited = false;
    const port = createNodeAgentRunProcessPort({
      command: () => ({
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      }),
      shutdownTimeoutMs: 1_000,
    });
    const handle = port.spawn({
      id: decodeAgentRunId("11111111-1111-4111-8111-111111111111"),
    } as never);
    handle.onExit(() => {
      exited = true;
    });

    expect(handle.pid).toBeGreaterThan(0);
    await handle.terminate();
    expect(exited).toBe(true);
  });

  it("persists and clears a durable ownership receipt", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-agent-run-receipts-"));
    try {
      const port = createNodeAgentRunProcessPort({
        command: () => ({
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
        }),
        receiptDirectory,
      });
      const handle = port.spawn({
        id: decodeAgentRunId("22222222-2222-4222-8222-222222222222"),
      } as never);
      await handle.receiptReady;
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      await handle.terminate();
      expect(await readdir(receiptDirectory)).toHaveLength(0);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("rejects receipt failures and terminates the detached child", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-agent-run-receipts-"));
    try {
      const port = createNodeAgentRunProcessPort({
        command: () => ({
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
        }),
        receiptDirectory,
        processIdentity: async () => {
          throw new Error("identity unavailable");
        },
      });
      const handle = port.spawn({
        id: decodeAgentRunId("33333333-3333-4333-8333-333333333333"),
      } as never);

      await expect(handle.receiptReady).rejects.toThrow("identity unavailable");
      await handle.terminate();
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("retains the receipt when the leader exits before its process group", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-agent-run-receipts-"));
    try {
      let groupAlive = true;
      const port = createNodeAgentRunProcessPort({
        command: () => ({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
        receiptDirectory,
        processGroupExists: () => groupAlive,
        shutdownTimeoutMs: 10,
      });
      const handle = port.spawn({
        id: decodeAgentRunId("44444444-4444-4444-8444-444444444444"),
      } as never);
      await handle.receiptReady;
      await vi.waitFor(() => expect(handle.pid).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readdir(receiptDirectory)).toHaveLength(1);

      groupAlive = false;
      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(0));
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("removes a receipt when exit races pending identity persistence", async () => {
    const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-agent-run-receipts-"));
    try {
      let releaseIdentity!: () => void;
      const identity = new Promise<string>((resolve) => {
        releaseIdentity = () => resolve(`sha256:${"a".repeat(64)}`);
      });
      const port = createNodeAgentRunProcessPort({
        command: () => ({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
        receiptDirectory,
        processIdentity: async () => identity,
      });
      const handle = port.spawn({
        id: decodeAgentRunId("55555555-5555-4555-8555-555555555555"),
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseIdentity();
      await handle.receiptReady;
      await vi.waitFor(async () => expect(await readdir(receiptDirectory)).toHaveLength(0));
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });
});
