/**
 * The frame kit: the first-party stylesheet a design drawn in the workspace
 * theme receives ahead of its own styles. It reads only the semantic tokens
 * the host writes into the frame, so a page built from these classes reads as
 * part of Octant in every theme and in forced colours. Authors may override
 * any rule; their stylesheet comes after this one. It uses tokens and system
 * colours only, never a colour of its own.
 */
export const DESIGN_FRAME_KIT = `
html {
  font-family: var(--oct-font-body);
  font-size: var(--oct-text-base);
  line-height: var(--oct-leading-body);
  color: var(--oct-fg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

a {
  color: var(--oct-accent-fg);
  text-decoration: underline;
  text-decoration-color: var(--oct-border);
  text-underline-offset: 0.2em;
}

::selection {
  background: var(--oct-selection);
}

/* ── article ── */

.oct-article {
  max-width: 72ch;
}

.oct-article > :first-child {
  margin-top: 0;
}

.oct-article > :last-child {
  margin-bottom: 0;
}

.oct-article h1,
.oct-article h2,
.oct-article h3,
.oct-article h4 {
  color: var(--oct-fg);
  font-weight: var(--oct-weight-strong);
  line-height: var(--oct-leading-heading);
  letter-spacing: var(--oct-tracking-snug);
  text-wrap: balance;
}

.oct-article h1 {
  margin: 0 0 var(--oct-space-3);
  font-size: var(--oct-text-3xl);
  letter-spacing: var(--oct-tracking-tight);
}

.oct-article h2 {
  margin: var(--oct-space-8) 0 var(--oct-space-3);
  font-size: var(--oct-text-xl);
}

.oct-article h3 {
  margin: var(--oct-space-6) 0 var(--oct-space-2);
  font-size: var(--oct-text-lg);
}

.oct-article h4 {
  margin: var(--oct-space-4) 0 var(--oct-space-2);
  font-size: var(--oct-text-base);
}

.oct-article p,
.oct-article ul,
.oct-article ol,
.oct-article blockquote,
.oct-article figure {
  margin: 0 0 var(--oct-space-4);
}

.oct-article ul,
.oct-article ol {
  padding-left: var(--oct-space-6);
}

.oct-article li + li {
  margin-top: var(--oct-space-1);
}

.oct-article blockquote {
  padding-left: var(--oct-space-4);
  border-left: 2px solid var(--oct-border);
  color: var(--oct-muted);
}

.oct-article hr {
  margin: var(--oct-space-8) 0;
  border: 0;
  border-top: 1px solid var(--oct-border);
}

.oct-article figcaption {
  margin-top: var(--oct-space-2);
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
}

.oct-eyebrow {
  margin: 0 0 var(--oct-space-2);
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
  font-weight: var(--oct-weight-medium);
  letter-spacing: var(--oct-tracking-wide);
  text-transform: uppercase;
}

.oct-lede {
  color: var(--oct-muted);
  font-size: var(--oct-text-lg);
  line-height: var(--oct-leading-snug);
}

.oct-muted {
  color: var(--oct-meta);
}

/* ── layout ── */

.oct-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--oct-space-3);
  margin: 0 0 var(--oct-space-4);
}

/* ── cards ── */

.oct-card {
  padding: var(--oct-space-4);
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-md);
  background: var(--oct-surface);
}

.oct-card > :first-child {
  margin-top: 0;
}

.oct-card > :last-child {
  margin-bottom: 0;
}

.oct-card__title {
  margin: 0 0 var(--oct-space-2);
  font-size: var(--oct-text-base);
  font-weight: var(--oct-weight-strong);
}

/* ── metric tiles ── */

.oct-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
  gap: var(--oct-space-3);
  margin: 0 0 var(--oct-space-6);
}

.oct-metric {
  display: grid;
  gap: var(--oct-space-1);
  padding: var(--oct-space-3) var(--oct-space-4);
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-md);
  background: var(--oct-surface);
}

.oct-metric__label {
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
}

.oct-metric__value {
  color: var(--oct-fg);
  font-size: var(--oct-text-2xl);
  font-weight: var(--oct-weight-strong);
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--oct-tracking-tight);
  line-height: var(--oct-leading-tight);
}

.oct-metric__delta {
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
  font-variant-numeric: tabular-nums;
}

.oct-metric__delta--good {
  color: var(--oct-success-fg);
}

.oct-metric__delta--bad {
  color: var(--oct-danger-fg);
}

/* ── badges ── */

.oct-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--oct-space-1);
  padding: 1px var(--oct-space-2);
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-pill);
  background: var(--oct-fg-soft);
  color: var(--oct-fg-2);
  font-size: var(--oct-text-xs);
  font-weight: var(--oct-weight-medium);
  line-height: var(--oct-leading-snug);
  white-space: nowrap;
}

.oct-badge--accent {
  border-color: transparent;
  background: var(--oct-accent-soft);
  color: var(--oct-accent-fg);
}

.oct-badge--success {
  border-color: transparent;
  background: var(--oct-success-soft);
  color: var(--oct-success-fg);
}

.oct-badge--warn {
  border-color: transparent;
  background: var(--oct-warn-soft);
  color: var(--oct-warn-fg);
}

.oct-badge--danger {
  border-color: transparent;
  background: var(--oct-danger-soft);
  color: var(--oct-danger-fg);
}

/* ── callouts ── */

.oct-callout {
  margin: 0 0 var(--oct-space-4);
  padding: var(--oct-space-3) var(--oct-space-4);
  border: 1px solid var(--oct-border);
  border-left-width: 3px;
  border-radius: var(--oct-radius-sm);
  background: var(--oct-surface);
}

.oct-callout > :last-child {
  margin-bottom: 0;
}

.oct-callout__title {
  margin: 0 0 var(--oct-space-1);
  color: var(--oct-fg);
  font-weight: var(--oct-weight-strong);
}

.oct-callout--success {
  border-left-color: var(--oct-success-fg);
}

.oct-callout--warn {
  border-left-color: var(--oct-warn-fg);
}

.oct-callout--danger {
  border-left-color: var(--oct-danger-fg);
}

/* ── tables ── */

.oct-table-wrap {
  margin: 0 0 var(--oct-space-4);
  overflow-x: auto;
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-md);
}

.oct-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--oct-text-sm);
  font-variant-numeric: tabular-nums;
}

.oct-table th,
.oct-table td {
  padding: var(--oct-space-2) var(--oct-space-3);
  border-bottom: 1px solid var(--oct-border);
  text-align: left;
  vertical-align: top;
}

.oct-table th {
  color: var(--oct-meta);
  font-size: var(--oct-text-xs);
  font-weight: var(--oct-weight-medium);
  white-space: nowrap;
}

.oct-table tbody tr:last-child td {
  border-bottom: 0;
}

/* ── code ── */

code,
kbd,
pre {
  font-family: var(--oct-font-mono);
  font-size: 0.9em;
}

:not(pre) > code {
  padding: 0 0.3em;
  border-radius: 4px;
  background: var(--oct-fg-soft);
}

.oct-code {
  margin: 0 0 var(--oct-space-4);
  padding: var(--oct-space-3) var(--oct-space-4);
  overflow-x: auto;
  border: 1px solid var(--oct-border);
  border-radius: var(--oct-radius-sm);
  background: var(--oct-surface);
  line-height: var(--oct-leading-code);
  white-space: pre;
}

/* ── tabs ──
   Radio inputs and their labels, then one panel per tab in the same order.
   A checked radio shows the panel at its position, so the page switches tabs
   without running anything. Panels must be the block's only div children.
   CSS cannot pair the nth radio with the nth panel generically, so the kit
   pairs eight and the author instructions and DESIGN.md teach that limit. */

.oct-tabs {
  display: flex;
  flex-wrap: wrap;
  column-gap: var(--oct-space-4);
  margin: 0 0 var(--oct-space-4);
}

.oct-tabs > input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}

.oct-tabs > label {
  padding: var(--oct-space-2) 0;
  border-bottom: 2px solid transparent;
  color: var(--oct-meta);
  cursor: pointer;
  font-size: var(--oct-text-sm);
  font-weight: var(--oct-weight-medium);
}

.oct-tabs > label:hover {
  color: var(--oct-fg);
}

.oct-tabs > input:checked + label {
  border-bottom-color: var(--oct-fg);
  color: var(--oct-fg);
}

.oct-tabs > input:focus-visible + label {
  outline: 2px solid var(--oct-muted);
  outline-offset: 2px;
  border-radius: 2px;
}

.oct-tabs > .oct-tab-panel {
  display: none;
  flex-basis: 100%;
  margin-top: -1px;
  padding-top: var(--oct-space-4);
  border-top: 1px solid var(--oct-border);
}

.oct-tabs > .oct-tab-panel > :first-child {
  margin-top: 0;
}

.oct-tabs > input:nth-of-type(1):checked ~ .oct-tab-panel:nth-of-type(1),
.oct-tabs > input:nth-of-type(2):checked ~ .oct-tab-panel:nth-of-type(2),
.oct-tabs > input:nth-of-type(3):checked ~ .oct-tab-panel:nth-of-type(3),
.oct-tabs > input:nth-of-type(4):checked ~ .oct-tab-panel:nth-of-type(4),
.oct-tabs > input:nth-of-type(5):checked ~ .oct-tab-panel:nth-of-type(5),
.oct-tabs > input:nth-of-type(6):checked ~ .oct-tab-panel:nth-of-type(6),
.oct-tabs > input:nth-of-type(7):checked ~ .oct-tab-panel:nth-of-type(7),
.oct-tabs > input:nth-of-type(8):checked ~ .oct-tab-panel:nth-of-type(8) {
  display: block;
}

/* Forced colours replace every fill, so a tone keeps its meaning through its
   border and words, and the chosen tab through a system highlight. */
@media (forced-colors: active) {
  .oct-badge,
  .oct-badge--accent,
  .oct-badge--success,
  .oct-badge--warn,
  .oct-badge--danger {
    border-color: CanvasText;
  }

  .oct-tabs > label {
    border-bottom-color: Canvas;
  }

  .oct-tabs > input:checked + label {
    border-bottom-color: Highlight;
  }
}
`;

