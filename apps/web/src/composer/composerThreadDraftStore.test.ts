import { describe, expect, it } from "vitest";
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
    store.write("code", codeThread, { text: "   ", caretIndex: 0, stagedDropped: false });

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
