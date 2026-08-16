import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { persistProcessReceipt, reconcileProcessReceipts } from "./nodeOwnedProcessReceipt";

const identity = `sha256:${"a".repeat(64)}`;

describe("durable owned-process receipts", () => {
  it.each([
    "provider",
    "terminal",
    "repository-test-runner",
    "browser",
    "computer-use",
    "agent-run",
  ])("writes and removes a clean %s receipt", async (supervisor) => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    try {
      const receipt = await persistProcessReceipt(
        { supervisor, receiptDirectory: directory, processIdentity: async () => identity },
        "owner-1",
        4321,
      );
      await receipt.ready;
      expect(await readdir(directory)).toHaveLength(1);
      await receipt.remove();
      expect(await readdir(directory)).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reaps an orphan only while the recorded identity still matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    const kill = vi.fn();
    let observed = identity;
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "terminal",
          receiptDirectory: directory,
          processIdentity: async () => observed,
        },
        "owner-1",
        4321,
      );
      await receipt.ready;
      observed = `sha256:${"b".repeat(64)}`;
      await reconcileProcessReceipts({
        supervisor: "terminal",
        receiptDirectory: directory,
        processIdentity: async () => observed,
        killProcessGroup: kill,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reaps a matching orphan before deleting its receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    let observed: string | undefined = identity;
    const kill = vi.fn(() => {
      observed = undefined;
    });
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "agent-run",
          receiptDirectory: directory,
          processIdentity: async () => observed,
        },
        "owner-1",
        4321,
      );
      await receipt.ready;
      await reconcileProcessReceipts({
        supervisor: "agent-run",
        receiptDirectory: directory,
        processIdentity: async () => observed,
        killProcessGroup: kill,
        shutdownTimeoutMs: 20,
      });
      expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
      expect(await readdir(directory)).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when identity observation errors instead of trusting a live group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    const kill = vi.fn();
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "agent-run",
          receiptDirectory: directory,
          processIdentity: async () => identity,
        },
        "owner-1",
        4321,
      );
      await receipt.ready;
      await expect(
        reconcileProcessReceipts({
          supervisor: "agent-run",
          receiptDirectory: directory,
          processIdentity: async () => {
            throw new Error("identity lookup timed out");
          },
          processGroupExists: () => true,
          killProcessGroup: kill,
        }),
      ).rejects.toThrow("identity lookup timed out");
      expect(kill).not.toHaveBeenCalled();
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates a matching orphan termination failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "terminal",
          receiptDirectory: directory,
          processIdentity: async () => identity,
        },
        "owner-1",
        4321,
      );
      await receipt.ready;
      await expect(
        reconcileProcessReceipts({
          supervisor: "terminal",
          receiptDirectory: directory,
          processIdentity: async () => identity,
          processGroupExists: () => true,
          killProcessGroup: vi.fn(),
          shutdownTimeoutMs: 1,
        }),
      ).rejects.toThrow("did not terminate after SIGKILL");
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates receipt-directory read failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    const file = join(root, "not-a-directory");
    try {
      await writeFile(file, "not a directory");
      await expect(
        reconcileProcessReceipts({ supervisor: "terminal", receiptDirectory: file }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EISDIR/) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a malformed ownership receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "terminal",
          receiptDirectory: directory,
          processIdentity: async () => identity,
        },
        "owner-1",
        4321,
      );
      await receipt.ready;
      const [name] = await readdir(directory);
      await writeFile(join(directory, name!), '{"truncated":');

      await expect(
        reconcileProcessReceipts({
          supervisor: "terminal",
          receiptDirectory: directory,
          processIdentity: async () => identity,
        }),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([name]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed instead of skipping receipts past the reconciliation bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    try {
      await Promise.all(
        Array.from({ length: 257 }, (_, index) =>
          writeFile(join(directory, `receipt-${String(index).padStart(3, "0")}.json`), "junk"),
        ),
      );
      await expect(
        reconcileProcessReceipts({ supervisor: "terminal", receiptDirectory: directory }),
      ).rejects.toThrow("Too many process ownership receipts");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves another supervisor's receipt for its own reconciler", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "provider",
          receiptDirectory: directory,
          processIdentity: async () => identity,
        },
        "owner-1",
        4321,
      );
      await receipt.ready;
      await reconcileProcessReceipts({
        supervisor: "terminal",
        receiptDirectory: directory,
        processIdentity: async () => identity,
      });
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("escalates when the leader exits but its owned process group survives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-process-receipt-"));
    let leader: string | undefined = identity;
    let groupAlive = true;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") leader = undefined;
      if (signal === "SIGKILL") groupAlive = false;
    });
    try {
      const receipt = await persistProcessReceipt(
        {
          supervisor: "terminal",
          receiptDirectory: directory,
          processIdentity: async () => leader,
        },
        "owner-1",
        4321,
      );
      await receipt.ready;
      await reconcileProcessReceipts({
        supervisor: "terminal",
        receiptDirectory: directory,
        processIdentity: async () => leader,
        processGroupExists: () => groupAlive,
        killProcessGroup: kill,
        shutdownTimeoutMs: 20,
      });
      expect(kill).toHaveBeenNthCalledWith(1, 4321, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, 4321, "SIGKILL");
      expect(await readdir(directory)).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