/**
 * The workspace tokens a themed frame receives, read from Octant's own page
 * when the frame is drawn. These are the semantic `--oct-*` roles the frame
 * kit reads; an author may read them too.
 */
export const DESIGN_FRAME_THEME_TOKENS: ReadonlyArray<string> = [
  "--oct-bg",
  "--oct-surface",
  "--oct-surface-warm",
  "--oct-fg",
  "--oct-fg-2",
  "--oct-fg-soft",
  "--oct-muted",
  "--oct-meta",
  "--oct-border",
  "--oct-border-soft",
  "--oct-selection",
  "--oct-accent",
  "--oct-accent-fg",
  "--oct-accent-on",
  "--oct-accent-soft",
  "--oct-success",
  "--oct-success-fg",
  "--oct-success-soft",
  "--oct-warn",
  "--oct-warn-fg",
  "--oct-warn-soft",
  "--oct-danger",
  "--oct-danger-fg",
  "--oct-danger-soft",
  "--oct-series-1",
  "--oct-series-2",
  "--oct-series-3",
  "--oct-series-4",
  "--oct-series-5",
  "--oct-series-6",
  "--oct-font-body",
  "--oct-font-mono",
  "--oct-text-xs",
  "--oct-text-sm",
  "--oct-text-base",
  "--oct-text-lg",
  "--oct-text-xl",
  "--oct-text-2xl",
  "--oct-text-3xl",
  "--oct-leading-body",
  "--oct-leading-tight",
  "--oct-leading-heading",
  "--oct-leading-snug",
  "--oct-leading-code",
  "--oct-weight-medium",
  "--oct-weight-strong",
  "--oct-tracking-tight",
  "--oct-tracking-snug",
  "--oct-tracking-wide",
  "--oct-space-1",
  "--oct-space-2",
  "--oct-space-3",
  "--oct-space-4",
  "--oct-space-6",
  "--oct-space-8",
  "--oct-radius-sm",
  "--oct-radius-md",
  "--oct-radius-pill",
];

