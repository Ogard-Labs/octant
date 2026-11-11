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
});
