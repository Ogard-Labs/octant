import { describe, expect, it } from "vitest";
import { CodeContentStore, CodeContentStoreError } from "./codeContentStore";

describe("CodeContentStore", () => {
  it("stores defensive byte copies behind bounded opaque references", () => {
    let nextId = 0;
    const store = new CodeContentStore({
      maximumBytes: 6,
      maximumEntries: 2,
      newContentId: () => `content-${++nextId}`,
    });
    const source = new Uint8Array([1, 2, 3]);

    const first = store.put(source);
    source[0] = 9;
    const loaded = store.get(first.contentId);
    loaded[1] = 9;

    expect(first).toMatchObject({ contentId: "content-1", byteLength: 3 });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get(first.contentId)).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.stats()).toEqual({ entryCount: 1, totalBytes: 3 });
  });

  it("rejects byte and entry overflow without evicting live content", () => {
    let nextId = 0;
    const store = new CodeContentStore({
      maximumBytes: 4,
      maximumEntries: 1,
      newContentId: () => `content-${++nextId}`,
    });
    const retained = store.put(new Uint8Array([1, 2, 3, 4]));

    expect(() => store.put(new Uint8Array([5]))).toThrowError(CodeContentStoreError);
    expect(store.get(retained.contentId)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(store.stats()).toEqual({ entryCount: 1, totalBytes: 4 });
  });

  it("purges one reference or the entire store deterministically", () => {
    let nextId = 0;
    const store = new CodeContentStore({
      maximumBytes: 8,
      maximumEntries: 2,
      newContentId: () => `content-${++nextId}`,
    });
    const first = store.put(new Uint8Array([1, 2]));
    const second = store.put(new Uint8Array([3, 4, 5]));

    expect(store.purge(first.contentId)).toBe(true);
    expect(store.purge(first.contentId)).toBe(false);
    expect(() => store.get(first.contentId)).toThrowError(CodeContentStoreError);
    expect(store.stats()).toEqual({ entryCount: 1, totalBytes: 3 });

    store.purgeAll();
    expect(() => store.get(second.contentId)).toThrowError(CodeContentStoreError);
    expect(store.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("rejects duplicate opaque IDs without replacing existing bytes", () => {
    const store = new CodeContentStore({
      maximumBytes: 8,
      maximumEntries: 2,
      newContentId: () => "same-id",
    });
    const first = store.put(new Uint8Array([1]));

    expect(() => store.put(new Uint8Array([2]))).toThrowError(CodeContentStoreError);
    expect(store.get(first.contentId)).toEqual(new Uint8Array([1]));
  });
});