/** The workspace's scheme and token values, as a themed frame is drawn with them. */
export interface DesignFrameThemeValues {
  readonly scheme: "light" | "dark";
  readonly tokens: ReadonlyArray<readonly [name: string, value: string]>;
}

/**
 * The generic families and common system faces a brand font may name. A brand
 * font is a stack of these, so a design cannot ask for a face the viewer must
 * download: no web font is ever loaded.
 */
const BRAND_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "arial",
  "helvetica",
  "helvetica neue",
  "verdana",
  "tahoma",
  "trebuchet ms",
  "georgia",
  "times new roman",
  "palatino",
  "garamond",
  "courier new",
  "menlo",
  "monaco",
  "consolas",
  "inter",
]);

/** Whether a brand font stack may name this family: a system face or a generic family. */
export function designBrandFontFamilyIsSafe(family: string): boolean {
  return BRAND_FONT_FAMILIES.has(family.trim().toLowerCase());
}

const BRAND_COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla|oklch|oklab)\(\s*[0-9a-z.,%/\s+-]{1,96}\)$/i;
const BRAND_HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const BRAND_LENGTH = /^(?:0|(?:\d{1,3}(?:\.\d{1,3})?)(?:px|rem|em|%))$/;

/**
 * Why a brand token is refused, or undefined when it may be written into a
 * frame's stylesheet. The name's kind decides the value's shape: a colour is a
 * hex value or a colour function, a font is a comma list of the safe faces and
 * generic families, and a radius or spacing step is a bounded length. Every
 * value must also pass the frame token safety rule, so nothing a brand holds
 * can end a declaration, close a rule, or name something to load.
 */
