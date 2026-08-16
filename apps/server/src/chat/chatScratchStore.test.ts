import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeChatThreadId, type ChatThreadId } from "@octant/contracts";
import { ChatScratchStore } from "./chatScratchStore";

let root: string;
let store: ChatScratchStore;

const makeThreadId = (n: number): ChatThreadId => {
  const hex = n.toString(16).padStart(12, "0");
  return decodeChatThreadId(`00000000-0000-4000-8000-${hex}`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-chat-scratch-test-"));
  store = new ChatScratchStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ChatScratchStore.acquire", () => {
  it("returns an owned empty root under Octant data", async () => {
    const threadId = makeThreadId(1);
    const scratchRoot = await store.acquire(threadId);

    expect(scratchRoot).toBe(join(root, "scratch", threadId));
    await expect(access(scratchRoot)).resolves.toBeUndefined();
    await expect(readdir(scratchRoot)).resolves.toEqual([]);
  });

  it("reuses the same empty root for repeated acquire calls", async () => {
    const threadId = makeThreadId(2);
    const first = await store.acquire(threadId);
    const second = await store.acquire(threadId);
    expect(second).toBe(first);
  });

  it("rejects forged thread IDs before deriving managed paths", async () => {
    await expect(store.acquire("../../../escape" as ChatThreadId)).rejects.toThrow();
  });

  it("resets a reused scratch root to empty", async () => {
    const threadId = makeThreadId(4);
    const scratchRoot = await store.acquire(threadId);
    await writeFile(join(scratchRoot, "leftover.txt"), "leftover");

    const reacquired = await store.acquire(threadId);

    expect(reacquired).toBe(scratchRoot);
    await expect(readdir(scratchRoot)).resolves.toEqual([]);
  });
});

describe("ChatScratchStore.purge", () => {
  it("removes scratch content for a thread", async () => {
    const threadId = makeThreadId(3);
    const scratchRoot = await store.acquire(threadId);
    await writeFile(join(scratchRoot, "note.txt"), "temporary");

    await store.purge(threadId);

    await expect(access(scratchRoot)).rejects.toThrow();
  });

  it("is safe when called for a non-existent thread", async () => {
    await expect(store.purge(makeThreadId(99))).resolves.toBeUndefined();
  });
});
