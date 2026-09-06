import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

/**
 * Enforces the stylesheet half of the component contract (0016 and 0046):
 * feature stylesheets may place a surface but must not repaint it. The
 * component boundary check covers .tsx; this one covers every .css file the
 * renderer ships.
 *
 * Colour literals fail closed. The three other rules ratchet against
 * `scripts/ui-stylesheet-baseline.json`: a file may not add a finding, and a
 * fix must lower the recorded count so the baseline never overstates.
 */

const WEB_SOURCE = "apps/web/src";
const STYLESHEET_EXTENSION = /\.css$/;
const COMPONENT_EXTENSION = /(?<!\.test)\.tsx$/;
export const BASELINE_PATH = "scripts/ui-stylesheet-baseline.json";

export type StylesheetRule =
  | "color-literal"
  | "font-size-scale"
  | "motion-literal"
  | "important"
  | "heavy-weight"
  | "control-repaint";

export interface StylesheetFinding {
  readonly rule: StylesheetRule;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export type StylesheetBaseline = Readonly<
  Partial<Record<StylesheetRule, Readonly<Record<string, number>>>>
>;

/** The one accepted exception: a block that depicts one fixed scheme on purpose,
 * such as a light/dark preview swatch, and so must not follow the active theme. */
const EXCEPTION_MARKER = /ui-style-exception:\s*fixed-scheme/;

// `color-mix()` is how a theme token is tinted, so the call itself is not a raw
// colour; a literal written inside one is still caught by the alternatives here.
const COLOR_LITERAL =
  /(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:(?:rgb|hsl)a?|hwb|lab|lch|oklab|oklch|color)\([^)]*\))/;

// The type scale from DESIGN.md plus the token steps octant.css defines
// (11 xs, 12 detail, 13 sm, 14 base, 17 lg, 20 xl, 26 2xl, 28 hero, 36 3xl).
const SCALE_STEPS = new Set([11, 12, 13, 14, 17, 20, 26, 28, 36]);
const SCALE_TOKEN =
  /^var\(--(?:oct-text-[a-z0-9-]+|oct-fs-[a-z0-9-]+|oct-transcript-font-size|octant-(?:ui|editor|terminal)-font-size)\)$/;
const SCALE_CALC = /^calc\((\d+) \* var\(--oct-text-step\)\)$/;

const MOTION_PROPERTY =
  /^(?:transition|transition-duration|transition-delay|animation|animation-duration|animation-delay)$/;
// `0s`, `0ms`, and `0.01ms` are the reduced-motion idiom, not a chosen duration.
const MOTION_LITERAL = /(?<![\w.-])(?!0(?:\.01)?m?s\b)\d*\.?\d+m?s\b/;
const MOTION_TOKEN = /var\(--oct-motion-[a-z-]+\)/;

const ACCESSIBILITY_MEDIA =
  /prefers-reduced-motion|prefers-reduced-transparency|prefers-contrast|forced-colors/;

// DESIGN.md: nothing is bold except a page title. Content emphasis (`strong`,
// transcript headings) and the handful of titles are the accepted residue.
const HEAVY_WEIGHT = /^(?:bold|bolder|var\(--oct-weight-strong\))$/;

// CSS allows whitespace between `!` and the keyword and matches the keyword
// case-insensitively, so `! IMPORTANT` is the same annotation as `!important`.
// Anchoring to the end of the value keeps quoted text such as
// `content: "Use !important"` and a suffixed `!important-foo` out of the rule.
const IMPORTANT_ANNOTATION = /!\s*important\s*$/i;

/** `!important` and casing must not let a weight slip past the 500 limit. */
function isHeavyWeight(value: string): boolean {
  const weight = value.replace(IMPORTANT_ANNOTATION, "").trim().toLowerCase();
  const numeric = Number(weight);
  return Number.isFinite(numeric) && weight !== "" ? numeric > 500 : HEAVY_WEIGHT.test(weight);
}

/** Only an `@media` rule that names an accessibility feature earns the
 * `!important` exemption; a selector that merely spells one out does not. */
function isAccessibilityFallback(headers: ReadonlyArray<string>): boolean {
  return headers.some((header) => /^@media\b/.test(header) && ACCESSIBILITY_MEDIA.test(header));
}

// 0046: a feature stylesheet may place or size a shared control, never repaint
// it. These are the properties that recipe owns.
const PAINT_PROPERTY =
  /^(?:background|background-color|background-image|border|border-color|border-width|border-style|border-radius|box-shadow|color|outline)$/;
const PRIMITIVE_ELEMENT =
  /<(Octant(?:Button|IconButton|Card|Badge|Input|Select|Textarea|Checkbox|Switch))\b([^>]*)>/g;
