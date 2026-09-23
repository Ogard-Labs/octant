import { describe, expect, it } from "vitest";
import {
  lastUsefulView,
  readStoredBoolean,
  readStoredValue,
  type BoardStorage,
  type ThreadBoardState,
} from "./threadBoardState";

function memoryStorage(initial: Record<string, string> = {}): BoardStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("thread board state helpers", () => {
  it("rejects an unknown stored value", () => {
    expect(
      readStoredValue(memoryStorage({ grouping: "unknown" }), "grouping", (value) =>
        value === "status" || value === "project" ? value : undefined,
      ),
    ).toBeUndefined();
  });

  it("round-trips a stored boolean", () => {
    const storage = memoryStorage();
    storage.setItem("show-empty-groups", "true");

    expect(readStoredBoolean(storage, "show-empty-groups")).toBe(true);
  });

  it("returns the stale view from an error state", () => {
    const board: ThreadBoardState<{ readonly cards: readonly string[] }> = {
      status: "error",
      message: "refresh failed",
      view: { cards: ["stale"] },
    };

    expect(lastUsefulView(board)).toEqual({ cards: ["stale"] });
  });
});