export function designBrandTokenRefusal(name: string, value: string): string | undefined {
  if (!designFrameTokenValueIsSafe(value)) {
    return `token ${name} holds a value that could end its declaration or load something`;
  }
  const kind = name.slice(0, name.indexOf("-"));
  const trimmed = value.trim();
  switch (kind) {
    case "color":
      return BRAND_HEX_COLOR.test(trimmed) || BRAND_COLOR_FUNCTION.test(trimmed)
        ? undefined
        : `token ${name} is not a hex colour or a colour function`;
    case "font": {
      const families = trimmed.split(",").map((family) => family.trim().toLowerCase());
      return families.every((family) => BRAND_FONT_FAMILIES.has(family))
        ? undefined
        : `token ${name} names a font outside the safe list; use a system face or a generic family`;
    }
    case "radius":
    case "space":
      return BRAND_LENGTH.test(trimmed)
        ? undefined
        : `token ${name} is not a length in px, rem, em, or %`;
    default:
      return `token ${name} is not a colour, font, radius, or space token`;
  }
}

// A brand design is drawn without the workspace theme, so the same brand looks
// the same in every window, share, and export. These neutral light values fill
// every role the brand does not name; the kit itself still holds no colour.
const BRAND_BASE_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["--oct-bg", "#ffffff"],
  ["--oct-surface", "#f6f6f7"],
  ["--oct-surface-warm", "#f6f6f7"],
  ["--oct-fg", "#18181b"],
  ["--oct-fg-2", "#3f3f46"],
  ["--oct-fg-soft", "#52525b"],
  ["--oct-muted", "#52525b"],
  ["--oct-meta", "#71717a"],
  ["--oct-border", "#d4d4d8"],
  ["--oct-border-soft", "#e4e4e7"],
  ["--oct-selection", "rgb(37 99 235 / 0.25)"],
  ["--oct-accent", "#2563eb"],
  ["--oct-accent-fg", "#2563eb"],
  ["--oct-accent-on", "#ffffff"],
  ["--oct-accent-soft", "color-mix(in srgb, var(--oct-accent) 12%, var(--oct-bg))"],
  ["--oct-success", "#15803d"],
  ["--oct-success-fg", "#15803d"],
  ["--oct-success-soft", "color-mix(in srgb, var(--oct-success) 12%, var(--oct-bg))"],
  ["--oct-warn", "#b45309"],
  ["--oct-warn-fg", "#b45309"],
  ["--oct-warn-soft", "color-mix(in srgb, var(--oct-warn) 12%, var(--oct-bg))"],
  ["--oct-danger", "#b91c1c"],
  ["--oct-danger-fg", "#b91c1c"],
  ["--oct-danger-soft", "color-mix(in srgb, var(--oct-danger) 12%, var(--oct-bg))"],
  ["--oct-series-1", "var(--oct-accent)"],
  ["--oct-series-2", "#0f766e"],
  ["--oct-series-3", "#b45309"],
  ["--oct-series-4", "#7c3aed"],
  ["--oct-series-5", "#be185d"],
  ["--oct-series-6", "#52525b"],
  ["--oct-font-body", "system-ui, sans-serif"],
  ["--oct-font-mono", "ui-monospace, monospace"],
  ["--oct-text-xs", "0.75rem"],
  ["--oct-text-sm", "0.8125rem"],
  ["--oct-text-base", "0.9375rem"],
  ["--oct-text-lg", "1.0625rem"],
  ["--oct-text-xl", "1.25rem"],
  ["--oct-text-2xl", "1.5rem"],
  ["--oct-text-3xl", "2rem"],
  ["--oct-leading-body", "1.55"],
  ["--oct-leading-tight", "1.2"],
  ["--oct-leading-heading", "1.25"],
  ["--oct-leading-snug", "1.4"],
  ["--oct-leading-code", "1.5"],
  ["--oct-weight-medium", "500"],
  ["--oct-weight-strong", "600"],
  ["--oct-tracking-tight", "-0.01em"],
  ["--oct-tracking-snug", "-0.005em"],
  ["--oct-tracking-wide", "0.04em"],
  ["--oct-space-1", "4px"],
  ["--oct-space-2", "8px"],
  ["--oct-space-3", "12px"],
  ["--oct-space-4", "16px"],
  ["--oct-space-6", "24px"],
  ["--oct-space-8", "32px"],
  ["--oct-radius-sm", "6px"],
  ["--oct-radius-md", "10px"],
  ["--oct-radius-pill", "999px"],
];

