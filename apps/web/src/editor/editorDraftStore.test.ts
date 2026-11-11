import { describe, expect, it } from "vitest";
import { createEditorDraftStore } from "./editorDraftStore";

describe("editor recovery", () => {
  it("recovers after recreating the store, isolates hosts, and removes saved drafts", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    createEditorDraftStore("host-a", storage).write("file", "unsaved");
    expect(createEditorDraftStore("host-b", storage).read("file")).toBeUndefined();
    const recovered = createEditorDraftStore("host-a", storage);
    expect(recovered.read("file")).toBe("unsaved");
    recovered.clear("file");
    expect(createEditorDraftStore("host-a", storage).read("file")).toBeUndefined();
  });
  it("keeps edits usable and reports when storage refuses writes", () => {
    const store = createEditorDraftStore("host", {
      getItem: () => null,
      setItem: () => {
        throw Error("quota");
      },
      removeItem: () => undefined,
    });
    store.write("file", "my work");
    expect(store.read("file")).toBe("my work");
    expect(store.error?.()).toContain("Save before closing");
  });
  it("warns until every memory-only draft is saved or discarded", () => {
    const values = new Map<string, string>();
    const store = createEditorDraftStore("host", {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (value.length > 8) throw Error("quota");
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    });
    store.write("first", "a large unsaved draft");
    store.write("first:base", "revision");
    expect(store.error?.()).toContain("Save before closing");
    expect(store.read("first")).toBe("a large unsaved draft");
    store.write("second", "another large draft");
    store.clear("first:base");
    expect(store.error?.()).toContain("Save before closing");
    store.write("first", "short");
    expect(store.error?.()).toContain("Save before closing");
    store.clear("second");
    expect(store.error?.()).toBeUndefined();
    expect(
      createEditorDraftStore("host", {
        getItem: (key) => values.get(key) ?? null,
        setItem: () => undefined,
        removeItem: () => undefined,
      }).read("first"),
    ).toBe("short");
  });
});
