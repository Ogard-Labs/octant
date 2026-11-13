import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_ROLE_IDS,
} from "@octant/theme/tokens";

/**
 * Generates the portable design tokens (`tokens.css`, `tokens.json`) from the
 * renderer's own stylesheets and the theme package, so a website or another
 * app can read the values the app draws with instead of copying them.
 *
 * Nothing here holds a design value. The stylesheets own every value; this
 * file owns only which tokens are exported and how they are grouped. Run
 * `bun run tokens:export` to regenerate and `bun run tokens:check` to prove
 * the committed files are current.
 */

export type Mode = "dark" | "light";

export interface Declaration {
  readonly name: string;
  readonly value: string;
  readonly file: string;
}

export interface CssBlock {
  readonly selector: string;
  readonly body: string;
}

/** A custom property after the cascade: its expression in each mode. */
export interface SourceToken {
  readonly name: string;
  readonly dark: string;
  readonly light: string;
  readonly file: string;
}

export class TokenExportError extends Error {}

// ─── CSS reading ───────────────────────────────────────────────────────────

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The rules at depth zero. Rules inside an at-rule are not tokens of the root. */
export function topLevelBlocks(css: string): ReadonlyArray<CssBlock> {
  const text = stripComments(css);
  const blocks: CssBlock[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      if (depth === 0) {
        selector = text.slice(selectorStart, index).trim();
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ selector, body: text.slice(bodyStart, index) });
        selectorStart = index + 1;
      }
    } else if (char === ";" && depth === 0) {
      // `@import "x";` is a statement, not a block.
      selectorStart = index + 1;
    }
  }
  return blocks;
}

/** Splits on a separator that is outside every pair of parentheses and quotes. */
export function splitTopLevel(text: string, separator: string): ReadonlyArray<string> {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The custom properties a block declares. A name declared twice in one block is an error. */
export function blockDeclarations(block: CssBlock, file: string): ReadonlyArray<Declaration> {
  const seen = new Set<string>();
  const declarations: Declaration[] = [];
  for (const piece of splitTopLevel(block.body, ";")) {
    const colon = piece.indexOf(":");
    if (colon < 0) continue;
    const name = piece.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    if (seen.has(name)) {
      throw new TokenExportError(`${file}: ${name} is declared twice in \`${block.selector}\``);
    }
    seen.add(name);
    declarations.push({ name, value: squash(piece.slice(colon + 1)), file });
  }
  return declarations;
}

// ─── value reading ─────────────────────────────────────────────────────────

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new TokenExportError(`unbalanced parentheses in \`${text}\``);
}

/** Replaces each `light-dark(a, b)` with the argument for the mode. */
export function pickLightDark(value: string, mode: Mode): string {
  let result = value;
  for (;;) {
    const start = result.indexOf("light-dark(");
    if (start < 0) return result;
    const open = start + "light-dark".length;
    const close = matchingParen(result, open);
    const args = splitTopLevel(result.slice(open + 1, close), ",");
    if (args.length !== 2) {
      throw new TokenExportError(
        `light-dark() needs a light and a dark value, found ${String(args.length)} in \`${value}\``,
      );
    }
    const chosen = squash((mode === "light" ? args[0] : args[1]) ?? "");
    result = result.slice(0, start) + chosen + result.slice(close + 1);
  }
}

export interface CascadeBlock {
  readonly declarations: ReadonlyArray<Declaration>;
  /** A `both` block sets the two modes; a `light` block overrides light only. */
  readonly applies: "both" | "light";
}

/**
 * Applies the `both` blocks in cascade order, then the `light` blocks. A light
 * selector (`html[data-octant-theme-mode="light"]`) outranks `:root` by
 * specificity whatever the file order, so its value wins in light even when a
 * `:root` block that follows redeclares the token.
 */
export function cascade(blocks: ReadonlyArray<CascadeBlock>): ReadonlyMap<string, SourceToken> {
  const tokens = new Map<string, SourceToken>();
  for (const block of blocks.filter((candidate) => candidate.applies === "both")) {
    for (const declaration of block.declarations) {
      tokens.set(declaration.name, {
        name: declaration.name,
        dark: pickLightDark(declaration.value, "dark"),
        light: pickLightDark(declaration.value, "light"),
        file: declaration.file,
      });
    }
  }
  for (const block of blocks.filter((candidate) => candidate.applies === "light")) {
    for (const declaration of block.declarations) {
      const previous = tokens.get(declaration.name);
      if (previous === undefined) {
        throw new TokenExportError(
          `${declaration.file}: ${declaration.name} has a light override but no base value`,
        );
      }
      tokens.set(declaration.name, {
        ...previous,
        light: pickLightDark(declaration.value, "light"),
      });
    }
  }
  return tokens;
}

