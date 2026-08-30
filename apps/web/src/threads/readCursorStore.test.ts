import { describe, expect, it } from "vitest";
import { createReadCursorStore } from "./readCursorStore";

function memoryStorage(seed: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe("thread read cursors", () => {
  it("keeps a thread read after the app is restarted", () => {
    const storage = memoryStorage();
    const before = createReadCursorStore<string>({ storageKey: "cursors", storage });
    before.mark("thread-1", 7);

    const after = createReadCursorStore<string>({ storageKey: "cursors", storage });

    expect(after.getSnapshot().get("thread-1")).toBe(7);
    expect(after.getMarkedUnread().has("thread-1")).toBe(false);
  });

  it("keeps a thread the user marked unread unread after a restart", () => {
    const storage = memoryStorage();
    const before = createReadCursorStore<string>({ storageKey: "cursors", storage });
    before.mark("thread-1", 7);
    before.unmark("thread-1");

    const after = createReadCursorStore<string>({ storageKey: "cursors", storage });

    expect(after.getSnapshot().has("thread-1")).toBe(false);
    expect(after.getMarkedUnread().has("thread-1")).toBe(true);
  });

  it("starts empty rather than failing when the stored record is unreadable", () => {
    const store = createReadCursorStore<string>({
      storageKey: "cursors",
      storage: memoryStorage({ cursors: "not json" }),
    });

    expect(store.getSnapshot().size).toBe(0);
    store.mark("thread-1", 3);
    expect(store.getSnapshot().get("thread-1")).toBe(3);
  });

  it("still records a read when storage refuses to keep it", () => {
    const store = createReadCursorStore<string>({
      storageKey: "cursors",
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    });

    store.mark("thread-1", 3);

    expect(store.getSnapshot().get("thread-1")).toBe(3);
  });

  it("does not read one mode's cursors as another's", () => {
    const storage = memoryStorage();
    createReadCursorStore<string>({ storageKey: "chat", storage }).mark("thread-1", 7);

    const code = createReadCursorStore<string>({ storageKey: "code", storage });

    expect(code.getSnapshot().size).toBe(0);
  });
});

describe("thread read cursors across windows", () => {
  it("keeps a read another window recorded while this one records its own", () => {
    const storage = memoryStorage();
    const windowOne = createReadCursorStore<string>({ storageKey: "cursors", storage });
    const windowTwo = createReadCursorStore<string>({ storageKey: "cursors", storage });

    windowOne.mark("thread-1", 4);
    windowTwo.mark("thread-2", 9);

    const relaunched = createReadCursorStore<string>({ storageKey: "cursors", storage });
    expect(relaunched.getSnapshot().get("thread-1")).toBe(4);
    expect(relaunched.getSnapshot().get("thread-2")).toBe(9);
  });
});
