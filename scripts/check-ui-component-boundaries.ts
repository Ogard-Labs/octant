import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const WEB_SOURCE = "apps/web/src";
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;
const BASE_UI_IMPORT = /from\s+["']@base-ui\/react(?:\/[^"']+)?["']/;
const SHADCN_IMPORT = /from\s+["'][^"']*ui\/shadcn(?:\/[^"']+)?["']/;
const RAW_CONTROL_OPENING_TAG = /<\s*(button|select|textarea|input|dialog)(?=\s|>)/g;
const RAW_CONTROL_EXCEPTION = /\{?\/\*\s*ui-boundary-exception:\s*([a-z-]+)\s*\*\/\}?\s*$/i;
const FORM_OPEN = /<form\b/g;
const OCTANT_INPUT_OPEN = /<OctantInput\b/g;
const OCTANT_INPUT_CHOICE_TYPE =
  /\btype\s*=\s*(?:["'](checkbox|radio)["']|\{\s*["'](checkbox|radio)["']\s*\})/;

export type RawControlException =
  | "native-file-input"
  | "native-platform-control"
  | "specialized-editor-surface";

export type RawControlTag = "button" | "select" | "textarea" | "input" | "dialog";

export interface RawControlFinding {
  readonly category: "ordinary" | RawControlException;
  readonly file: string;
  readonly line: number;
  readonly tag: RawControlTag;
}

export function findUiComponentBoundaryViolations(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    if (BASE_UI_IMPORT.test(source) && !normalized.startsWith(`${WEB_SOURCE}/ui/`)) {
      violations.push(`${normalized} imports @base-ui/react outside apps/web/src/ui.`);
    }
    if (SHADCN_IMPORT.test(source) && !normalized.startsWith(`${WEB_SOURCE}/ui/base/`)) {
      violations.push(`${normalized} imports ui/shadcn outside apps/web/src/ui/base.`);
    }
  }
  return violations;
}

/**
 * Reports raw controls in production feature code. Ordinary findings fail the
 * repository check; the only accepted exceptions are native controls whose
 * semantics cannot be represented by an Octant adapter.
 */
export function findRawControlInventory(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<RawControlFinding> {
  const findings: RawControlFinding[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    if (
      !normalized.startsWith(`${WEB_SOURCE}/`) ||
      normalized.startsWith(`${WEB_SOURCE}/ui/`) ||
      normalized.includes(".test.")
    ) {
      continue;
    }
    RAW_CONTROL_OPENING_TAG.lastIndex = 0;
    for (const match of source.matchAll(RAW_CONTROL_OPENING_TAG)) {
      const tag = match[1] as RawControlTag;
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      const marker = source
        .slice(Math.max(0, index - 240), index)
        .match(RAW_CONTROL_EXCEPTION)?.[1]
        ?.toLowerCase();
      const selfClosingEnd = tag === "input" ? source.indexOf("/>", index) : -1;
      const openingContext = source.slice(
        index,
        selfClosingEnd < 0 ? index + 600 : selfClosingEnd + 2,
      );
      const category: RawControlFinding["category"] =
        tag === "input" && /\btype\s*=\s*["']file["']/.test(openingContext)
          ? "native-file-input"
          : marker === "native-file-input" ||
              marker === "native-platform-control" ||
              marker === "specialized-editor-surface"
            ? (marker as RawControlException)
            : "ordinary";
      findings.push({ category, file: normalized, line, tag });
    }
  }
  return findings;
}

export function findRawControlBoundaryViolations(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  return findRawControlInventory(files)
    .filter((finding) => finding.category === "ordinary")
    .map(
      (finding) =>
        `${finding.file}:${String(finding.line)} renders raw <${finding.tag}>; import the corresponding Octant adapter.`,
    );
}

const RAW_LIVE_REGION_ROLE =
  /role\s*=\s*(?:["'](alert|dialog)["']|\{\s*[^}\n]*["'](alert|dialog)["'][^}\n]*\})/g;
const LIVE_REGION_EXCEPTION =
  /\/\*\s*ui-boundary-exception:\s*(inline-field-error|compact-status|screen-reader-announcement|non-modal-panel|positioned-banner|empty-state)\s*\*\/\s*\}?\s*$/i;
const LIVE_REGION_RECIPE_FILES = new Set([
  `${WEB_SOURCE}/ui/base/OctantAlert.tsx`,
  `${WEB_SOURCE}/ui/base/OctantToast.tsx`,
  `${WEB_SOURCE}/ui/base/OctantApprovalCard.tsx`,
  `${WEB_SOURCE}/ui/shadcn/field.tsx`,
  `${WEB_SOURCE}/shell/ShellState.tsx`,
]);
const LIVE_REGION_RECIPE_TAGS = new Set([
  "OctantAlert",
  "OctantToast",
  "OctantDialog",
  "OctantConfirmDialog",
  "ShellState",
  "FieldError",
  "OctantEmptyRoot",
  "OctantEmpty",
  "OctantApprovalCard",
  "UnavailableNotice",
]);

export type LiveRegionException =
  | "inline-field-error"
  | "compact-status"
  | "screen-reader-announcement"
  | "non-modal-panel"
  | "positioned-banner"
  | "empty-state"
  | "recipe";

export interface RawLiveRegionFinding {
  readonly category: "ordinary" | LiveRegionException;
  readonly file: string;
  readonly line: number;
  readonly role: "alert" | "dialog";
  readonly tag: string;
}

function isInsideJsString(source: string, index: number): boolean {
  let quote: "'" | '"' | "`" | undefined;
  let i = 0;
  while (i < index) {
    if (quote === "`") {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === "`") quote = undefined;
      i += 1;
      continue;
    }
    if (quote !== undefined) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    i += 1;
  }
  return quote !== undefined;
}

function jsxTagAt(
  source: string,
  index: number,
): { readonly tag: string; readonly start: number } | undefined {
  let i = index;
  while (i > 0 && source[i] !== "<") i -= 1;
  const match = /^<([A-Za-z][\w.]*)/.exec(source.slice(i));
  const tag = match?.[1];
  if (tag === undefined) return undefined;
  return { tag, start: i };
}

/** Raw alert and dialog roles outside the shared recipes. Recorded exceptions stay. */
export function findRawLiveRegionInventory(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<RawLiveRegionFinding> {
  const findings: RawLiveRegionFinding[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    if (!normalized.startsWith(`${WEB_SOURCE}/`) || normalized.includes(".test.")) continue;
    RAW_LIVE_REGION_ROLE.lastIndex = 0;
    for (const match of source.matchAll(RAW_LIVE_REGION_ROLE)) {
      const index = match.index ?? 0;
      if (isInsideJsString(source, index)) continue;
      const role = match[1] ?? match[2];
      if (role !== "alert" && role !== "dialog") continue;
      const located = jsxTagAt(source, index);
      const tag = located?.tag ?? "?";
      const tagStart = located?.start ?? index;
      const line = source.slice(0, index).split("\n").length;
      const beforeTag = source.slice(Math.max(0, tagStart - 240), tagStart);
      const marker = beforeTag.match(LIVE_REGION_EXCEPTION)?.[1]?.toLowerCase();
      const category: RawLiveRegionFinding["category"] =
        LIVE_REGION_RECIPE_FILES.has(normalized) || LIVE_REGION_RECIPE_TAGS.has(tag)
          ? "recipe"
          : marker === "inline-field-error" ||
              marker === "compact-status" ||
              marker === "screen-reader-announcement" ||
              marker === "non-modal-panel" ||
              marker === "positioned-banner" ||
              marker === "empty-state"
            ? marker
            : "ordinary";
      findings.push({ category, file: normalized, line, role, tag });
    }
  }
  return findings;
}

export function findRawLiveRegionViolations(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  return findRawLiveRegionInventory(files)
    .filter((finding) => finding.category === "ordinary")
    .map(
      (finding) =>
        `${finding.file}:${String(finding.line)} renders raw role="${finding.role}" on <${finding.tag}>; use OctantAlert, OctantToast, OctantDialog, or OctantConfirmDialog, or record an exception.`,
    );
}

function maskComments(source: string): string {
  const preserveLines = (value: string): string => value.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, preserveLines).replace(/\/\/[^\n]*/g, preserveLines);
}

function jsxOpeningTag(source: string, start: number, tagName: string): string | undefined {
  let quote: '"' | "'" | "`" | undefined;
  let braces = 0;
  for (let i = start + tagName.length + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === undefined) break;
    if (quote !== undefined) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      braces += 1;
      continue;
    }
    if (ch === "}" && braces > 0) {
      braces -= 1;
      continue;
    }
    if (braces === 0 && ch === ">") {
      return source.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Product forms own their validation copy and recovery instead of delegating
 * to browser-specific bubbles. Test fixtures remain outside the product gate. */
export function findFormValidationOwnerViolations(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    if (!normalized.startsWith(`${WEB_SOURCE}/`) || normalized.includes(".test.")) continue;
    const searchable = maskComments(source);
    FORM_OPEN.lastIndex = 0;
    for (const match of searchable.matchAll(FORM_OPEN)) {
      const openIndex = match.index ?? 0;
      const tag = jsxOpeningTag(searchable, openIndex, "form");
      if (tag === undefined || /\bnovalidate\b/i.test(tag)) continue;
      const line = source.slice(0, openIndex).split("\n").length;
      violations.push(
        `${normalized}:${String(line)} renders an app-owned form without noValidate.`,
      );
    }
  }
  return violations;
}

/**
 * Checkbox and radio choices have owned recipes. Using the text-input adapter
 * for those types is the same leak as a raw control: the wrong primitive paints
 * and the check would otherwise stay green.
 */
export function findWrongAdapterBoundaryViolations(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    if (
      !normalized.startsWith(`${WEB_SOURCE}/`) ||
      normalized.startsWith(`${WEB_SOURCE}/ui/`) ||
      normalized.includes(".test.")
    ) {
      continue;
    }
    OCTANT_INPUT_OPEN.lastIndex = 0;
    for (const match of source.matchAll(OCTANT_INPUT_OPEN)) {
      const openIndex = match.index ?? 0;
      const tag = jsxOpeningTag(source, openIndex, "OctantInput");
      if (tag === undefined) continue;
      const typeMatch = OCTANT_INPUT_CHOICE_TYPE.exec(tag);
      if (typeMatch === null) continue;
      const line = source.slice(0, openIndex + (typeMatch.index ?? 0)).split("\n").length;
      const type = typeMatch[1] ?? typeMatch[2] ?? "checkbox";
      violations.push(
        `${normalized}:${String(line)} uses OctantInput type="${type}"; import OctantCheckbox or OctantToggleGroup.`,
      );
    }
  }
  return violations;
}

async function sourceFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) {
        files[relative(root, absolute).split(sep).join("/")] = await readFile(absolute, "utf8");
      }
    }
  };
  await visit(resolve(root, WEB_SOURCE));
  return files;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const files = await sourceFiles(root);
  const importViolations = findUiComponentBoundaryViolations(files);
  const rawControls = findRawControlInventory(files);
  const ordinary = rawControls.filter((finding) => finding.category === "ordinary");
  const exceptions = rawControls.filter((finding) => finding.category !== "ordinary");
  const adapterViolations = findWrongAdapterBoundaryViolations(files);
  const formViolations = findFormValidationOwnerViolations(files);
  const liveRegions = findRawLiveRegionInventory(files);
  const liveViolations = liveRegions.filter((finding) => finding.category === "ordinary");
  const liveExceptions = liveRegions.filter(
    (finding) => finding.category !== "ordinary" && finding.category !== "recipe",
  );
  const violations = [
    ...importViolations,
    ...ordinary.map(
      (finding) =>
        `${finding.file}:${String(finding.line)} renders raw <${finding.tag}>; import the corresponding Octant adapter.`,
    ),
    ...adapterViolations,
    ...formViolations,
    ...liveViolations.map(
      (finding) =>
        `${finding.file}:${String(finding.line)} renders raw role="${finding.role}" on <${finding.tag}>; use OctantAlert, OctantToast, OctantDialog, or OctantConfirmDialog, or record an exception.`,
    ),
  ];
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exitCode = 1;
    return;
  }
  console.log("UI component boundaries are valid.");
  if (exceptions.length > 0) {
    console.log(
      `Documented raw-control exceptions: ${String(exceptions.length)} platform controls.`,
    );
    for (const finding of exceptions) {
      console.log(
        `  ${finding.file}:${String(finding.line)} <${finding.tag}> (${finding.category})`,
      );
    }
  }
  if (liveExceptions.length > 0) {
    console.log(`Documented raw alert/dialog exceptions: ${String(liveExceptions.length)}.`);
    for (const finding of liveExceptions) {
      console.log(
        `  ${finding.file}:${String(finding.line)} role=${finding.role} (${finding.category})`,
      );
    }
  }
}

if (import.meta.main) await main();