// ─── colour and length arithmetic ──────────────────────────────────────────

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const NAMED: Readonly<Record<string, Rgba>> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function channel(text: string, scale: number): number {
  const trimmed = text.trim();
  return trimmed.endsWith("%") ? (parseFloat(trimmed) / 100) * scale : parseFloat(trimmed);
}

export function parseColor(text: string): Rgba | undefined {
  const value = text.trim().toLowerCase();
  const named = NAMED[value];
  if (named !== undefined) return named;
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1];
  if (hex !== undefined) {
    const full =
      hex.length <= 4
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    if (full.length !== 6 && full.length !== 8) return undefined;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  if (fn !== undefined) {
    const [colour = "", alpha] = fn.includes("/") ? fn.split("/") : [fn, undefined];
    const parts = colour.includes(",") ? colour.split(",") : colour.trim().split(/\s+/);
    const channels = alpha === undefined && parts.length === 4 ? parts.slice(0, 3) : parts;
    const alphaText = alpha ?? (parts.length === 4 ? parts[3] : undefined);
    if (channels.length !== 3) return undefined;
    const [r = "", g = "", b = ""] = channels;
    const parsed = {
      r: channel(r, 255),
      g: channel(g, 255),
      b: channel(b, 255),
      a: alphaText === undefined ? 1 : channel(alphaText, 1),
    };
    return Object.values(parsed).some(Number.isNaN) ? undefined : parsed;
  }
  return undefined;
}

type Triple = readonly [number, number, number];

function toLinear(component: number): number {
  const value = component / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return encoded * 255;
}

function toOklab({ r, g, b }: Rgba): Triple {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([lightness, a, b]: Triple, alpha: number): Rgba {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  };
}

