import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The phone runs its code on Hermes, which has none of the newer array and
 * string methods below. TypeScript's library allows them, so nothing else
 * stops one: in November 2026 a `toSorted` in the Pull requests list threw
 * "undefined is not a function" as the place opened, and the app crashed.
 */
const MISSING_ON_HERMES =
  /\.(toSorted|toReversed|toSpliced|isWellFormed|toWellFormed)\(|\b(Object|Map)\.groupBy\(/;

function sources(directory: string): ReadonlyArray<string> {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the phone's code on Hermes", () => {
  it("calls no method Hermes lacks, in the app or the phone's clients", () => {
    const runtime = resolve(import.meta.dirname, "../../../packages/client-runtime/src");
    const files = [
      ...sources(resolve(import.meta.dirname)),
      ...sources(runtime).filter((path) => /\/mobile[^/]*\.ts$/.test(path)),
    ];
    const offending = files.filter((path) => MISSING_ON_HERMES.test(readFileSync(path, "utf8")));
    expect(offending).toEqual([]);
  });
});
