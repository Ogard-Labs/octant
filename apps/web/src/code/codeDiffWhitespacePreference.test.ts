import { describe, expect, it } from "vitest";
import {
  readCodeDiffIgnoreWhitespace,
  writeCodeDiffIgnoreWhitespace,
} from "./codeDiffWhitespacePreference";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("diff whitespace preference", () => {
  it("shows whitespace until the person chooses otherwise, then remembers it", () => {
    const storage = memory();
    expect(readCodeDiffIgnoreWhitespace(storage)).toBe(false);
    writeCodeDiffIgnoreWhitespace(true, storage);
    expect(readCodeDiffIgnoreWhitespace(storage)).toBe(true);
    writeCodeDiffIgnoreWhitespace(false, storage);
    expect(readCodeDiffIgnoreWhitespace(storage)).toBe(false);
  });

  it("falls back to showing whitespace when storage refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readCodeDiffIgnoreWhitespace(refusing)).toBe(false);
    expect(() => writeCodeDiffIgnoreWhitespace(true, refusing)).not.toThrow();
  });
});
