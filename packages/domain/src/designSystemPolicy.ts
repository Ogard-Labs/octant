import {
  CANVAS_MAX_DESIGN_BRAND_TOKENS,
  CANVAS_MAX_DESIGN_BRAND_VALUE_LENGTH,
} from "@octant/contracts/canvas";
import {
  DESIGN_SYSTEM_FILE_NAME,
  type DesignSystemChoice,
  type DesignSystemFrontMatterState,
  type DesignSystemLocation,
  type DesignSystemReading,
  type DesignSystemToken,
  type DesignSystemTokenGroup,
} from "@octant/contracts/design-systems";
import { designBrandFontFamilyIsSafe, designBrandTokenRefusal } from "./canvasDesignFrameKit";

/**
 * The front matter of a `DESIGN.md`, split from its prose. The parse of the
 * YAML itself belongs to the caller (the host has a YAML reader; the domain
 * takes no dependency for it), so this only finds the fence.
 */
export function splitDesignSystemFrontMatter(text: string): {
  readonly frontMatter: string | undefined;
  readonly body: string;
} {
  const normalized = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontMatter: undefined, body: normalized };
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end === -1) return { frontMatter: undefined, body: normalized };
  return {
    frontMatter: lines.slice(1, end).join("\n"),
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\s*\n/, ""),
  };
}

/**
 * The front-matter groups Octant reads and the brand kind each becomes. A
 * file may use either spelling; the first is the one Octant writes.
 */
const TOKEN_GROUPS: ReadonlyArray<{
  readonly group: DesignSystemTokenGroup;
  readonly keys: ReadonlyArray<string>;
}> = [
  { group: "color", keys: ["colors", "colours", "color", "colour"] },
  { group: "font", keys: ["typography", "fonts", "font"] },
  { group: "radius", keys: ["radius", "radii", "rounded"] },
  { group: "space", keys: ["spacing", "space"] },
];

const DESCRIPTIVE_KEYS = new Set(["name", "title", "description", "version"]);

/** `primaryHover` and `Primary Hover` both become `primary-hover`. */
function tokenSlug(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * A typography entry may be a family stack, or an object that names one
 * (`fontFamily`, `family`); size and weight belong to the prose and code,
 * since a brand carries families alone.
 */
function tokenValue(group: DesignSystemTokenGroup, value: unknown): string | undefined {
  const scalar = scalarText(value);
  if (scalar !== undefined) {
    // A bare number in a radius or spacing scale means pixels, as CSS writers read it.
    return (group === "radius" || group === "space") && typeof value === "number"
      ? `${scalar}px`
      : scalar;
  }
  if (group === "font" && isRecord(value)) {
    return scalarText(value["fontFamily"] ?? value["family"] ?? value["font-family"]);
  }
  return undefined;
}

/**
 * A font stack keeps the faces Canvas can draw: no design loads a web font, so
 * a stack that opens with a brand face falls back to the system faces it
 * names, and says so. A stack with none left is refused.
 */
function fontToken(
  base: Omit<DesignSystemToken, "status" | "note" | "carriedValue">,
): DesignSystemToken {
  const families = base.value
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
    .filter((family) => family !== "");
  const kept = families.filter(designBrandFontFamilyIsSafe);
  const dropped = families.filter((family) => !designBrandFontFamilyIsSafe(family));
  if (kept.length === 0) {
    return {
      ...base,
      status: "refused",
      note: "Canvas loads no web fonts; add a system face or a generic family such as sans-serif to the stack",
    };
  }
  const carriedValue = kept.join(", ");
  if (dropped.length === 0 && carriedValue === base.value) return { ...base, status: "carried" };
  return {
    ...base,
    status: "adjusted",
    carriedValue,
    ...(dropped.length === 0
      ? {}
      : { note: `Canvas draws ${carriedValue}; it loads no web font for ${dropped.join(", ")}` }),
  };
}

function readToken(group: DesignSystemTokenGroup, key: string, raw: unknown): DesignSystemToken {
  const token = `${group}-${tokenSlug(key)}`;
  const value = tokenValue(group, raw);
  if (value === undefined || value === "") {
    return { group, key, token, value: "", status: "refused", note: "not a single value" };
  }
  const base = { group, key, token, value };
  if (!/^(?:color|font|radius|space)-[a-z0-9][a-z0-9-]{0,31}$/.test(token)) {
    return { ...base, status: "refused", note: "the name is not a short lowercase slug" };
  }
  if (value.length > CANVAS_MAX_DESIGN_BRAND_VALUE_LENGTH) {
    return {
      ...base,
      status: "refused",
      note: `longer than ${String(CANVAS_MAX_DESIGN_BRAND_VALUE_LENGTH)} characters`,
    };
  }
  if (group === "font") {
    const font = fontToken(base);
    const refusal =
      font.status === "refused"
        ? undefined
        : designBrandTokenRefusal(token, font.carriedValue ?? value);
    return refusal === undefined ? font : { ...base, status: "refused", note: refusal };
  }
  const refusal = designBrandTokenRefusal(token, value);
  return refusal === undefined
    ? { ...base, status: "carried" }
    : { ...base, status: "refused", note: refusal };
}

/**
 * The text of a heading at exactly this level, or undefined. Scanned once
 * rather than matched with a regex: a pattern with a lazy capture between two
 * whitespace runs backtracked quadratically on a long run of tabs, and the
 * file is the person's, so any text may arrive.
 */
function headingText(line: string, level: 1 | 2): string | undefined {
  const marker = "#".repeat(level);
  if (!line.startsWith(marker)) return undefined;
  const after = line.charAt(level);
  if (after !== " " && after !== "\t") return undefined;
  let end = line.length;
  while (end > level && " \t#".includes(line.charAt(end - 1))) end -= 1;
  const text = line.slice(level, end).trim();
  return text === "" ? undefined : text;
}

function sectionsOf(body: string): ReadonlyArray<string> {
  const sections: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = headingText(line, 2);
    if (heading !== undefined) sections.push(heading);
  }
  return sections;
}