/**
 * Which kit roles each brand token sets. A brand names what it means
 * (`color-primary`); the kit's classes read `--oct-*`, so a named token also
 * sets the roles the kit draws it in. Every token is also written as its own
 * `--brand-<name>` for a page that styles itself from the brand.
 */
const BRAND_ROLES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "color-background": ["--oct-bg"],
  "color-surface": ["--oct-surface", "--oct-surface-warm"],
  "color-text": ["--oct-fg", "--oct-fg-2", "--oct-fg-soft"],
  "color-muted": ["--oct-muted", "--oct-meta"],
  "color-border": ["--oct-border", "--oct-border-soft"],
  "color-primary": ["--oct-accent", "--oct-accent-fg", "--oct-series-1"],
  "color-on-primary": ["--oct-accent-on"],
  "color-secondary": ["--oct-series-2"],
  "color-success": ["--oct-success", "--oct-success-fg"],
  "color-warning": ["--oct-warn", "--oct-warn-fg"],
  "color-danger": ["--oct-danger", "--oct-danger-fg"],
  "font-body": ["--oct-font-body"],
  "font-mono": ["--oct-font-mono"],
  "radius-sm": ["--oct-radius-sm"],
  "radius-md": ["--oct-radius-md"],
  "radius-card": ["--oct-radius-md"],
  "radius-pill": ["--oct-radius-pill"],
};

