/**
 * Rewrites apps/web from the previous icon family's package to the app's own
 * icon module (apps/web/src/ui/icons), which exports the same names. Run it once
 * when the swap lands; `--dry-run` lists what it would change.
 *
 *   bun scripts/swap-icons.ts [--dry-run] [<web src folder>]
 *
 * What it rewrites, in files that import the old package:
 *   - the import path, relative to the file;
 *   - the type names LucideIcon, LucideProps and LucideProvider, which the module
 *     exports as IconComponent, IconProps and IconProvider.
 * And, in any file, the `svg.lucide-<name>` class selectors that tests use,
 * which the module draws as `svg.octant-icon-<name>`.
 *
 * It leaves ui/icons itself and ui/iconScaleContract.test.ts alone: that test
 * names the old package as data and is edited by hand with the swap.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const srcRoot = resolve(args.find((arg) => !arg.startsWith("--")) ?? "apps/web/src");
const iconsFolder = join(srcRoot, "ui", "icons");
const SKIPPED = new Set([join(srcRoot, "ui", "iconScaleContract.test.ts")]);
const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["LucideIcon", "IconComponent"],
  ["LucideProps", "IconProps"],
  ["LucideProvider", "IconProvider"],
];

function* sourceFiles(folder: string): Generator<string> {
  for (const entry of readdirSync(folder)) {
    if (entry === "node_modules") continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry)) yield path;
  }
}

function moduleSpecifier(file: string): string {
  const path = relative(dirname(file), iconsFolder);
  return path.startsWith(".") ? path : `./${path}`;
}

export function swap(file: string, source: string): string {
  let next = source;
  if (/from\s+"lucide-react"/.test(next)) {
    next = next.replace(/(from\s+)"lucide-react"/g, `$1"${moduleSpecifier(file)}"`);
    for (const [from, to] of RENAMES) next = next.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return next.replace(/svg\.lucide-/g, "svg.octant-icon-");
}

if (import.meta.main) {
  const changed: Array<string> = [];
  for (const file of sourceFiles(srcRoot)) {
    if (file.startsWith(iconsFolder) || SKIPPED.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const next = swap(file, source);
    if (next === source) continue;
    changed.push(relative(srcRoot, file));
    if (!dryRun) writeFileSync(file, next);
  }
  console.log(`${dryRun ? "would change" : "changed"} ${String(changed.length)} files`);
  for (const file of changed) console.log(file);
}