export function formatColor(colour: Rgba): string {
  const byte = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));
  const [r, g, b] = [byte(colour.r), byte(colour.g), byte(colour.b)];
  const alpha = Math.round(colour.a * 1000) / 1000;
  if (alpha >= 1) {
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  }
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(alpha)})`;
}

/** `color-mix(in oklab|srgb, A p%, B p%)` over colours that are already literal. */
export function mixColors(call: string): string | undefined {
  const inner = /^color-mix\((.*)\)$/s.exec(call.trim())?.[1];
  if (inner === undefined) return undefined;
  const [spaceText = "", ...operands] = splitTopLevel(inner, ",");
  const space = /^\s*in\s+(oklab|srgb)\s*$/.exec(spaceText)?.[1];
  if (space === undefined || operands.length !== 2) return undefined;
  const parsed = operands.map((operand) => {
    const percent = /\s+(\d*\.?\d+)%\s*$/.exec(operand);
    const colourText = percent === null ? operand : operand.slice(0, percent.index);
    const colour = parseColor(foldStatic(colourText.trim()));
    return colour === undefined
      ? undefined
      : { colour, percent: percent === null ? undefined : parseFloat(percent[1] ?? "") };
  });
  const [first, second] = parsed;
  if (first === undefined || second === undefined) return undefined;
  let p1 = first.percent;
  let p2 = second.percent;
  if (p1 === undefined && p2 === undefined) {
    p1 = 50;
    p2 = 50;
  } else if (p1 === undefined) p1 = 100 - (p2 ?? 0);
  else if (p2 === undefined) p2 = 100 - p1;
  const total = p1 + (p2 ?? 0);
  if (total <= 0) return undefined;
  const w1 = p1 / total;
  const w2 = (p2 ?? 0) / total;
  const alphaScale = total < 100 ? total / 100 : 1;
  const coordinates = (colour: Rgba): Triple =>
    space === "oklab" ? toOklab(colour) : [colour.r, colour.g, colour.b];
  const c1 = coordinates(first.colour);
  const c2 = coordinates(second.colour);
  const alpha = w1 * first.colour.a + w2 * second.colour.a;
  const blend = (index: 0 | 1 | 2): number =>
    alpha === 0 ? 0 : (w1 * c1[index] * first.colour.a + w2 * c2[index] * second.colour.a) / alpha;
  const mixed: Triple = [blend(0), blend(1), blend(2)];
  const outcome =
    space === "oklab"
      ? fromOklab(mixed, alpha * alphaScale)
      : { r: mixed[0], g: mixed[1], b: mixed[2], a: alpha * alphaScale };
  return formatColor(outcome);
}

interface Quantity {
  readonly n: number;
  readonly unit: string;
}

/** A `calc()` over lengths and numbers; undefined when it needs the browser (mixed units, viewport). */
export function evaluateCalc(call: string): string | undefined {
  const inner = /^calc\((.*)\)$/s.exec(call.trim())?.[1];
  if (inner === undefined) return undefined;
  const tokens = inner.match(/calc\(|\(|\)|[*/+]|(?<![\w.)])-?\d*\.?\d+[a-z%]*|\s+-\s+|\S+/g);
  if (tokens === null) return undefined;
  let position = 0;
  const peek = (): string | undefined => tokens[position]?.trim();
  const next = (): string | undefined => tokens[position++]?.trim();
  const fail = (): never => {
    throw new TokenExportError("not statically evaluable");
  };
  const primary = (): Quantity => {
    const token = next();
    if (token === undefined) return fail();
    if (token === "(" || token === "calc(") {
      const value = sum();
      if (next() !== ")") fail();
      return value;
    }
    const match = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(token);
    if (match === null) return fail();
    return { n: parseFloat(match[1] ?? ""), unit: match[2] ?? "" };
  };
  const product = (): Quantity => {
    let value = primary();
    while (peek() === "*" || peek() === "/") {
      const operator = next();
      const right = primary();
      if (operator === "*") {
        if (value.unit !== "" && right.unit !== "") fail();
        value = { n: value.n * right.n, unit: value.unit || right.unit };
      } else {
        if (right.unit !== "" || right.n === 0) fail();
        value = { n: value.n / right.n, unit: value.unit };
      }
    }
    return value;
  };
  const sum = (): Quantity => {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      const operator = next();
      const right = product();
      if (value.unit !== right.unit) fail();
      value = { n: operator === "+" ? value.n + right.n : value.n - right.n, unit: value.unit };
    }
    return value;
  };
  try {
    const result = sum();
    if (position !== tokens.length) return undefined;
    return `${String(Math.round(result.n * 10000) / 10000)}${result.unit}`;
  } catch (error) {
    if (error instanceof TokenExportError) return undefined;
    throw error;
  }
}

/** Replaces every `calc()` and `color-mix()` that can be computed without a browser. */
export function foldStatic(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const rest = value.slice(index);
    const call = /^(calc|color-mix)\(/.exec(rest);
    const previous = value[index - 1] ?? "";
    if (call !== null && !/[\w-]/.test(previous)) {
      const close = matchingParen(value, index + (call[1] ?? "").length);
      const expression = value.slice(index, close + 1);
      const folded = call[1] === "calc" ? evaluateCalc(expression) : mixColors(expression);
      result += folded ?? expression;
      index = close + 1;
    } else {
      result += value[index];
      index += 1;
    }
  }
  return result;
}

// ─── reference resolution ──────────────────────────────────────────────────

const VAR_PATTERN = /var\(/;

/** Names a value reads through `var()`. */
export function referencesOf(value: string): ReadonlyArray<string> {
  const names: string[] = [];
  let rest = value;
  for (let start = rest.search(VAR_PATTERN); start >= 0; start = rest.search(VAR_PATTERN)) {
    const open = start + 3;
    const close = matchingParen(rest, open);
    const [name = "", ...fallback] = splitTopLevel(rest.slice(open + 1, close), ",");
    names.push(name.trim());
    names.push(...referencesOf(fallback.join(",")));
    rest = rest.slice(close + 1);
  }
  return names;
}

export class TokenResolver {
  readonly #tokens: ReadonlyMap<string, SourceToken>;
  readonly #memo = new Map<string, string>();

  constructor(tokens: ReadonlyMap<string, SourceToken>) {
    this.#tokens = tokens;
  }

  /** The value with every `var()` replaced and every computable expression folded. */
  resolve(name: string, mode: Mode, trail: ReadonlyArray<string> = []): string {
    const key = `${mode}:${name}`;
    const known = this.#memo.get(key);
    if (known !== undefined) return known;
    const token = this.#tokens.get(name);
    if (token === undefined) {
      throw new TokenExportError(`unresolved reference ${name}`);
    }
    if (trail.includes(name)) {
      throw new TokenExportError(`circular reference ${[...trail, name].join(" -> ")}`);
    }
    const value = this.#substitute(token[mode], mode, [...trail, name], name);
    const folded = foldStatic(value);
    this.#memo.set(key, folded);
    return folded;
  }

  #substitute(value: string, mode: Mode, trail: ReadonlyArray<string>, owner: string): string {
    let result = value;
    for (let start = result.search(VAR_PATTERN); start >= 0; start = result.search(VAR_PATTERN)) {
      const open = start + 3;
      const close = matchingParen(result, open);
      const [reference = "", ...fallback] = splitTopLevel(result.slice(open + 1, close), ",");
      const name = reference.trim();
      let replacement: string;
      if (this.#tokens.has(name)) replacement = this.resolve(name, mode, trail);
      else if (fallback.length > 0) {
        replacement = this.#substitute(fallback.join(",").trim(), mode, trail, owner);
      } else {
        throw new TokenExportError(`unresolved reference ${name} in ${owner}`);
      }
      result = result.slice(0, start) + replacement + result.slice(close + 1);
    }
    return result;
  }
}

// ─── what is exported ──────────────────────────────────────────────────────

export interface Group {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

/** Names the app uses for its own chrome, not for a site or another app. */
export const NOT_EXPORTED: RegExp =
  /^--(?:octant-sidebar-translucent|octant-wide-|octant-context-)/;

/**
 * Group membership is the only judgement this file holds: which of the app's
 * custom properties are foundations a consumer needs. The first matching group
 * wins, and a token that matches none stays in the app.
 */
export const GROUPS: ReadonlyArray<Group> = [
  {
    id: "color-surface",
    label: "Surfaces: the page, cards, floating surfaces, controls and the chosen row",
    pattern:
      /^--(?:oct-(?:bg|surface|surface-warm|selection|fill-\d|fg-soft)|octant-(?:app-background|workspace|surface(?:-canvas|-muted|-hover|-selected|-raised|-inset)?|chrome|sidebar|sidebar-opaque|floating|control|control-hover|control-pressed|card|well|float|float-control|float-hover|float-pressed|float-line|selection))$/,
  },
  {
    id: "color-ink",
    label: "Ink: text and icon colours",
    pattern: /^--(?:oct-(?:fg|fg-2|muted|meta)|octant-(?:text-[a-z-]+|primary-foreground))$/,
  },
  {
    id: "color-border",
    label: "Borders and hairlines",
    pattern:
      /^--(?:oct-(?:border|border-soft|hairline|hairline-strong)|octant-(?:border[a-z-]*|divider-strong))$/,
  },
  {
    id: "color-accent",
    label: "Accent: the action colour and its states",
    pattern: /^--(?:oct-accent[a-z-]*|octant-accent[a-z-]*)$/,
  },
  {
    id: "color-status",
    label: "Status: success, warning, danger and diff colours",
    pattern:
      /^--(?:oct-(?:success|warn|danger)[a-z-]*|octant-(?:success|warning|danger|destructive|addition|deletion)[a-z-]*)$/,
  },
  {
    id: "color-palette",
    label: "Named hues and the categorical chart series",
    pattern: /^--(?:octant-palette-[a-z]+|oct-series-\d)$/,
  },
  {
    id: "focus",
    label: "Keyboard focus edge",
    pattern: /^--(?:oct-focus-[a-z-]+|octant-focus(?:-ring)?)$/,
  },
  {
    id: "type-family",
    label: "Type: families",
    pattern: /^--(?:oct-font-[a-z]+|octant-(?:ui|editor|terminal)-font-family)$/,
  },
  {
    id: "type-size",
    label: "Type: sizes (the scale follows the interface size setting)",
    pattern:
      /^--(?:oct-(?:text-[a-z0-9-]+|fs-h\d|transcript-font-size)|octant-(?:ui|editor|terminal)-font-size)$/,
  },
  {
    id: "type-weight",
    label: "Type: weights",
    pattern: /^--(?:oct-weight-[a-z]+|octant-(?:ui|editor|terminal)-font-weight)$/,
  },
  {
    id: "type-leading",
    label: "Type: line heights",
    pattern: /^--(?:oct-leading-[a-z]+|octant-(?:editor|terminal)-line-height)$/,
  },
  {
    id: "type-tracking",
    label: "Type: letter spacing",
    pattern: /^--oct-tracking-[a-z]+$/,
  },
  {
    id: "type-role",
    label: "Type roles: one recipe per kind of text, read from the stylesheet's role classes",
    pattern: /^--oct-role-[a-z-]+$/,
  },
  { id: "space", label: "Spacing scale", pattern: /^--oct-space-\d+$/ },
  {
    id: "size",
    label: "Control, row and avatar sizes",
    pattern:
      /^--oct-(?:control-height(?:-sm)?|menu-row-h|menu-row-inset|menu-inset|nav-row-h|nav-inset|rail-button-h|rail-tab-h|title-rail-h|touch-min|avatar-[a-z]+|surface-header-h)$/,
  },
  { id: "opacity", label: "Opacity", pattern: /^--oct-disabled-opacity$/ },
  { id: "radius", label: "Radii", pattern: /^--oct-radius-[a-z-]+$/ },
  { id: "icon", label: "Icon sizes", pattern: /^--oct-icon-[a-z]+$/ },
  {
    id: "elevation",
    label: "Elevation: the shadow recipes for a control, a card, a well and a floating surface",
    pattern: /^--(?:oct-elev-[a-z]+|octant-shadow-[a-z-]+)$/,
  },
  {
    id: "material",
    label: "Material: bevels, glass and the wash behind a dialog",
    pattern:
      /^--(?:octant-(?:bevel|bevel-strong|glass-[a-z-]+|float-(?:glass|sheen|blur)|scrim)|oct-(?:glass-[a-z-]+|scrim|sheen))$/,
  },
  {
    id: "motion",
    label: "Motion: durations and easings",
    pattern: /^--oct-(?:motion-[a-z]+|dur-[a-z]+|ease-[a-z]+)$/,
  },
  {
    id: "layout",
    label: "Page layout: containers, gutters, measures, breakpoints and layers",
    pattern:
      /^--oct-(?:container-[a-z-]+|gutter|surface-measure|surface-gutter|sidebar-w|dock-w|bp-[a-z]+|z-[a-z]+)$/,
  },
];

/** The role classes of surface.css that carry the type hierarchy. */
export const TYPE_ROLE_CLASSES: ReadonlyArray<{
  readonly selector: string;
  readonly role: string;
}> = [
  { selector: ".oct-title", role: "title" },
  { selector: ".oct-title--hero", role: "title-hero" },
  { selector: ".oct-page-title", role: "page-title" },
  { selector: ".oct-section-label", role: "section-label" },
  { selector: ".oct-row-label", role: "row-label" },
  { selector: ".oct-row-detail", role: "row-detail" },
  { selector: ".oct-meta", role: "meta" },
  { selector: ".oct-meta--mono", role: "meta-mono" },
];

const ROLE_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ["font-family", "family"],
  ["font-size", "size"],
  ["font-weight", "weight"],
  ["letter-spacing", "tracking"],
  ["line-height", "leading"],
];

/** Type role recipes, as custom properties, read from the role classes. */
export function typeRoleDeclarations(css: string, file: string): ReadonlyArray<Declaration> {
  const blocks = topLevelBlocks(css);
  const declarations: Declaration[] = [];
  for (const { selector, role } of TYPE_ROLE_CLASSES) {
    const block = blocks.find((candidate) => candidate.selector === selector);
    if (block === undefined) {
      throw new TokenExportError(`${file}: type role class ${selector} is missing`);
    }
    const body = new Map<string, string>();
    for (const piece of splitTopLevel(block.body, ";")) {
      const colon = piece.indexOf(":");
      if (colon > 0) body.set(piece.slice(0, colon).trim(), squash(piece.slice(colon + 1)));
    }
    for (const [property, suffix] of ROLE_PROPERTIES) {
      const value = body.get(property);
      if (value !== undefined) {
        declarations.push({ name: `--oct-role-${role}-${suffix}`, value, file });
      }
    }
  }
  return declarations;
}

export interface ExportedToken {
  readonly name: string;
  readonly group: string;
  readonly dark: string;
  readonly light: string;
  readonly darkResolved: string;
  readonly lightResolved: string;
  readonly file: string;
  readonly support: boolean;
}

/** Every token to export, with the tokens an exported value reads pulled in as support. */
export function selectExports(
  tokens: ReadonlyMap<string, SourceToken>,
  groups: ReadonlyArray<Group> = GROUPS,
): ReadonlyArray<ExportedToken> {
  const resolver = new TokenResolver(tokens);
  const groupOf = (name: string): string | undefined =>
    NOT_EXPORTED.test(name) ? undefined : groups.find((group) => group.pattern.test(name))?.id;
  const chosen = new Map<string, { group: string; support: boolean }>();
  for (const name of tokens.keys()) {
    const group = groupOf(name);
    if (group !== undefined) chosen.set(name, { group, support: false });
  }
  const queue = [...chosen.keys()];
  for (let index = 0; index < queue.length; index += 1) {
    const token = tokens.get(queue[index] ?? "");
    if (token === undefined) continue;
    for (const reference of [...referencesOf(token.dark), ...referencesOf(token.light)]) {
      if (chosen.has(reference)) continue;
      if (!tokens.has(reference)) {
        throw new TokenExportError(`unresolved reference ${reference} in ${token.name}`);
      }
      chosen.set(reference, { group: groupOf(reference) ?? "support", support: true });
      queue.push(reference);
    }
  }
  const order = [...groups.map((group) => group.id), "support"];
  const exported: ExportedToken[] = [];
  for (const [name, { group, support }] of chosen) {
    const token = tokens.get(name);
    if (token === undefined) continue;
    exported.push({
      name,
      group,
      dark: token.dark,
      light: token.light,
      darkResolved: resolver.resolve(name, "dark"),
      lightResolved: resolver.resolve(name, "light"),
      file: token.file,
      support,
    });
  }
  return exported.sort(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name, "en"),
  );
}

// ─── theme package agreement ───────────────────────────────────────────────

/**
 * The theme package owns the colour roles' defaults and the stylesheet carries
 * a first-paint copy of them. A role whose two copies differ is a stale token,
 * so the export refuses to pick one.
 */
export function checkThemeAgreement(
  tokens: ReadonlyMap<string, SourceToken>,
  roles: ReadonlyArray<string>,
  defaults: Readonly<Record<Mode, Readonly<Record<string, string>>>>,
): ReadonlyArray<string> {
  const resolver = new TokenResolver(tokens);
  const problems: string[] = [];
  for (const id of roles) {
    const name = `--octant-${id}`;
    for (const mode of ["dark", "light"] as const) {
      const fromTheme = defaults[mode][id];
      if (fromTheme === undefined || fromTheme === "") {
        problems.push(`theme role ${id} has no ${mode} default`);
        continue;
      }
      if (!tokens.has(name)) continue;
      const fromStylesheet = resolver.resolve(name, mode);
      if (
        /^#[0-9a-f]{6}$/i.test(fromTheme) &&
        fromStylesheet.toLowerCase() !== fromTheme.toLowerCase()
      ) {
        problems.push(
          `${name} is ${fromStylesheet} in the ${mode} stylesheet but the theme package says ${fromTheme}`,
        );
      }
    }
  }
  return problems;
}

// ─── output ────────────────────────────────────────────────────────────────

export const REGENERATE = "bun run tokens:export";

function header(sources: ReadonlyArray<string>): string {
  return [
    "/* Octant design tokens. Generated; do not edit.",
    ` * Regenerate with \`${REGENERATE}\`. Sources:`,
    ...sources.map((source) => ` *   ${source}`),
    " *",
    ' * Dark is the default. Light applies under [data-theme="light"], and under the',
    ' * system preference unless [data-theme="dark"] is set. A token that refers to',
    " * another keeps the reference, so it follows whichever mode is active. */",
  ].join("\n");
}

