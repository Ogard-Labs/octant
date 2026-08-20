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
});
