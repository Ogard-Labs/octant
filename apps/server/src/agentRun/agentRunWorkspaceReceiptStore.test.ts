import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_WORKSPACE_RECEIPT_TTL_MS,
  AgentRunWorkspaceReceiptStore,
} from "./agentRunWorkspaceReceiptStore";

const directories: string[] = [];
afterEach(() => {
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
});
