import { beforeEach, describe, expect, it } from "vitest";
import { decodeThreadMessageQueueCommand } from "@octant/contracts";
import { createComposerThreadDraftStore } from "../composer/composerThreadDraftStore";
import {
  readQueueReceipts,
  saveQueueReceipt,
  type QueueReceipt,
} from "./threadMessageQueueReceipts";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    key: (index) => [...values.keys()][index] ?? null,
  };
}
let storage = memoryStorage();
const receipt: QueueReceipt = {
  host: "host-one",
  command: decodeThreadMessageQueueCommand({
    kind: "enqueue",
    scope: { mode: "chat", threadId: "11111111-1111-4111-8111-111111111111" },
    requestId: "22222222-2222-4222-8222-222222222222",
    messageId: "33333333-3333-4333-8333-333333333333",
    expectedVersion: 0,
    payload: { mode: "chat", prompt: "Private prompt" },
  }),
};

describe("private queue receipts", () => {
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("keeps exact commands isolated by host without saving a capability", () => {
    expect(saveQueueReceipt(receipt, storage)).toBe(true);
    expect(readQueueReceipts("host-one", receipt.command.scope, storage)).toEqual({
      status: "ready",
      receipts: [receipt],
    });
    expect(readQueueReceipts("host-two", receipt.command.scope, storage)).toEqual({
      status: "ready",
      receipts: [],
    });
    const key = storage.key(0);
    if (key === null) throw new Error("Expected private receipt");
    expect(storage.getItem(key)).not.toMatch(/capability|authorization/i);
    storage.setItem(key, "broken");
    expect(readQueueReceipts("host-one", receipt.command.scope, storage)).toEqual({
      status: "unavailable",
    });
  });

  it.each(["purge", "unknown thread", "clear all"] as const)(
    "erases receipt payloads through draft %s",
    (operation) => {
      saveQueueReceipt(receipt, storage);
      const store = createComposerThreadDraftStore(storage);
      if (operation === "purge") store.purgeThread(String(receipt.command.scope.threadId));
      else if (operation === "unknown thread") store.dropUnknownThreads("chat", []);
      else store.clearAll();
      expect(readQueueReceipts(receipt.host, receipt.command.scope, storage)).toEqual({
        status: "ready",
        receipts: [],
      });
      expect(storage.length).toBe(0);
    },
  );
});