export function renderCss(
  exported: ReadonlyArray<ExportedToken>,
  sources: ReadonlyArray<string>,
  groups: ReadonlyArray<Group> = GROUPS,
): string {
  const labels = new Map(groups.map((group) => [group.id, group.label]));
  labels.set("support", "Support: tokens an exported value reads");
  const dark: string[] = [];
  let current = "";
  for (const token of exported) {
    if (token.group !== current) {
      current = token.group;
      dark.push(`  /* ── ${labels.get(current) ?? current} ── */`);
    }
    dark.push(`  ${token.name}: ${token.dark};`);
  }
  const light = exported
    .filter((token) => token.light !== token.dark)
    .map((token) => `  ${token.name}: ${token.light};`);
  return `${[
    header(sources),
    "",
    ":root {",
    "  color-scheme: dark;",
    ...dark,
    "}",
    "",
    ':root[data-theme="light"] {',
    "  color-scheme: light;",
    ...light,
    "}",
    "",
    "@media (prefers-color-scheme: light) {",
    '  :root:not([data-theme="dark"]) {',
    "    color-scheme: light;",
    ...light.map((line) => `  ${line}`),
    "  }",
    "}",
    "",
  ].join("\n")}`;
}

const DTCG_BEZIER: Readonly<Record<string, ReadonlyArray<number>>> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  linear: [0, 0, 1, 1],
};

