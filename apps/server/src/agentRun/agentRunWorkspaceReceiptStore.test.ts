import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_WORKSPACE_RECEIPT_TTL_MS,
  AgentRunWorkspaceReceiptStore,
} from "./agentRunWorkspaceReceiptStore";

/**
 * Holds one write open after the file it targets has been opened for writing,
 * so a read that lands mid-write is deterministic instead of timing-dependent.
 */
const writeGate = vi.hoisted(() => ({
  hold: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const hold = writeGate.hold;
      writeGate.hold = undefined;
      if (hold === undefined) return actual.writeFile(...args);
      const [target, data] = args;
      const handle = await actual.open(target as string, "w", 0o600);
      try {
        await hold();
        await handle.writeFile(data as string, "utf8");
      } finally {
        await handle.close();
      }
    },
  };
});

const directories: string[] = [];
afterEach(() => {
  writeGate.hold = undefined;
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  receipt: "66666666-6666-4666-8666-666666666666",
  thread: "33333333-3333-4333-8333-333333333333",
  window: "11111111-1111-4111-8111-111111111111",
  project: "77777777-7777-4777-8777-777777777777",
  binding: "88888888-8888-4888-8888-888888888888",
};

describe("AgentRunWorkspaceReceiptStore", () => {
  it("keeps legacy Code receipts readable but never reuses them for a new child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-ws-"));
    directories.push(directory);
    const store = new AgentRunWorkspaceReceiptStore({
      dataDirectory: directory,
      uuid: () => ids.receipt,
    });
    const now = 1_700_000_000_000;
    await store.issue({
      parentThreadId: ids.thread,
      windowId: ids.window,
      mode: "code",
      confirmed: true,
      now,
    });
    const restarted = new AgentRunWorkspaceReceiptStore({ dataDirectory: directory });
    expect(await restarted.load(ids.receipt)).toMatchObject({
      mode: "code",
      parentThreadId: ids.thread,
    });
    expect(
      await restarted.findReusable({
        requestId: "22222222-2222-4222-8222-222222222222",
        parentThreadId: ids.thread,
        windowId: ids.window,
        mode: "code",
        now,
      }),
    ).toBeUndefined();
  });

  it("issues, loads, and reuses an unexpired Work grant without exposing it as consumed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-ws-"));
    directories.push(directory);
    const store = new AgentRunWorkspaceReceiptStore({
      dataDirectory: directory,
      uuid: () => ids.receipt,
      clock: () => "2026-08-01T15:00:00.000Z",
    });
    const now = 1_700_000_000_000;
    const issued = await store.issue({
      parentThreadId: ids.thread,
      windowId: ids.window,
      mode: "work",
      confirmed: true,
      now,
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      canonicalRoot: "/projects/demo",
    });
    expect(issued.canonicalRoot).toBe("/projects/demo");
    expect(await store.load(ids.receipt)).toMatchObject({
      parentThreadId: ids.thread,
      bindingRevisionId: ids.binding,
    });
    expect(
      await store.findReusable({
        parentThreadId: ids.thread,
        mode: "work",
        windowId: ids.window,
        now: now + 1_000,
      }),
    ).toMatchObject({ receiptId: ids.receipt });
  });

  it("does not reuse an expired grant after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-ws-"));
    directories.push(directory);
    const store = new AgentRunWorkspaceReceiptStore({
      dataDirectory: directory,
      uuid: () => ids.receipt,
    });
    const now = 1_700_000_000_000;
    await store.issue({
      parentThreadId: ids.thread,
      windowId: ids.window,
      mode: "chat",
      confirmed: true,
      now,
    });
    const restarted = new AgentRunWorkspaceReceiptStore({ dataDirectory: directory });
    expect(
      await restarted.findReusable({
        parentThreadId: ids.thread,
        mode: "chat",
        windowId: ids.window,
        now: now + AGENT_RUN_WORKSPACE_RECEIPT_TTL_MS,
      }),
    ).toBeUndefined();
  });

  it("keeps the previous grant readable while a replayed confirmation is still being saved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-ws-"));
    directories.push(directory);
    const store = new AgentRunWorkspaceReceiptStore({
      dataDirectory: directory,
      uuid: () => ids.receipt,
    });
    const issued = await store.issue({
      parentThreadId: ids.thread,
      windowId: ids.window,
      mode: "code",
      confirmed: false,
      now: 1_700_000_000_000,
    });

    let duringSave: Awaited<ReturnType<typeof store.load>>;
    writeGate.hold = async () => {
      duringSave = await store.load(ids.receipt);
    };
    await store.save({ ...issued, confirmed: true });

    expect(duringSave).toMatchObject({ receiptId: ids.receipt, confirmed: false });
    expect(await store.load(ids.receipt)).toMatchObject({ confirmed: true });
  });
});
