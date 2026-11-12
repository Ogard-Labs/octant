import type { MarkupInkId } from "../theme/markupInk";

/** A position in the picture's own pixels, not the screen's. */
export interface MarkupPoint {
  readonly x: number;
  readonly y: number;
}

interface MarkBase {
  readonly id: string;
  readonly ink: MarkupInkId;
  /** The line width in picture pixels; text takes its size from it. */
  readonly width: number;
}

export interface PenMark extends MarkBase {
  readonly kind: "pen";
  readonly points: ReadonlyArray<MarkupPoint>;
}

export interface BoxMark extends MarkBase {
  readonly kind: "box";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ArrowMark extends MarkBase {
  readonly kind: "arrow";
  readonly from: MarkupPoint;
  readonly to: MarkupPoint;
}

export interface TextMark extends MarkBase {
  readonly kind: "text";
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

export type Mark = PenMark | BoxMark | ArrowMark | TextMark;

/** A picture cannot grow without bound: marks, points in a stroke, and text. */
export const MAX_MARKS = 200;
export const MAX_STROKE_POINTS = 300;
export const MAX_MARK_TEXT = 200;
/** Undo reaches back this far; older steps are forgotten. */
const MAX_HISTORY = 200;
/** Below these a drag was a click: it drew nothing the person could see. */
const MIN_BOX_EDGE = 4;
const MIN_ARROW_LENGTH = 8;

export interface MarkupState {
  readonly marks: ReadonlyArray<Mark>;
  readonly selectedId: string | undefined;
  readonly past: ReadonlyArray<ReadonlyArray<Mark>>;
  readonly future: ReadonlyArray<ReadonlyArray<Mark>>;
}

export type MarkupAction =
  | { readonly type: "add"; readonly mark: Mark }
  | { readonly type: "move"; readonly id: string; readonly dx: number; readonly dy: number }
  | { readonly type: "remove-selected" }
  | { readonly type: "select"; readonly id: string | undefined }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

export const emptyMarkup: MarkupState = {
  marks: [],
  selectedId: undefined,
  past: [],
  future: [],
};

export function markupReducer(state: MarkupState, action: MarkupAction): MarkupState {
  switch (action.type) {
    case "add": {
      if (state.marks.length >= MAX_MARKS) return state;
      const mark = settledMark(action.mark);
      return mark === undefined ? state : commit(state, [...state.marks, mark]);
    }
    case "move": {
      if (action.dx === 0 && action.dy === 0) return state;
      if (!state.marks.some((mark) => mark.id === action.id)) return state;
      return commit(
        state,
        state.marks.map((mark) =>
          mark.id === action.id ? translateMark(mark, action.dx, action.dy) : mark,
        ),
      );
    }
    case "remove-selected": {
      if (state.selectedId === undefined) return state;
      const next = state.marks.filter((mark) => mark.id !== state.selectedId);
      return next.length === state.marks.length
        ? state
        : { ...commit(state, next), selectedId: undefined };
    }
    case "select":
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return {
        marks: previous,
        selectedId: keepSelection(state.selectedId, previous),
        past: state.past.slice(0, -1),
        future: [...state.future, state.marks],
      };
    }
    case "redo": {
      const next = state.future[state.future.length - 1];
      if (next === undefined) return state;
      return {
        marks: next,
        selectedId: keepSelection(state.selectedId, next),
        past: [...state.past, state.marks],
        future: state.future.slice(0, -1),
      };
    }
  }
}

/** A new step: it clears redo, because the person drew something else instead. */
function commit(state: MarkupState, marks: ReadonlyArray<Mark>): MarkupState {
  return {
    marks,
    selectedId: keepSelection(state.selectedId, marks),
    past: [...state.past, state.marks].slice(-MAX_HISTORY),
    future: [],
  };
}

function keepSelection(
  selectedId: string | undefined,
  marks: ReadonlyArray<Mark>,
): string | undefined {
  return marks.some((mark) => mark.id === selectedId) ? selectedId : undefined;
}

/** The mark as it will be kept, or undefined when it drew nothing. */
function settledMark(mark: Mark): Mark | undefined {
  switch (mark.kind) {
    case "pen": {
      const points = decimateStroke(distinctPoints(mark.points), MAX_STROKE_POINTS);
      return points.length < 2 ? undefined : { ...mark, points };
    }
    case "box": {
      const w = Math.abs(mark.w);
      const h = Math.abs(mark.h);
      if (w < MIN_BOX_EDGE || h < MIN_BOX_EDGE) return undefined;
      return {
        ...mark,
        x: Math.min(mark.x, mark.x + mark.w),
        y: Math.min(mark.y, mark.y + mark.h),
        w,
        h,
      };
    }
    case "arrow":
      return Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) < MIN_ARROW_LENGTH
        ? undefined
        : mark;
    case "text": {
      const text = mark.text.trim().slice(0, MAX_MARK_TEXT);
      return text === "" ? undefined : { ...mark, text };
    }
  }
}

function distinctPoints(points: ReadonlyArray<MarkupPoint>): ReadonlyArray<MarkupPoint> {
  const kept: MarkupPoint[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last === undefined || last.x !== point.x || last.y !== point.y) kept.push(point);
  }
  return kept;
}

/** Evenly thinned to `max` points, always keeping the stroke's first and last. */
export function decimateStroke(
  points: ReadonlyArray<MarkupPoint>,
  max: number,
): ReadonlyArray<MarkupPoint> {
  if (points.length <= max || max < 2) return points;
  const kept: MarkupPoint[] = [];
  for (let index = 0; index < max; index += 1) {
    const point = points[Math.round((index * (points.length - 1)) / (max - 1))];
    if (point !== undefined) kept.push(point);
  }
  return kept;
}

export function translateMark(mark: Mark, dx: number, dy: number): Mark {
  switch (mark.kind) {
    case "pen":
      return { ...mark, points: mark.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "box":
    case "text":
      return { ...mark, x: mark.x + dx, y: mark.y + dy };
    case "arrow":
      return {
        ...mark,
        from: { x: mark.from.x + dx, y: mark.from.y + dy },
        to: { x: mark.to.x + dx, y: mark.to.y + dy },
      };
  }
}