export interface DtcgValue {
  readonly type: string;
  readonly value: unknown;
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * A colour in the format's object form: sRGB components in 0 to 1, rounded to
 * four places from whole 8-bit channels (so the hex fallback and the components
 * agree), an alpha rounded to four places when it is not 1, and the opaque hex.
 */
export function dtcgColor(colour: Rgba): Record<string, unknown> {
  const bytes = [colour.r, colour.g, colour.b].map((part) =>
    Math.min(255, Math.max(0, Math.round(part))),
  );
  const value: Record<string, unknown> = {
    colorSpace: "srgb",
    components: bytes.map((part) => round(part / 255, 4)),
  };
  const alpha = round(colour.a, 4);
  if (alpha < 1) value["alpha"] = alpha;
  value["hex"] = `#${bytes.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  return value;
}

function dtcgLength(text: string): Record<string, unknown> | undefined {
  if (text === "0") return { value: 0, unit: "px" };
  const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(text);
  return match === null ? undefined : { value: parseFloat(match[1] ?? ""), unit: match[2] };
}

/** One shadow layer: offsets, optional blur and spread, a colour, and `inset`. */
function dtcgShadowLayer(layer: string): Record<string, unknown> | undefined {
  const parts = splitTopLevel(layer.trim(), " ").filter((part) => part !== "");
  const inset = parts.includes("inset");
  const rest = parts.filter((part) => part !== "inset");
  const colour = rest.map((part) => parseColor(part)).find((parsed) => parsed !== undefined);
  const lengths = rest
    .filter((part) => parseColor(part) === undefined)
    .map((part) => dtcgLength(part));
  if (colour === undefined || lengths.length < 2 || lengths.length > 4) return undefined;
  if (lengths.some((length) => length === undefined)) return undefined;
  const [offsetX, offsetY, blur, spread] = lengths;
  const zero = { value: 0, unit: "px" };
  const shadow: Record<string, unknown> = {
    color: dtcgColor(colour),
    offsetX,
    offsetY,
    blur: blur ?? zero,
    spread: spread ?? zero,
  };
  if (inset) shadow["inset"] = true;
  return shadow;
}

/**
 * The DTCG type and value (Design Tokens Format Module 2025.10) for a resolved
 * CSS value, or undefined when the format cannot express it: a length in `em`
 * or `%`, a `clamp()`, `none`, and the like. The format forbids guessing a type
 * and has no untyped token, so such a value is not emitted as a token.
 */
export function dtcgValue(resolved: string, group = ""): DtcgValue | undefined {
  const value = resolved.trim();
  if (group === "type-family") {
    const names = splitTopLevel(value, ",").map((name) =>
      name.trim().replace(/^(["'])(.*)\1$/, "$2"),
    );
    return names.every((name) => /^[^()]+$/.test(name) && name !== "")
      ? { type: "fontFamily", value: names }
      : undefined;
  }
  if (group === "type-weight") {
    const weight = Number(value);
    return /^\d+$/.test(value) && weight >= 1 && weight <= 1000
      ? { type: "fontWeight", value: weight }
      : undefined;
  }
  const colour = parseColor(value);
  if (colour !== undefined) return { type: "color", value: dtcgColor(colour) };
  const length = dtcgLength(value);
  if (length !== undefined) return { type: "dimension", value: length };
  const duration = /^(-?\d*\.?\d+)(ms|s)$/.exec(value);
  if (duration !== null) {
    return { type: "duration", value: { value: parseFloat(duration[1] ?? ""), unit: duration[2] } };
  }
  const bezier = /^cubic-bezier\(([^)]*)\)$/.exec(value)?.[1];
  const curve = bezier?.split(",").map((part) => parseFloat(part)) ?? DTCG_BEZIER[value];
  if (curve !== undefined) {
    return curve.length === 4 &&
      curve.every((part) => Number.isFinite(part)) &&
      [curve[0], curve[2]].every((x) => x !== undefined && x >= 0 && x <= 1)
      ? { type: "cubicBezier", value: curve }
      : undefined;
  }
  if (/^-?\d*\.?\d+$/.test(value)) return { type: "number", value: parseFloat(value) };
  if (value !== "none") {
    const layers = splitTopLevel(value, ",").map((layer) => dtcgShadowLayer(layer));
    if (layers.length > 0 && layers.every((layer) => layer !== undefined)) {
      return { type: "shadow", value: layers.length === 1 ? layers[0] : layers };
    }
  }
  return undefined;
}

function whyNotTyped(resolved: string): string {
  if (/\(from\s/.test(resolved)) {
    return "relative colour syntax cannot be expressed in the format";
  }
  if (/clamp\(|calc\(|\b\d+(?:\.\d+)?v[wh]\b/.test(resolved)) {
    return "depends on the viewport or on a value only the browser knows";
  }
  if (/^-?\d*\.?\d+(?:em|%)$/.test(resolved.trim()))
    return "a length in em or % has no DTCG dimension";
  return "the format has no type for this value";
}

export function renderJson(
  exported: ReadonlyArray<ExportedToken>,
  sources: ReadonlyArray<string>,
  groups: ReadonlyArray<Group> = GROUPS,
): string {
  const labels = new Map(groups.map((group) => [group.id, group.label]));
  labels.set("support", "Support: tokens an exported value reads");
  const cssOnly: Record<string, unknown> = {};
  const tree: Record<string, unknown> = {
    $description: `Octant design tokens in the Design Tokens Format Module 2025.10. Generated by \`${REGENERATE}\` from ${sources.join(", ")}. $value is the dark default; the light value, in the same form, is in $extensions["com.octant"].light. A token's key is its CSS custom property name without the leading dashes. Values the format cannot express are not tokens; they are listed under the root $extensions["com.octant"].cssOnly with their CSS value.`,
    $extensions: { "com.octant": { cssOnly } },
  };
  for (const token of exported) {
    const key = token.name.replace(/^--/, "");
    // A type role's family and weight are read with the family and weight rules.
    const kind = /^oct-role-.*-family$/.test(key)
      ? "type-family"
      : /^oct-role-.*-weight$/.test(key)
        ? "type-weight"
        : token.group;
    const dark = dtcgValue(token.darkResolved, kind);
    const light = dtcgValue(token.lightResolved, kind);
    if (dark === undefined || light === undefined || dark.type !== light.type) {
      const unsupported = dark === undefined ? token.darkResolved : token.lightResolved;
      const entry: Record<string, unknown> = {
        reason: whyNotTyped(unsupported),
        dark: token.darkResolved,
      };
      if (token.lightResolved !== token.darkResolved) entry["light"] = token.lightResolved;
      cssOnly[key] = entry;
      continue;
    }
    const group = (tree[token.group] ??= {
      $description: labels.get(token.group) ?? token.group,
    }) as Record<string, unknown>;
    const extension: Record<string, unknown> = { css: token.name, source: token.file };
    if (JSON.stringify(light.value) !== JSON.stringify(dark.value))
      extension["light"] = light.value;
    if (token.dark !== token.darkResolved) extension["cssValue"] = token.dark;
    group[key] = {
      $type: dark.type,
      $value: dark.value,
      $extensions: { "com.octant": extension },
    };
  }
  return `${JSON.stringify(tree, null, 2)}\n`;
}

