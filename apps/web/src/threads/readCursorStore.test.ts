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

  it("keeps the most recently streamed thread after later marks fill the limit", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const store = createReadCursorStore<string>({ storageKey: "cursors", storage });

    store.markDeferred("thread-a", 1);
    store.markDeferred("thread-b", 1);
    store.markDeferred("thread-a", 2);
    vi.runAllTimers();

    const afterFlush = createReadCursorStore<string>({ storageKey: "cursors", storage });
    for (let index = 0; index < 499; index += 1) {
      afterFlush.mark(`later-${index}`, index + 1);
    }

    const afterRestart = createReadCursorStore<string>({ storageKey: "cursors", storage });
    expect(afterRestart.getSnapshot().get("thread-a")).toBe(2);
    expect(afterRestart.getSnapshot().has("thread-b")).toBe(false);
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

  it("does not let an older deferred read overwrite another window's explicit unread mark", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const events = new EventTarget();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalAdd = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
    const originalRemove = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");
    Object.defineProperties(globalThis, {
      localStorage: { configurable: true, value: storage },
      addEventListener: {
        configurable: true,
        value: events.addEventListener.bind(events),
      },
      removeEventListener: {
        configurable: true,
        value: events.removeEventListener.bind(events),
      },
    });

    try {
      const windowOne = createReadCursorStore<string>({ storageKey: "cursors" });
      windowOne.mark("thread-1", 4);
      const windowTwo = createReadCursorStore<string>({ storageKey: "cursors" });
      const unsubscribe = windowTwo.subscribe(() => undefined);

      windowTwo.markDeferred("thread-1", 5);
      windowOne.unmark("thread-1");
      const event = new Event("storage");
      Object.defineProperties(event, {
        key: { value: "cursors" },
        storageArea: { value: storage },
      });
      events.dispatchEvent(event);
      vi.runAllTimers();

      const relaunched = createReadCursorStore<string>({ storageKey: "cursors" });
      expect(relaunched.getSnapshot().has("thread-1")).toBe(false);
      expect(relaunched.getMarkedUnread().has("thread-1")).toBe(true);
      unsubscribe();
    } finally {
      restoreGlobalProperty("localStorage", originalStorage);
      restoreGlobalProperty("addEventListener", originalAdd);
      restoreGlobalProperty("removeEventListener", originalRemove);
    }
  });

  it("settles a pending read before the window stops being the one in front", () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalAdd = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
    const originalRemove = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");
    Object.defineProperties(globalThis, {
      localStorage: { configurable: true, value: storage },
      addEventListener: { configurable: true, value: events.addEventListener.bind(events) },
      removeEventListener: {
        configurable: true,
        value: events.removeEventListener.bind(events),
      },
    });

    try {
      const store = createReadCursorStore<string>({ storageKey: "cursors" });
      const unsubscribe = store.subscribe(() => undefined);
      // A streaming thread marks deferred. Held only in memory, a host that
      // tears its renderer down without a page lifecycle event loses the read
      // and the thread comes back unread on the next launch.
      store.markDeferred("thread-1", 42);
      expect(createReadCursorStore<string>({ storageKey: "cursors" }).getSnapshot().size).toBe(0);

      events.dispatchEvent(new Event("blur"));

      expect(
        createReadCursorStore<string>({ storageKey: "cursors" }).getSnapshot().get("thread-1"),
      ).toBe(42);
      unsubscribe();
    } finally {
      restoreGlobalProperty("localStorage", originalStorage);
      restoreGlobalProperty("addEventListener", originalAdd);
      restoreGlobalProperty("removeEventListener", originalRemove);
    }
  });

  it("settles a pending read when the page is frozen", () => {
    const storage = memoryStorage();
    const windowEvents = new EventTarget();
    const documentEvents = new EventTarget();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalAdd = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
    const originalRemove = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperties(globalThis, {
      localStorage: { configurable: true, value: storage },
      addEventListener: {
        configurable: true,
        value: windowEvents.addEventListener.bind(windowEvents),
      },
      removeEventListener: {
        configurable: true,
        value: windowEvents.removeEventListener.bind(windowEvents),
      },
      document: {
        configurable: true,
        value: {
          visibilityState: "visible",
          addEventListener: documentEvents.addEventListener.bind(documentEvents),
          removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
        },
      },
    });

    try {
      const store = createReadCursorStore<string>({ storageKey: "cursors" });
      const unsubscribe = store.subscribe(() => undefined);
      store.markDeferred("thread-1", 7);

      // The Page Lifecycle API dispatches `freeze` on the document; a window
      // listener never runs for it.
      documentEvents.dispatchEvent(new Event("freeze"));

      expect(
        createReadCursorStore<string>({ storageKey: "cursors" }).getSnapshot().get("thread-1"),
      ).toBe(7);
      unsubscribe();
    } finally {
      restoreGlobalProperty("localStorage", originalStorage);
      restoreGlobalProperty("addEventListener", originalAdd);
      restoreGlobalProperty("removeEventListener", originalRemove);
      restoreGlobalProperty("document", originalDocument);
    }
  });
});

function restoreGlobalProperty(
  name: "localStorage" | "addEventListener" | "removeEventListener" | "document",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
