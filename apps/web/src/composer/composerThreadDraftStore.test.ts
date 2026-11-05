import { describe, expect, it } from "vitest";
import { decodeSideChatDraftPrepared, decodeThreadMessageQueueCommand } from "@octant/contracts";
import { readQueueReceipts, saveQueueReceipt } from "../messageQueue/threadMessageQueueReceipts";
import {
  COMPOSER_THREAD_DRAFTS_STORAGE_KEY,
  applyComposerCaret,
  clampComposerCaret,
  composerDraftRecordKey,
  createComposerThreadDraftStore,
  purgeComposerThreadDrafts,
} from "./composerThreadDraftStore";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const chatThread = "00000000-0000-4000-8000-000000000801";
const workThread = "00000000-0000-4000-8000-000000000802";
const codeThread = "00000000-0000-4000-8000-000000000803";

describe("composer thread draft store", () => {
  it.each(["caret", "unchanged", "empty write", "empty clear"] as const)(
    "keeps queue draft identity across a %s update",
    (update) => {
      const storage = memoryStorage();
      const store = createComposerThreadDraftStore(storage);
      const empty = update === "empty write" || update === "empty clear";
      const draft = { text: "Original", caretIndex: 8, stagedDropped: false };
      if (!empty) store.write("code", codeThread, draft);
      const receipt = {
        host: "local",
        command: decodeThreadMessageQueueCommand({
          kind: "enqueue",
          scope: { mode: "code", threadId: codeThread },
          requestId: "22222222-2222-4222-8222-222222222222",
          messageId: "33333333-3333-4333-8333-333333333333",
          expectedVersion: 0,
          payload: { mode: "code", prompt: draft.text },
        }),
      };
      expect(saveQueueReceipt(receipt, storage)).toBe(true);
      const restored = createComposerThreadDraftStore(storage);
      const result =
        update === "empty clear"
          ? restored.clear("code", codeThread)
          : restored.write("code", codeThread, {
              ...draft,
              text: empty ? "" : draft.text,
              caretIndex: update === "caret" ? 2 : draft.caretIndex,
            });
      expect(result).toEqual({ status: "ok" });
      expect(readQueueReceipts(receipt.host, receipt.command.scope, storage)).toEqual({
        status: "ready",
        receipts: [receipt],
      });
      expect(createComposerThreadDraftStore(storage).read("code", codeThread)).toEqual(
        empty ? undefined : { ...draft, caretIndex: update === "caret" ? 2 : draft.caretIndex },
      );
    },
  );

  it("persists text and caret, then restores them from ordinary client storage", () => {
    const storage = memoryStorage();
    const store = createComposerThreadDraftStore(storage);
    store.write("chat", chatThread, {
      text: "half-written plan",
      caretIndex: 4,
      stagedDropped: false,
    });

    const restored = createComposerThreadDraftStore(storage);
    expect(restored.read("chat", chatThread)).toEqual({
      text: "half-written plan",
      caretIndex: 4,
      stagedDropped: false,
    });
    expect(storage.getItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY)).not.toContain("journal");
  });

  it("keeps one draft per thread and does not carry text across modes", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    store.write("chat", chatThread, { text: "chat draft", caretIndex: 2, stagedDropped: false });
    store.write("work", workThread, { text: "work draft", caretIndex: 0, stagedDropped: false });
    store.write("code", codeThread, { text: "code draft", caretIndex: 1, stagedDropped: false });

    expect(store.read("chat", workThread)).toBeUndefined();
    expect(store.read("work", chatThread)).toBeUndefined();
    expect(store.read("chat", chatThread)?.text).toBe("chat draft");
    expect(store.read("work", workThread)?.text).toBe("work draft");
    expect(store.read("code", codeThread)?.text).toBe("code draft");
  });

  it("clears an empty draft so it cannot reappear", () => {
    const storage = memoryStorage();
    const store = createComposerThreadDraftStore(storage);
    store.write("code", codeThread, { text: "retry this", caretIndex: 5, stagedDropped: false });
    store.write("code", codeThread, { text: "", caretIndex: 0, stagedDropped: false });

    expect(store.read("code", codeThread)).toBeUndefined();
    expect(storage.getItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY)).toBeNull();
  });

  it("drops every mode's draft when that thread is purged", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    store.write("chat", chatThread, { text: "keep me", caretIndex: 0, stagedDropped: false });
    store.write("work", chatThread, { text: "gone", caretIndex: 0, stagedDropped: false });
    store.write("code", codeThread, { text: "other", caretIndex: 0, stagedDropped: false });

    purgeComposerThreadDrafts([chatThread], store);

    expect(store.read("chat", chatThread)).toBeUndefined();
    expect(store.read("work", chatThread)).toBeUndefined();
    expect(store.read("code", codeThread)?.text).toBe("other");
  });

  it("ignores malformed storage instead of inventing a draft", () => {
    const storage = memoryStorage({
      [COMPOSER_THREAD_DRAFTS_STORAGE_KEY]: "{not json",
    });
    const store = createComposerThreadDraftStore(storage);
    expect(store.read("chat", chatThread)).toBeUndefined();
  });

  it("clamps a caret that sits past the restored text", () => {
    expect(clampComposerCaret(99, 4)).toBe(4);
    expect(composerDraftRecordKey("chat", chatThread)).toBe(`chat:${chatThread}`);
    const element = { setSelectionRange: (start: number, end: number) => ({ start, end }) };
    applyComposerCaret(element, 99, 4);
  });

  it("starts up where reading the storage property itself throws", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });

    try {
      const store = createComposerThreadDraftStore();
      store.write("chat", chatThread, {
        text: "held in memory",
        caretIndex: 0,
        stagedDropped: false,
      });
      expect(store.read("chat", chatThread)?.text).toBe("held in memory");
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, "localStorage", original);
    }
  });

  it("merges another window's draft instead of replacing the whole snapshot", () => {
    const storage = memoryStorage();
    const first = createComposerThreadDraftStore(storage);
    const second = createComposerThreadDraftStore(storage);
    first.write("chat", chatThread, { text: "thread A", caretIndex: 0, stagedDropped: false });
    second.write("code", codeThread, { text: "thread B", caretIndex: 0, stagedDropped: false });
    // Both stores started empty. The second write must keep the first thread
    // rather than replacing storage with only thread B.

    expect(second.read("chat", chatThread)?.text).toBe("thread A");
    expect(JSON.parse(storage.getItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY) ?? "{}")).toEqual({
      [`chat:${chatThread}`]: { text: "thread A", caretIndex: 0 },
      [`code:${codeThread}`]: { text: "thread B", caretIndex: 0 },
    });
  });

  it("adopts another window's snapshot written behind this store's back", () => {
    const storage = memoryStorage();
    const store = createComposerThreadDraftStore(storage);
    storage.setItem(
      COMPOSER_THREAD_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        [`chat:${chatThread}`]: { text: "from another window", caretIndex: 3 },
      }),
    );
    store.reloadFromStorage();

    expect(store.read("chat", chatThread)).toEqual({
      text: "from another window",
      caretIndex: 3,
      stagedDropped: false,
    });
  });

  it("reports when a draft cannot be saved or removed", () => {
    const refusingWrite = createComposerThreadDraftStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    });
    const write = refusingWrite.write("chat", chatThread, {
      text: "unsaved",
      caretIndex: 0,
      stagedDropped: false,
    });
    expect(write.status).toBe("unpersisted");
    expect(refusingWrite.read("chat", chatThread)?.text).toBe("unsaved");
    expect(refusingWrite.persistError()).toMatch(/could not be saved/);

    const refusingRemove = createComposerThreadDraftStore({
      getItem: () =>
        JSON.stringify({
          [`chat:${chatThread}`]: { text: "keep", caretIndex: 0 },
        }),
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    const remove = refusingRemove.clear("chat", chatThread);
    expect(remove.status).toBe("unpersisted");
    expect(refusingRemove.read("chat", chatThread)).toBeUndefined();
    expect(refusingRemove.persistError()).toMatch(/could not be removed/);
  });

  it("drops drafts whose threads are no longer in authoritative state", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    store.write("code", codeThread, { text: "gone", caretIndex: 0, stagedDropped: false });
    store.write("code", chatThread, { text: "keep", caretIndex: 0, stagedDropped: false });
    store.dropUnknownThreads("code", [chatThread]);

    expect(store.read("code", codeThread)).toBeUndefined();
    expect(store.read("code", chatThread)?.text).toBe("keep");
  });

  it("treats a clear as a mutation so an explicit empty draft is not restored", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    store.write("chat", chatThread, { text: "prompt", caretIndex: 0, stagedDropped: false });
    const before = store.revision("chat", chatThread);
    store.clear("chat", chatThread);
    expect(store.revision("chat", chatThread)).toBe(before + 1);
    store.write("chat", chatThread, { text: "replacement", caretIndex: 0, stagedDropped: false });
    store.clear("chat", chatThread);
    expect(store.revision("chat", chatThread)).toBe(before + 3);
  });
});

