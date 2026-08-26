import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const WEB_SOURCE = "apps/web/src";
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;
const BASE_UI_IMPORT = /from\s+["']@base-ui\/react(?:\/[^"']+)?["']/;
const SHADCN_IMPORT = /from\s+["'][^"']*ui\/shadcn(?:\/[^"']+)?["']/;
const RAW_CONTROL_OPENING_TAG = /<\s*(button|select|textarea|input|dialog)(?=\s|>)/g;
const RAW_CONTROL_EXCEPTION = /\{?\/\*\s*ui-boundary-exception:\s*([a-z-]+)\s*\*\/\}?\s*$/i;
const OCTANT_INPUT_TYPE = /\btype\s*=\s*["'](checkbox|radio)["']/g;
const OCTANT_INPUT_OPEN = /<OctantInput\b/g;

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
    OCTANT_INPUT_TYPE.lastIndex = 0;
    for (const match of source.matchAll(OCTANT_INPUT_TYPE)) {
      const index = match.index ?? 0;
      const preceding = source.slice(Math.max(0, index - 400), index);
      let nearestName: string | undefined;
      let nearestIndex = -1;
      OCTANT_INPUT_OPEN.lastIndex = 0;
      for (const open of preceding.matchAll(OCTANT_INPUT_OPEN)) {
        const openIndex = open.index ?? 0;
        if (openIndex >= nearestIndex) {
          nearestIndex = openIndex;
          nearestName = "OctantInput";
        }
      }
      if (nearestName !== "OctantInput") continue;
      const line = source.slice(0, index).split("\n").length;
      const type = match[1] ?? "checkbox";
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
  const violations = [
    ...importViolations,
    ...ordinary.map(
      (finding) =>
        `${finding.file}:${String(finding.line)} renders raw <${finding.tag}>; import the corresponding Octant adapter.`,
    ),
    ...adapterViolations,
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
}

if (import.meta.main) await main();
