import { decodeCodeThreadId } from "@octant/contracts/code";
import { describe, expect, it } from "vitest";
import {
  CODE_DIFF_LAYOUT_STORAGE_KEY,
  readCodeDiffLayout,
  writeCodeDiffLayout,
} from "./codeDiffLayoutPreference";

const threadA = decodeCodeThreadId("80000000-0000-4000-8000-0000000000a1");
const threadB = decodeCodeThreadId("80000000-0000-4000-8000-0000000000a2");

describe("codeDiffLayoutPreference", () => {
  it("remembers each thread's layout and leaves the other alone", () => {
    const storage = memoryStorage();
    expect(readCodeDiffLayout(threadA, storage)).toBeUndefined();
    writeCodeDiffLayout(threadA, "side-by-side", storage);
    writeCodeDiffLayout(threadB, "unified", storage);
    expect(readCodeDiffLayout(threadA, storage)).toBe("side-by-side");
    expect(readCodeDiffLayout(threadB, storage)).toBe("unified");
  });

  it("falls back quietly when storage is missing or refuses", () => {
    expect(readCodeDiffLayout(threadA, undefined)).toBeUndefined();
    writeCodeDiffLayout(threadA, "side-by-side", undefined);
    expect(
      readCodeDiffLayout(threadA, memoryStorage({ [CODE_DIFF_LAYOUT_STORAGE_KEY]: "{broken" })),
    ).toBeUndefined();
    expect(
      readCodeDiffLayout(threadA, memoryStorage({ [CODE_DIFF_LAYOUT_STORAGE_KEY]: "[]" })),
    ).toBeUndefined();
    const refusing: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readCodeDiffLayout(threadA, refusing)).toBeUndefined();
    writeCodeDiffLayout(threadA, "side-by-side", refusing);
  });
});

function memoryStorage(initial: Readonly<Record<string, string>> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}