/**
 * The declarations a brand design's frames start from, as the body of a
 * `:root` rule: the neutral base, then each brand token as `--brand-<name>`
 * and on the kit roles it names. A token the brand rule refuses is left out,
 * wherever the brand came from, so nothing unsafe is written into a page.
 */
export function designBrandDeclarations(brand: Readonly<Record<string, string>>): string {
  const own: Array<readonly [string, string]> = [];
  const roles = new Map<string, string>();
  for (const [name, raw] of Object.entries(brand)) {
    if (!/^(?:color|font|radius|space)-[a-z0-9][a-z0-9-]{0,31}$/.test(name)) continue;
    if (designBrandTokenRefusal(name, raw) !== undefined) continue;
    const value = raw.trim();
    own.push([`--brand-${name}`, value]);
    for (const role of BRAND_ROLES[name] ?? []) roles.set(role, value);
  }
  const base = BRAND_BASE_TOKENS.filter(([name]) => !roles.has(name));
  return [...base, ...roles, ...own].map(([name, value]) => `${name}: ${value};`).join(" ");
}

/**
 * Whether a token's value may be written into a frame's stylesheet. The value
 * is a claim wherever it comes from: the app reads it from its own page, and
 * an export is handed it by a window. One that could end its declaration or
 * its rule, or name something to load, is left out rather than written.
 */
export function designFrameTokenValueIsSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[<>{};\\]/.test(value) &&
    !/url\s*\(|@import|expression\s*\(/i.test(value)
  );
}

// What stands right before an address the browser loads, in the positions the
// markup policy admits a design asset reference: a `url()`, a `src`, `srcset`,
// `poster`, or `background` value (or a later srcset candidate), and a quoted
// `image-set()` candidate. The same token in prose, `alt`, or any other
// attribute is the author's text and is left as written.
const DESIGN_ASSET_ADDRESS_LEAD = String.raw`(?:url\(\s*["']?\s*|(?:^|[\s"'/])(?:src|srcset|poster|background)\s*=\s*["']?\s*|(?:^|[\s"'/])srcset\s*=\s*(?:"[^"]*?,\s*|'[^']*?,\s*)|image-set\((?:[^()]|\([^()]*\))*?["']\s*)`;
const DESIGN_ASSET_REFERENCE = new RegExp(
  `(?<=${DESIGN_ASSET_ADDRESS_LEAD})octant-asset:([A-Za-z0-9][A-Za-z0-9._-]{0,63})`,
  "gi",
);

/**
 * A design's markup with each `octant-asset:<id>` reference in an image
 * position replaced by the address `address` gives that id, for a page that
 * draws a design without a host to ask, such as a shared copy.
 */
export function withDesignAssetAddresses(
  markup: string,
  address: (assetId: string) => string,
): string {
  if (!/octant-asset:/i.test(markup)) return markup;
  // Only the scheme as the markup policy admits it, in lowercase, is a reference.
  return markup.replace(DESIGN_ASSET_REFERENCE, (reference: string, id: string) =>
    reference.startsWith("octant-asset:") ? address(id) : reference,
  );
}

/** Half-open [start, end) offsets of the comments a browser ignores in some markup. */
type CommentRanges = ReadonlyArray<readonly [number, number]>;

/** The end of a quoted string opened at `start`, past its closing quote. */
function quotedEnd(text: string, start: number, stopAtNewline: boolean): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index + 1;
    else if (stopAtNewline && char === "\n") return index;
  }
  return text.length;
}

