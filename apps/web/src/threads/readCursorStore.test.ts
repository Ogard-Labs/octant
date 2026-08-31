import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces streamed read cursors while keeping the in-memory cursor current", () => {
    vi.useFakeTimers();
    const storage = countingStorage();
    const store = createReadCursorStore<string>({ storageKey: "cursors", storage });

    for (let index = 1; index <= 5_000; index += 1) store.markDeferred("thread-1", index);

    expect(store.getSnapshot().get("thread-1")).toBe(5_000);
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(
      createReadCursorStore<string>({ storageKey: "cursors", storage })
        .getSnapshot()
        .get("thread-1"),
    ).toBe(5_000);
  });
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

  it("keeps only the newest 500 threads across read and unread marks before and after restart", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const before = createReadCursorStore<string>({ storageKey: "cursors", storage });

    for (let index = 0; index <= 500; index += 1) {
      before.mark(`read-${index}`, index + 1);
      before.unmark(`unread-${index}`);
    }

    expect(before.getSnapshot().size + before.getMarkedUnread().size).toBe(500);
    expect(before.getSnapshot().has("read-0")).toBe(false);
    expect(before.getSnapshot().get("read-500")).toBe(501);
    expect(before.getSnapshot().size).toBe(250);
    expect(before.getMarkedUnread().size).toBe(250);
    expect(before.getMarkedUnread().has("unread-0")).toBe(false);
    expect(before.getMarkedUnread().has("unread-500")).toBe(true);

    vi.runAllTimers();
    const after = createReadCursorStore<string>({ storageKey: "cursors", storage });
    expect(after.getSnapshot()).toEqual(before.getSnapshot());
    expect(after.getMarkedUnread()).toEqual(before.getMarkedUnread());
  });

  it("still records reads when the browser denies access to default storage", () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    });

    try {
      const store = createReadCursorStore<string>({ storageKey: "cursors" });
      store.mark("thread-1", 3);
      expect(store.getSnapshot().get("thread-1")).toBe(3);
    } finally {
      if (originalStorage === undefined) {
        Reflect.deleteProperty(globalThis, "localStorage");
      } else {
        Object.defineProperty(globalThis, "localStorage", originalStorage);
      }
    }
  });

  it("does not read one mode's cursors as another's", () => {
    const storage = memoryStorage();
    createReadCursorStore<string>({ storageKey: "chat", storage }).mark("thread-1", 7);

    const code = createReadCursorStore<string>({ storageKey: "code", storage });

    expect(code.getSnapshot().size).toBe(0);
  });
});

function countingStorage(): Pick<Storage, "getItem" | "setItem"> & {
  readonly setItem: ReturnType<typeof vi.fn>;
} {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
  };
}

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
