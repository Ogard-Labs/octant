import { describe, expect, it } from "vitest";
import {
  MAX_MARKS,
  MAX_STROKE_POINTS,
  emptyMarkup,
  markupReducer,
  type Mark,
  type MarkupAction,
  type MarkupState,
} from "./markupModel";

const style = { ink: "red", width: 3 } as const;

function pen(id: string, points: ReadonlyArray<[number, number]>): Mark {
  return { ...style, id, kind: "pen", points: points.map(([x, y]) => ({ x, y })) };
}

function box(id: string, x: number, y: number, w: number, h: number): Mark {
  return { ...style, id, kind: "box", x, y, w, h };
}

function run(...actions: ReadonlyArray<MarkupAction>): MarkupState {
  return actions.reduce(markupReducer, emptyMarkup);
}

describe("the marks on a picture", () => {
  it("keeps a mark the person adds", () => {
    const state = run({ type: "add", mark: box("a", 10, 10, 40, 30) });
    expect(state.marks).toHaveLength(1);
    expect(state.past).toHaveLength(1);
  });

  it("keeps a box dragged up and to the left as a box with its top-left corner", () => {
    const state = run({ type: "add", mark: box("a", 50, 50, -20, -10) });
    expect(state.marks[0]).toMatchObject({ kind: "box", x: 30, y: 40, w: 20, h: 10 });
  });

  it("adds nothing for a click that drew no box, no line, no arrow and no words", () => {
    const state = run(
      { type: "add", mark: box("a", 10, 10, 0, 0) },
      { type: "add", mark: box("b", 10, 10, 2, 40) },
      { type: "add", mark: pen("c", [[5, 5]]) },
      {
        type: "add",
        mark: pen("d", [
          [5, 5],
          [5, 5],
        ]),
      },
      {
        type: "add",
        mark: { ...style, id: "e", kind: "arrow", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
      },
      { type: "add", mark: { ...style, id: "f", kind: "text", x: 1, y: 1, text: "   " } },
    );
    expect(state.marks).toHaveLength(0);
    expect(state.past).toHaveLength(0);
  });

  it("moves a mark as one step that undo puts back", () => {
    const added = run({
      type: "add",
      mark: pen("a", [
        [0, 0],
        [10, 10],
      ]),
    });
    const moved = markupReducer(added, { type: "move", id: "a", dx: 5, dy: -2 });
    expect(moved.marks[0]).toMatchObject({
      points: [
        { x: 5, y: -2 },
        { x: 15, y: 8 },
      ],
    });
    expect(markupReducer(moved, { type: "undo" }).marks).toEqual(added.marks);
  });

  it("ignores a move that goes nowhere", () => {
    const added = run({ type: "add", mark: box("a", 10, 10, 40, 30) });
    expect(markupReducer(added, { type: "move", id: "a", dx: 0, dy: 0 })).toBe(added);
  });

  it("deletes only the selected mark, and nothing when none is selected", () => {
    const two = run(
      { type: "add", mark: box("a", 10, 10, 40, 30) },
      { type: "add", mark: box("b", 60, 60, 40, 30) },
    );
    expect(markupReducer(two, { type: "remove-selected" })).toBe(two);
    const removed = run(
      { type: "add", mark: box("a", 10, 10, 40, 30) },
      { type: "add", mark: box("b", 60, 60, 40, 30) },
      { type: "select", id: "a" },
      { type: "remove-selected" },
    );
    expect(removed.marks.map((mark) => mark.id)).toEqual(["b"]);
    expect(removed.selectedId).toBeUndefined();
  });

  it("undoes and redoes marks in order", () => {
    const state = run(
      { type: "add", mark: box("a", 10, 10, 40, 30) },
      { type: "add", mark: box("b", 60, 60, 40, 30) },
      { type: "undo" },
    );
    expect(state.marks.map((mark) => mark.id)).toEqual(["a"]);
    expect(markupReducer(state, { type: "redo" }).marks.map((mark) => mark.id)).toEqual(["a", "b"]);
  });

  it("clears what could be redone when the person draws something new", () => {
    const state = run(
      { type: "add", mark: box("a", 10, 10, 40, 30) },
      { type: "undo" },
      { type: "add", mark: box("b", 60, 60, 40, 30) },
    );
    expect(state.future).toHaveLength(0);
    expect(markupReducer(state, { type: "redo" })).toBe(state);
  });

  it("does nothing when there is nothing to undo or redo", () => {
    expect(markupReducer(emptyMarkup, { type: "undo" })).toBe(emptyMarkup);
    expect(markupReducer(emptyMarkup, { type: "redo" })).toBe(emptyMarkup);
  });

  it("stops selecting a mark that undo took away", () => {
    const state = run(
      { type: "add", mark: box("a", 10, 10, 40, 30) },
      { type: "select", id: "a" },
      { type: "undo" },
    );
    expect(state.selectedId).toBeUndefined();
  });

  it("thins a long stroke to a bounded number of points and keeps both ends", () => {
    const points: Array<[number, number]> = Array.from({ length: 5_000 }, (_, index) => [
      index,
      index % 7,
    ]);
    const state = run({ type: "add", mark: pen("a", points) });
    const kept = state.marks[0];
    if (kept?.kind !== "pen") throw new Error("expected a pen mark");
    expect(kept.points.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    expect(kept.points[0]).toEqual({ x: 0, y: 0 });
    expect(kept.points[kept.points.length - 1]).toEqual({ x: 4_999, y: 4_999 % 7 });
  });

  it("refuses a mark past the cap on marks", () => {
    let state = emptyMarkup;
    for (let index = 0; index < MAX_MARKS + 5; index += 1) {
      state = markupReducer(state, { type: "add", mark: box(`m${String(index)}`, 1, 1, 20, 20) });
    }
    expect(state.marks).toHaveLength(MAX_MARKS);
  });
});