/** Comments in CSS from `start` to `end`: block comments outside strings. */
function cssComments(text: string, start: number, end: number, into: Array<[number, number]>) {
  let index = start;
  while (index < end) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = Math.min(quotedEnd(text, index, true), end);
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 || close + 2 > end ? end : close + 2;
      into.push([index, stop]);
      index = stop;
    } else {
      index += 1;
    }
  }
}

/** Comments in a script from `start` to `end`: block and line comments outside strings. */
function scriptComments(text: string, start: number, end: number, into: Array<[number, number]>) {
  let index = start;
  while (index < end) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = Math.min(quotedEnd(text, index, char !== "`"), end);
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 || close + 2 > end ? end : close + 2;
      into.push([index, stop]);
      index = stop;
    } else if (char === "/" && text[index + 1] === "/") {
      const close = text.indexOf("\n", index + 2);
      const stop = close === -1 || close > end ? end : close;
      into.push([index, stop]);
      index = stop;
    } else {
      index += 1;
    }
  }
}

// The element name ends at a tag delimiter: `<script-preview>` is a custom
// element whose children are HTML, not a script.
const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(quot|apos|amp|lt|gt));/y;
const NAMED_CHARACTERS: Readonly<Record<string, string>> = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
};

/**
 * Comments in an inline event handler's value from `start` to `end`. A
 * browser decodes the value's character references before compiling it, so
 * `&quot;` opens a string there; the comments are read in the decoded script
 * and mapped back to the markup.
 */
function handlerComments(text: string, start: number, end: number, into: Array<[number, number]>) {
  let decoded = "";
  const offsets: number[] = [];
  let index = start;
  while (index < end) {
    CHARACTER_REFERENCE.lastIndex = index;
    const reference = text[index] === "&" ? CHARACTER_REFERENCE.exec(text) : null;
    if (reference !== null && reference.index + reference[0].length <= end) {
      const code =
        reference[1] !== undefined
          ? Number(reference[1])
          : reference[2] !== undefined
            ? Number.parseInt(reference[2], 16)
            : undefined;
      decoded +=
        code === undefined
          ? (NAMED_CHARACTERS[reference[3] ?? ""] ?? "")
          : code <= 0x10ffff
            ? String.fromCodePoint(code)
            : "\ufffd";
      while (offsets.length < decoded.length) offsets.push(index);
      index += reference[0].length;
    } else {
      decoded += text[index] ?? "";
      offsets.push(index);
      index += 1;
    }
  }
  offsets.push(end);
  const local: Array<[number, number]> = [];
  scriptComments(decoded, 0, decoded.length, local);
  for (const [from, to] of local) into.push([offsets[from] ?? end, offsets[to] ?? end]);
}