it("appends a returned reply to newer unsaved in-memory text on a busy source, preserving it across recovery", () => {
  const backing = memoryStorage();
  let fail = false;
  const storage = {
    ...backing,
    getItem: backing.getItem,
    removeItem: backing.removeItem,
    setItem: (key: string, value: string) => {
      if (fail) throw new Error("full");
      backing.setItem(key, value);
    },
  };
  const store = createComposerThreadDraftStore(storage);
  store.write("work", workThread, { text: "stored text", caretIndex: 2, stagedDropped: false });
  fail = true;
  store.write("work", workThread, {
    text: "newer busy task draft",
    caretIndex: 5,
    stagedDropped: true,
  });
  const prepared = decodeSideChatDraftPrepared({
    kind: "side-chat-draft-prepared",
    destination: { threadId: workThread, mode: "work", title: "Busy task", version: 9, busy: true },
    reference: {
      sidecarThreadId: chatThread,
      sourceThreadId: workThread,
      sourceMode: "work",
      turnId: "00000000-0000-4000-8000-000000000811",
      attemptId: "00000000-0000-4000-8000-000000000812",
      answerDigest: "a".repeat(64),
    },
    text: "selected answer",
    omissions: [],
  });
  expect(store.appendSideChatReturn(prepared).status).toBe("unpersisted");
  expect(store.read("work", workThread)).toMatchObject({
    text: "newer busy task draft\n\nselected answer",
    caretIndex: 5,
    stagedDropped: true,
    sideChatReturns: [prepared.reference],
  });
  fail = false;
  store.reloadFromStorage();
  expect(store.read("work", workThread)?.text).toBe("newer busy task draft\n\nselected answer");
  store.write("work", workThread, store.read("work", workThread)!);
  const reopened = createComposerThreadDraftStore(storage);
  expect(reopened.read("work", workThread)?.sideChatReturns).toEqual([prepared.reference]);
  expect(reopened.appendSideChatReturn(prepared).status).toBe("refused");
});

