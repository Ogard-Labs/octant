/**
 * The inks a person marks up a Browser picture with. They are drawn into a
 * picture that leaves the app as a PNG, so they are not interface colours: they
 * stay the same in every theme and mode, and a red box on a white page must be
 * the same red a model reads in the attached image. Literal values live in code
 * for the same reason the accent swatches do.
 */
export interface MarkupInk {
  readonly id: "red" | "yellow" | "green" | "blue" | "white" | "black";
  readonly label: string;
  readonly value: string;
  /** The thin line drawn around text in this ink so it reads on any page. */
  readonly outline: string;
}

const LIGHT_OUTLINE = "#ffffff";
const DARK_OUTLINE = "#111111";

const RED: MarkupInk = { id: "red", label: "Red", value: "#e5322d", outline: LIGHT_OUTLINE };

export const MARKUP_INKS: ReadonlyArray<MarkupInk> = [
  RED,
  { id: "yellow", label: "Yellow", value: "#f5c400", outline: DARK_OUTLINE },
  { id: "green", label: "Green", value: "#1f9d4d", outline: LIGHT_OUTLINE },
  { id: "blue", label: "Blue", value: "#2563eb", outline: LIGHT_OUTLINE },
  { id: "white", label: "White", value: "#ffffff", outline: DARK_OUTLINE },
  { id: "black", label: "Black", value: "#111111", outline: LIGHT_OUTLINE },
];

export type MarkupInkId = MarkupInk["id"];

/** Red: the colour a person reaches for to point at something on a page. */
export const DEFAULT_MARKUP_INK: MarkupInkId = "red";

export function markupInk(id: MarkupInkId): MarkupInk {
  return MARKUP_INKS.find((ink) => ink.id === id) ?? RED;
}