// ─── repository wiring ─────────────────────────────────────────────────────

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export const SOURCE_FILES = {
  base: "apps/web/src/styles/octant.css",
  bridge: "apps/web/src/styles/octant-bridge.css",
  theme: "apps/web/src/styles.css",
  roles: "apps/web/src/styles/surface.css",
} as const;

export const OUTPUT_DIRECTORY = "packages/theme/tokens";
export const OUTPUT_FILES = ["tokens.css", "tokens.json"] as const;

function read(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function blocksFor(
  css: string,
  file: string,
  selector: string,
  applies: "both" | "light",
): CascadeBlock {
  const matches = topLevelBlocks(css).filter((block) => block.selector === selector);
  if (matches.length !== 1) {
    throw new TokenExportError(
      `${file}: expected one \`${selector}\` block, found ${String(matches.length)}`,
    );
  }
  const [block] = matches;
  return { declarations: blockDeclarations(block as CssBlock, file), applies };
}

/** Reads the real stylesheets and returns the cascaded token model. */
export function readSourceTokens(): ReadonlyMap<string, SourceToken> {
  const base = read(SOURCE_FILES.base);
  const bridge = read(SOURCE_FILES.bridge);
  const theme = read(SOURCE_FILES.theme);
  const roles = read(SOURCE_FILES.roles);
  // The order the renderer loads them in: the system, the bridge that points
  // it at the runtime theme, then the theme's own roles. The type roles are
  // read from classes, not declared as properties.
  const tokens = new Map(
    cascade([
      blocksFor(base, SOURCE_FILES.base, ":root", "both"),
      blocksFor(bridge, SOURCE_FILES.bridge, ":root", "both"),
      blocksFor(bridge, SOURCE_FILES.bridge, 'html[data-octant-theme-mode="light"]', "light"),
      blocksFor(theme, SOURCE_FILES.theme, ":root", "both"),
      blocksFor(theme, SOURCE_FILES.theme, 'html[data-octant-theme-mode="light"]', "light"),
      { declarations: typeRoleDeclarations(roles, SOURCE_FILES.roles), applies: "both" },
      blocksFor(roles, SOURCE_FILES.roles, ":root", "both"),
    ]),
  );
  return tokens;
}

export function formatWithOxfmt(text: string, path: string): string {
  return execFileSync(
    resolve(repositoryRoot, "node_modules/.bin/oxfmt"),
    [`--stdin-filepath=${path}`],
    { input: text, encoding: "utf8", cwd: repositoryRoot },
  );
}

export interface Generated {
  readonly files: Readonly<Record<(typeof OUTPUT_FILES)[number], string>>;
  readonly exported: ReadonlyArray<ExportedToken>;
}

export function generate(): Generated {
  const tokens = readSourceTokens();
  const problems = checkThemeAgreement(tokens, THEME_TOKEN_ROLE_IDS, {
    dark: DEFAULT_DARK_TOKENS,
    light: DEFAULT_LIGHT_TOKENS,
  });
  if (problems.length > 0) {
    throw new TokenExportError(problems.join("\n"));
  }
  const exported = selectExports(tokens);
  const sources = [...Object.values(SOURCE_FILES), "packages/theme/src/tokens.ts"];
  return {
    exported,
    files: {
      "tokens.css": formatWithOxfmt(renderCss(exported, sources), `${OUTPUT_DIRECTORY}/tokens.css`),
      "tokens.json": formatWithOxfmt(
        renderJson(exported, sources),
        `${OUTPUT_DIRECTORY}/tokens.json`,
      ),
    },
  };
}

/** Names of committed outputs that no longer match the sources. */
export function staleOutputs(generated: Generated): ReadonlyArray<string> {
  return OUTPUT_FILES.filter((file) => {
    try {
      return read(`${OUTPUT_DIRECTORY}/${file}`) !== generated.files[file];
    } catch {
      return true;
    }
  }).map((file) => `${OUTPUT_DIRECTORY}/${file}`);
}

function main(): void {
  const check = process.argv.includes("--check");
  let generated: Generated;
  try {
    generated = generate();
  } catch (error) {
    if (error instanceof TokenExportError) {
      console.error(`Design token export refused:\n${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  if (check) {
    const stale = staleOutputs(generated);
    if (stale.length > 0) {
      console.error(
        `${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} stale relative to the stylesheets; run \`${REGENERATE}\` and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Design tokens are current (${String(generated.exported.length)} exported).`);
    return;
  }
  for (const file of OUTPUT_FILES) {
    const target = resolve(repositoryRoot, OUTPUT_DIRECTORY, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, generated.files[file]);
  }
  console.log(`Wrote ${String(generated.exported.length)} tokens to ${OUTPUT_DIRECTORY}.`);
}

if (import.meta.main) main();