const RAW_TEXT_OPEN = /<(style|script)(?=[\t\n\f\r />])[^>]*>/iy;
const TAG_NAME = /<[A-Za-z][^\s/>]*/y;
const ATTRIBUTE = /[\s/]*([^\s=/>][^\s=>]*)(?:\s*=\s*("[^"]*"?|'[^']*'?|[^\s>]*))?/y;
/** Attributes whose value a browser loads as an image. */
const IMAGE_ATTRIBUTES = new Set(["src", "srcset", "poster", "background"]);

/**
 * Where a browser would never draw an image reference in a design's frame
 * markup or stylesheet: comments (HTML comments in markup; CSS comments in a
 * stylesheet, a `<style>` element and a `style` attribute, quoted or not;
 * script comments in a `<script>` element or an inline event handler), and in
 * markup also text content and the values of attributes that load no image,
 * such as `alt`. A `/*` in
 * a frame's text, or a `<!--` inside CSS, opens nothing. It is a reading for
 * finding image references, not a parser: a regular expression literal in a
 * script is read as code, which can only hide a reference, never invent one.
 */
export function designMarkupInertRanges(markup: string, language: "html" | "css"): CommentRanges {
  const ranges: Array<[number, number]> = [];
  if (language === "css") {
    cssComments(markup, 0, markup.length, ranges);
    return ranges;
  }
  let index = 0;
  let textStart = 0;
  const endText = (at: number) => {
    if (at > textStart) ranges.push([textStart, at]);
  };
  while (index < markup.length) {
    if (markup.startsWith("<!--", index)) {
      endText(index);
      const close = markup.indexOf("-->", index + 4);
      const stop = close === -1 ? markup.length : close + 3;
      ranges.push([index, stop]);
      index = textStart = stop;
      continue;
    }
    TAG_NAME.lastIndex = index;
    const name = markup[index + 1] === "/" ? null : TAG_NAME.exec(markup);
    if (name === null) {
      if (markup[index] === "<" && markup[index + 1] === "/") {
        endText(index);
        const close = markup.indexOf(">", index);
        index = textStart = close === -1 ? markup.length : close + 1;
      } else {
        index += 1;
      }
      continue;
    }
    endText(index);
    // The tag's attributes: an image attribute's value is live, a style
    // value is CSS, and every other value is the author's text.
    let cursor = index + name[0].length;
    while (cursor < markup.length && markup[cursor] !== ">") {
      ATTRIBUTE.lastIndex = cursor;
      const attribute = ATTRIBUTE.exec(markup);
      if (attribute === null || attribute[0].length === 0) {
        cursor += 1;
        continue;
      }
      const attributeName = (attribute[1] ?? "").toLowerCase();
      const value = attribute[2];
      if (value !== undefined) {
        const valueStart = cursor + attribute[0].length - value.length;
        const quoted = value.startsWith('"') || value.startsWith("'") ? 1 : 0;
        const closed = quoted === 1 && value.length > 1 && value.endsWith(value[0] ?? "") ? 1 : 0;
        const inner: [number, number] = [valueStart + quoted, valueStart + value.length - closed];
        if (attributeName === "style") cssComments(markup, inner[0], inner[1], ranges);
        // An inline event handler is script a running design runs, once the
        // browser has decoded its character references.
        else if (attributeName.startsWith("on"))
          handlerComments(markup, inner[0], inner[1], ranges);
        else if (!IMAGE_ATTRIBUTES.has(attributeName)) ranges.push(inner);
      }
      cursor += attribute[0].length;
    }
    const tagEnd = Math.min(cursor + 1, markup.length);
    RAW_TEXT_OPEN.lastIndex = index;
    const raw = RAW_TEXT_OPEN.exec(markup);
    if (raw !== null) {
      const element = (raw[1] ?? "").toLowerCase();
      const closing = new RegExp(`</${element}\\s*>`, "ig");
      closing.lastIndex = tagEnd;
      const close = closing.exec(markup);
      const bodyEnd = close === null ? markup.length : close.index;
      if (element === "style") cssComments(markup, tagEnd, bodyEnd, ranges);
      else scriptComments(markup, tagEnd, bodyEnd, ranges);
      index = textStart = bodyEnd;
      continue;
    }
    index = textStart = tagEnd;
  }
  endText(markup.length);
  return ranges;
}

/**
 * {@link withDesignAssetAddresses} for the references a browser would draw:
 * a reference in a comment, in text, or in an attribute that loads no image
 * is left as written, which loads nothing, and `address` is never asked for
 * it.
 */
export function withDrawnDesignAssetAddresses(
  markup: string,
  language: "html" | "css",
  address: (assetId: string) => string,
): string {
  if (!/octant-asset:/i.test(markup)) return markup;
  const inert = designMarkupInertRanges(markup, language);
  return markup.replace(DESIGN_ASSET_REFERENCE, (reference: string, id: string, offset: number) =>
    !reference.startsWith("octant-asset:") ||
    inert.some(([start, end]) => offset >= start && offset < end)
      ? reference
      : address(id),
  );
}
