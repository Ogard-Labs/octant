import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY = join(import.meta.dirname, "../../../..");
const SOURCE_ROOTS = [
  "apps/server/src",
  "packages/contracts/src",
  "packages/plugin-host/src",
  "packages/provider-sdk/src",
];

function sourceFiles(directory: string): ReadonlyArray<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test(-support)?\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every complete `octant_*` string literal in shipped first-party source. */
export function firstPartyToolNames(): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const root of SOURCE_ROOTS)
    for (const file of sourceFiles(join(REPOSITORY, root)))
      for (const match of readFileSync(file, "utf8").matchAll(
        /["'`](octant_[a-z]+(?:_[a-z]+)*)["'`]/g,
      ))
        if (match[1] !== undefined) names.add(match[1]);
  return [...names].sort();
}
