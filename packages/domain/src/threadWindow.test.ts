import { describe, expect, it } from "vitest";
import { prependEarlierTurns, refreshNewestTurns } from "./threadWindow";

interface Turn {
  readonly id: string;
  readonly text: string;
}

const key = (turn: Turn) => turn.id;
const turn = (id: string, text = id): Turn => ({ id, text });

describe("thread windows", () => {
  it("prepends an earlier page above the loaded turns", () => {
    const loaded = [turn("c"), turn("d")];
    expect(prependEarlierTurns(loaded, [turn("a"), turn("b")], key).map(key)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("does not repeat a turn the earlier page shares with what is loaded", () => {
    const loaded = [turn("b"), turn("c")];
    expect(prependEarlierTurns(loaded, [turn("a"), turn("b")], key).map(key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("splices the newest window onto loaded history when its first turn is already loaded", () => {
    const loaded = [turn("a"), turn("b"), turn("c")];
    const refreshed = refreshNewestTurns(
      loaded,
      [turn("b"), turn("c", "c settled"), turn("d")],
      key,
    );
    expect(refreshed.kind).toBe("spliced");
    expect(refreshed.turns.map(key)).toEqual(["a", "b", "c", "d"]);
    expect(refreshed.turns[2]?.text).toBe("c settled");
  });

  it("replaces loaded history when the newest window starts at a turn it does not hold", () => {
    const loaded = [turn("a"), turn("b")];
    const refreshed = refreshNewestTurns(loaded, [turn("x"), turn("y")], key);
    expect(refreshed.kind).toBe("replaced");
    expect(refreshed.turns.map(key)).toEqual(["x", "y"]);
  });

  it("drops a loaded suffix the newest window no longer holds", () => {
    const loaded = [turn("a"), turn("b"), turn("stale"), turn("gone")];
    const refreshed = refreshNewestTurns(loaded, [turn("b"), turn("c")], key);
    expect(refreshed.kind).toBe("spliced");
    expect(refreshed.turns.map(key)).toEqual(["a", "b", "c"]);
  });

  it("replaces loaded history with an empty newest window", () => {
    const refreshed = refreshNewestTurns([turn("a")], [], key);
    expect(refreshed).toEqual({ kind: "replaced", turns: [] });
  });
});