const CLASS_ATTRIBUTE = /className=(?:["']([^"']+)["']|\{\s*(?:cn\(\s*)?["'`]([^"'`$]+)["'`$])/;

/**
 * Classes that feature code hands to an Octant primitive, so a stylesheet
 * rule ending in that class is styling the primitive itself.
 */
export function collectPrimitiveClasses(
  sources: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const classes = new Map<string, string>();
  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(PRIMITIVE_ELEMENT)) {
      const primitive = match[1] ?? "";
      const attributes = match[2] ?? "";
      // `unstyled` hands the paint to the feature on purpose; OctantTextarea
      // does the same for `composer-input`, the system prompt (0038).
      if (/\bunstyled\b/.test(attributes) || /\bcomposer-input\b/.test(attributes)) continue;
      const attribute = CLASS_ATTRIBUTE.exec(attributes);
      const literal = attribute?.[1] ?? attribute?.[2];
      if (literal === undefined) continue;
      for (const className of literal.trim().split(/\s+/)) {
        if (/^[a-z][\w-]*$/.test(className) && className !== "window-no-drag") {
          classes.set(className, primitive);
        }
      }
    }
  }
  return classes;
}

function repaintedPrimitive(
  header: string,
  primitiveClasses: ReadonlyMap<string, string>,
): { readonly className: string; readonly primitive: string } | undefined {
  for (const selector of header.split(",")) {
    const compound =
      selector
        .trim()
        .split(/[\s>+~]+/)
        .pop() ?? "";
    for (const match of compound.matchAll(/\.([a-z][\w-]*)/g)) {
      const className = match[1] ?? "";
      const primitive = primitiveClasses.get(className);
      if (primitive !== undefined) return { className, primitive };
    }
  }
  return undefined;
}

interface Declaration {
  readonly property: string;
  readonly value: string;
  readonly line: number;
  readonly exempt: boolean;
  readonly headers: ReadonlyArray<string>;
}

/** Blank out comments while keeping every newline so line numbers survive. */
function stripComments(source: string): { readonly text: string; readonly markers: number[] } {
  const markers: number[] = [];
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment, offset: number) => {
    if (EXCEPTION_MARKER.test(comment)) markers.push(offset + comment.length);
    return comment.replace(/[^\n]/g, " ");
  });
  return { text, markers };
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * A deliberately small reader: oxfmt keeps these files regular, so blocks and
 * `property: value;` pairs are enough. An exception marker exempts the next
 * block that opens after it.
 */
function readDeclarations(source: string): ReadonlyArray<Declaration> {
  const { text, markers } = stripComments(source);
  const declarations: Declaration[] = [];
  const headers: string[] = [];
  const exemptDepths: number[] = [];
  let pendingMarker = markers.shift();
  let segmentStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      headers.push(text.slice(segmentStart, index).trim());
      if (pendingMarker !== undefined && pendingMarker <= index) {
        exemptDepths.push(headers.length);
        pendingMarker = markers.shift();
      }
      segmentStart = index + 1;
    } else if (char === "}") {
      if (exemptDepths[exemptDepths.length - 1] === headers.length) exemptDepths.pop();
      headers.pop();
      segmentStart = index + 1;
    } else if (char === ";") {
      const segment = text.slice(segmentStart, index);
      const colon = segment.indexOf(":");
      if (colon > 0 && headers.length > 0) {
        const property = segment.slice(0, colon).trim();
        if (/^(?:--)?[a-zA-Z][\w-]*$/.test(property)) {
          declarations.push({
            property,
            value: segment
              .slice(colon + 1)
              .replace(/\s+/g, " ")
              .trim(),
            line: lineAt(text, segmentStart + segment.search(/\S/)),
            exempt: exemptDepths.length > 0,
            headers: [...headers],
          });
        }
      }
      segmentStart = index + 1;
    }
  }
  return declarations;
}

function fontSizeOnScale(value: string): boolean {
  if (value === "inherit" || SCALE_TOKEN.test(value)) return true;
  const calc = SCALE_CALC.exec(value);
  return calc !== null && SCALE_STEPS.has(Number(calc[1]));
}

export function findStylesheetFindings(
  files: Readonly<Record<string, string>>,
  primitiveClasses: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<StylesheetFinding> {
  const findings: StylesheetFinding[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    for (const declaration of readDeclarations(source)) {
      const { property, value, line, exempt, headers } = declaration;
      const isToken = property.startsWith("--");
      // A standard property name is ASCII case-insensitive; a custom property
      // name is not, so only the standard names are folded.
      const name = isToken ? property : property.toLowerCase();
      const push = (rule: StylesheetRule, detail: string): void => {
        findings.push({ rule, file: normalized, line, detail });
      };

      if (!isToken && !exempt) {
        const color = COLOR_LITERAL.exec(value);
        if (color) push("color-literal", `${property} uses a raw colour: ${color[0]}`);
      }
      if (name === "font-size" && !fontSizeOnScale(value)) {
        push("font-size-scale", `font-size ${value} is not a type-scale token`);
      }
      if (!isToken && MOTION_PROPERTY.test(name) && !MOTION_TOKEN.test(value)) {
        const literal = MOTION_LITERAL.exec(value);
        if (literal) push("motion-literal", `${property} uses a raw duration: ${literal[0]}`);
      }
      if (IMPORTANT_ANNOTATION.test(value) && !isAccessibilityFallback(headers)) {
        push("important", `${property} uses !important outside an accessibility fallback`);
      }
      if (!isToken && name === "font-weight" && isHeavyWeight(value)) {
        push("heavy-weight", `font-weight ${value} is heavier than a page title`);
      }
      if (!isToken && PAINT_PROPERTY.test(property)) {
        const repainted = repaintedPrimitive(headers[headers.length - 1] ?? "", primitiveClasses);
        if (repainted) {
          push(
            "control-repaint",
            `${property} repaints ${repainted.primitive} through .${repainted.className}`,
          );
        }
      }
    }
  }
  return findings;
}

export function countFindings(
  findings: ReadonlyArray<StylesheetFinding>,
): Record<StylesheetRule, Record<string, number>> {
  const counts: Record<StylesheetRule, Record<string, number>> = {
    "color-literal": {},
    "font-size-scale": {},
    "motion-literal": {},
    important: {},
    "heavy-weight": {},
    "control-repaint": {},
  };
  for (const finding of findings) {
    const byFile = counts[finding.rule];
    byFile[finding.file] = (byFile[finding.file] ?? 0) + 1;
  }
  return counts;
}

export interface BaselineProblem {
  readonly kind: "exceeded" | "stale";
  readonly rule: StylesheetRule;
  readonly file: string;
  readonly recorded: number;
  readonly current: number;
}

/** Colour literals never ratchet: a raw colour is a defect the day it lands. */
const RATCHETED_RULES: ReadonlyArray<StylesheetRule> = [
  "font-size-scale",
  "motion-literal",
  "important",
  "heavy-weight",
  "control-repaint",
];

export function compareWithBaseline(
  findings: ReadonlyArray<StylesheetFinding>,
  baseline: StylesheetBaseline,
): ReadonlyArray<BaselineProblem> {
  const counts = countFindings(findings);
  const problems: BaselineProblem[] = [];
  for (const file of Object.keys(counts["color-literal"]).sort()) {
    const current = counts["color-literal"][file] ?? 0;
    problems.push({ kind: "exceeded", rule: "color-literal", file, recorded: 0, current });
  }
  for (const rule of RATCHETED_RULES) {
    const recorded = baseline[rule] ?? {};
    const files = new Set([...Object.keys(recorded), ...Object.keys(counts[rule])]);
    for (const file of [...files].sort()) {
      const before = recorded[file] ?? 0;
      const current = counts[rule][file] ?? 0;
      if (current > before)
        problems.push({ kind: "exceeded", rule, file, recorded: before, current });
      else if (current < before)
        problems.push({ kind: "stale", rule, file, recorded: before, current });
    }
  }
  return problems;
}

export function serializeBaseline(findings: ReadonlyArray<StylesheetFinding>): string {
  const counts = countFindings(findings);
  const baseline: Record<string, Record<string, number>> = {};
  for (const rule of RATCHETED_RULES) {
    const byFile = counts[rule];
    const files = Object.keys(byFile).sort();
    if (files.length === 0) continue;
    baseline[rule] = Object.fromEntries(files.map((file) => [file, byFile[file] ?? 0]));
  }
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

async function rendererFiles(root: string): Promise<{
  readonly stylesheets: Readonly<Record<string, string>>;
  readonly components: Readonly<Record<string, string>>;
}> {
  const stylesheets: Record<string, string> = {};
  const components: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const key = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && STYLESHEET_EXTENSION.test(entry.name)) {
        stylesheets[key] = await readFile(absolute, "utf8");
      } else if (entry.isFile() && COMPONENT_EXTENSION.test(entry.name)) {
        components[key] = await readFile(absolute, "utf8");
      }
    }
  };
  await visit(resolve(root, WEB_SOURCE));
  return { stylesheets, components };
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const { stylesheets, components } = await rendererFiles(root);
  const findings = findStylesheetFindings(stylesheets, collectPrimitiveClasses(components));
  const baselineFile = resolve(root, BASELINE_PATH);

  if (process.argv.includes("--write-baseline")) {
    await writeFile(baselineFile, serializeBaseline(findings));
    console.log(`Wrote ${BASELINE_PATH}.`);
    return;
  }

  const baseline = JSON.parse(await readFile(baselineFile, "utf8")) as StylesheetBaseline;
  const problems = compareWithBaseline(findings, baseline);
  if (problems.length === 0) {
    console.log("Stylesheets match the type scale, motion, and colour contract.");
    return;
  }

  for (const problem of problems) {
    if (problem.kind === "stale") {
      console.error(
        `${problem.file}: ${problem.rule} fell from ${String(problem.recorded)} to ${String(problem.current)}; run \`bun scripts/check-ui-stylesheets.ts --write-baseline\` to record the improvement.`,
      );
      continue;
    }
    console.error(
      `${problem.file}: ${problem.rule} rose from ${String(problem.recorded)} to ${String(problem.current)}:`,
    );
    for (const finding of findings) {
      if (finding.rule === problem.rule && finding.file === problem.file) {
        console.error(`  ${finding.file}:${String(finding.line)} ${finding.detail}`);
      }
    }
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();
