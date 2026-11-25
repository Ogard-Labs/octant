import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { SYSTEM_SYMBOLS } from "./symbols";

function sources(directory: string): ReadonlyArray<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

it("draws a system symbol for every icon the app names", () => {
  const root = resolve(import.meta.dirname, "..");
  const glyphs = JSON.parse(
    readFileSync(
      resolve(
        root,
        "../../../node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json",
      ),
      "utf8",
    ),
  ) as Readonly<Record<string, number>>;
  const missing = new Set<string>();
  for (const path of sources(root)) {
    if (path.endsWith("symbols.ts")) continue;
    for (const [, name] of readFileSync(path, "utf8").matchAll(
      /(?:icon|selectedIcon|name|Icon)(?:=\{?|: )[^\n]*?"([a-z]+(?:-[a-z]+)*)"/g,
    ))
      if (name !== undefined && name.includes("-") && name in glyphs && !(name in SYSTEM_SYMBOLS))
        missing.add(name);
  }
  expect([...missing]).toEqual([]);
});