it.each(["", "   \n", "existing unsent text"])(
  "preserves exact existing draft %j when returning a reply and never drops corrupt provenance",
  (text) => {
    const storage = memoryStorage();
    const store = createComposerThreadDraftStore(storage);
    store.write("chat", chatThread, {
      text,
      caretIndex: Math.min(2, text.length),
      stagedDropped: false,
    });
    const prepared = decodeSideChatDraftPrepared({
      kind: "side-chat-draft-prepared",
      destination: { threadId: chatThread, mode: "chat", title: "Source", version: 1 },
      reference: {
        sidecarThreadId: workThread,
        sourceThreadId: chatThread,
        sourceMode: "chat",
        turnId: workThread,
        attemptId: codeThread,
        answerDigest: "b".repeat(64),
      },
      text: "answer",
      omissions: [],
    });
    expect(store.appendSideChatReturn(prepared).status).toBe("ok");
    expect(store.read("chat", chatThread)).toMatchObject({
      text: text.length ? `${text}\n\nanswer` : "answer",
      caretIndex: text.length ? Math.min(2, text.length) : 6,
    });
    const key = composerDraftRecordKey("chat", chatThread);
    storage.setItem(
      COMPOSER_THREAD_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        [key]: {
          text: "edited excerpt",
          caretIndex: 2,
          sideChatReturns: [{ ...prepared.reference, answerDigest: "broken" }],
        },
      }),
    );
    store.reloadFromStorage();
    expect(store.read("chat", chatThread)).toMatchObject({
      text: "edited excerpt",
      sideChatReturnsInvalid: true,
    });
    expect(store.appendSideChatReturn(prepared).status).toBe("refused");
    store.clear("chat", chatThread);
    expect(store.appendSideChatReturn(prepared).status).toBe("ok");
  },
);

it("keeps an explicit pending clear authoritative over older persisted return text during reload", () => {
  const backing = memoryStorage();
  let failed = false;
  const storage = {
    getItem: backing.getItem,
    setItem: backing.setItem,
    removeItem: (key: string) => {
      if (failed) throw new Error("locked");
      backing.removeItem(key);
    },
  };
  const store = createComposerThreadDraftStore(storage);
  store.write("chat", chatThread, {
    text: "older returned excerpt",
    caretIndex: 0,
    stagedDropped: false,
    sideChatReturnsInvalid: true,
  });
  failed = true;
  expect(store.clear("chat", chatThread).status).toBe("unpersisted");
  store.reloadFromStorage();
  expect(store.read("chat", chatThread)).toBeUndefined();
  failed = false;
  store.clear("chat", chatThread);
  expect(createComposerThreadDraftStore(storage).read("chat", chatThread)).toBeUndefined();
});
