import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const WEB_SOURCE = "apps/web/src";
const MOBILE_SOURCE = "apps/mobile";
const SOURCE_EXTENSION = /\.(?:ts|tsx)$/;

// Allow hex/rgb/rgba/hsl literals in theme data, theme-editing UI, tests,
// and the mobile design-system token source. All other .tsx views should
// consume CSS variables or theme tokens.
const EXEMPT_PREFIXES = [
  `${WEB_SOURCE}/ui/shadcn/`,
  `${WEB_SOURCE}/theme/`,
  `${WEB_SOURCE}/zen/`,
  // TODO: remove the mobile exemption once design-system tokens come from @octant/theme.
  `${MOBILE_SOURCE}/`,
];
const EXEMPT_SUFFIXES = [".test.ts", ".test.tsx"];

// Match a CSS color literal: #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb, rgba, hsl, hsla.
const COLOR_LITERAL =
  /(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgb|hsl)a?\([^)]*\))/g;

function isExempt(normalized: string): boolean {
  for (const prefix of EXEMPT_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  for (const suffix of EXEMPT_SUFFIXES) {
    if (normalized.endsWith(suffix)) return true;
  }
  return false;
}

async function sourceFiles(
  root: string,
  ...directories: ReadonlyArray<string>
): Promise<Readonly<Record<string, string>>> {
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
  for (const dir of directories) {
    await visit(resolve(root, dir));
  }
  return files;
}

export function findUiColorLiteralViolations(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const [file, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const normalized = file.split(sep).join("/");
    if (isExempt(normalized)) continue;

    COLOR_LITERAL.lastIndex = 0;
    for (const match of source.matchAll(COLOR_LITERAL)) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      violations.push(`${normalized}:${String(line)} uses a hardcoded color: ${String(match[0])}`);
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const files = await sourceFiles(root, WEB_SOURCE, MOBILE_SOURCE);
  const violations = findUiColorLiteralViolations(files);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exitCode = 1;
    return;
  }
  console.log("No hardcoded color literals found outside theme data and exempt editor surfaces.");
}

if (import.meta.main) await main();