function titleOf(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const heading = headingText(line, 1);
    if (heading !== undefined) return heading;
  }
  return undefined;
}

/**
 * Read a design system: its name, its tokens and what each becomes in a
 * Canvas brand, and the shape of its prose. `frontMatter` is the parsed YAML
 * (or undefined when the file has none, or the parse failed: `parseFailed`).
 *
 * Tokens are read in file order and at most the brand's limit are carried;
 * the rest are listed as refused so the person sees what Canvas leaves out.
 */
export function readDesignSystem(input: {
  readonly frontMatter: unknown;
  readonly hasFrontMatter: boolean;
  readonly body: string;
  /** Used when neither the front matter nor a heading names the system. */
  readonly fallbackName: string;
}): DesignSystemReading {
  const state: DesignSystemFrontMatterState = !input.hasFrontMatter
    ? "absent"
    : isRecord(input.frontMatter)
      ? "parsed"
      : "invalid";
  const record = state === "parsed" && isRecord(input.frontMatter) ? input.frontMatter : {};
  const tokens: DesignSystemToken[] = [];
  const brand: Record<string, string> = {};
  const ignoredKeys: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(record)) {
    const group = TOKEN_GROUPS.find((candidate) => candidate.keys.includes(key.toLowerCase()));
    if (group === undefined) {
      if (!DESCRIPTIVE_KEYS.has(key.toLowerCase())) ignoredKeys.push(key);
      continue;
    }
    if (!isRecord(value)) {
      ignoredKeys.push(key);
      continue;
    }
    for (const [tokenKey, raw] of Object.entries(value)) {
      let token = readToken(group.group, tokenKey, raw);
      if (token.status !== "refused" && seen.has(token.token)) {
        token = { ...token, status: "refused", note: `${token.token} is already defined above` };
      } else if (
        token.status !== "refused" &&
        Object.keys(brand).length >= CANVAS_MAX_DESIGN_BRAND_TOKENS
      ) {
        token = {
          ...token,
          status: "refused",
          note: `Canvas carries at most ${String(CANVAS_MAX_DESIGN_BRAND_TOKENS)} tokens`,
        };
      }
      if (token.status !== "refused") {
        seen.add(token.token);
        brand[token.token] = token.carriedValue ?? token.value;
      }
      tokens.push(token);
    }
  }
  const named = scalarText(record["name"]) ?? scalarText(record["title"]);
  const description = scalarText(record["description"]);
  return {
    name: named !== undefined && named !== "" ? named : (titleOf(input.body) ?? input.fallbackName),
    ...(description === undefined || description === "" ? {} : { description }),
    frontMatter: state,
    tokens,
    brand,
    ignoredKeys,
    sections: sectionsOf(input.body),
    body: input.body,
  };
}

/** A design system's name when nothing in it gives one: its folder, or the Project. */
export function designSystemFallbackName(path: string, projectName: string): string {
  const segments = path.split("/");
  return segments.length > 1 ? (segments.at(-2) ?? projectName) : projectName;
}

/**
 * The Project's own design system. A person's choice wins: a named file (when
 * it is there) or none at all. Without one, it is the `DESIGN.md` at the top
 * of the main folder, else the only one the Project has; several nested ones
 * with none at the top govern their own folders and none speaks for the whole
 * Project.
 */
export function primaryDesignSystem<T extends DesignSystemLocation>(
  systems: ReadonlyArray<T>,
  mainFolder: string,
  choice?: DesignSystemChoice,
): T | undefined {
  if (choice?.kind === "none") return undefined;
  if (choice?.kind === "file") {
    return systems.find((system) => system.folder === choice.folder && system.path === choice.path);
  }
  const top = systems.find(
    (system) => system.folder === mainFolder && system.path === DESIGN_SYSTEM_FILE_NAME,
  );
  if (top !== undefined) return top;
  return systems.length === 1 ? systems[0] : undefined;
}

/**
 * What a turn is told about design systems beyond the primary one's text: the
 * rule that the nearest `DESIGN.md` governs, and where the others are.
 */
export function designSystemInstructions(input: {
  readonly primary: DesignSystemLocation | undefined;
  readonly others: ReadonlyArray<DesignSystemLocation>;
  readonly mainFolder: string;
}): string {
  const where = (system: DesignSystemLocation) =>
    system.folder === input.mainFolder ? system.path : `${system.folder}/${system.path}`;
  const lines = [
    `This Project keeps its design system in ${DESIGN_SYSTEM_FILE_NAME}. Follow it for anything a person sees: user interface code, styles, and components, and every document, deck, design, or diagram you make with Canvas. Use its tokens rather than inventing colours, type, radii, or spacing, and follow its written rules. A ${DESIGN_SYSTEM_FILE_NAME} governs the files under its own folder; the nearest one above a file wins. Change a ${DESIGN_SYSTEM_FILE_NAME} only when the person asks you to.`,
  ];
  if (input.primary !== undefined) {
    lines.push(`The Project's design system is ${where(input.primary)}, given below.`);
  }
  if (input.others.length > 0) {
    lines.push(
      `Other design systems in this Project (read the one that governs a folder before working there): ${input.others.map(where).join(", ")}.`,
    );
  }
  return lines.join("\n\n");
}

/** A new design system: front matter with a starter palette, then the sections people fill. */
export function designSystemTemplate(name: string): string {
  const title = name.trim() === "" ? "Design system" : name.trim();
  return [
    "---",
    `name: ${JSON.stringify(title)}`,
    'description: "How this product looks, reads, and behaves."',
    "colors:",
    '  primary: "#2563eb"',
    '  on-primary: "#ffffff"',
    '  background: "#ffffff"',
    '  surface: "#f6f6f7"',
    '  text: "#18181b"',
    '  muted: "#52525b"',
    '  border: "#d4d4d8"',
    '  success: "#15803d"',
    '  warning: "#b45309"',
    '  danger: "#b91c1c"',
    "typography:",
    '  heading: "system-ui, sans-serif"',
    '  body: "system-ui, sans-serif"',
    '  mono: "ui-monospace, monospace"',
    "radius:",
    "  sm: 6px",
    "  md: 10px",
    "  pill: 999px",
    "spacing:",
    "  xs: 4px",
    "  sm: 8px",
    "  md: 16px",
    "  lg: 24px",
    "  xl: 32px",
    "---",
    "",
    `# ${title}`,
    "",
    "## Principles",
    "",
    "- What this product should feel like, in three or four short lines.",
    "",
    "## Colour",
    "",
    "- `primary` is for the one main action on a screen; never for decoration.",
    "- Text sits on `background` or `surface` and keeps at least 4.5:1 contrast.",
    "",
    "## Typography",
    "",
    "- `heading` for titles, `body` for everything else, `mono` for code and numbers that align.",
    "",
    "## Layout",
    "",
    "- Space comes from the `spacing` scale; radii from `radius`.",
    "",
    "## Components",
    "",
    "- Buttons, fields, cards, and the states each one has.",
    "",
    "## Voice",
    "",
    "- How the product writes: plain, short, and specific.",
    "",
  ].join("\n");
}
