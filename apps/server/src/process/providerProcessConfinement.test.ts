import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Confinement gate for provider runtime launches.
 *
 * 0009 says every Octant-spawned subprocess that can execute arbitrary code
 * launches through the shared builder, and unit coverage cannot see when one
 * stops doing so: a driver that spawns its runtime directly is green, shipped,
 * and only visible to a grep. Three provider process modules had drifted out of
 * the rule that way with nothing recording it, which is what 0138 settles. This
 * gate keeps that record and the code in agreement in both directions — a
 * module that drops the builder fails until 0138 names its file, and a name
 * 0138 keeps after the module is wrapped again fails too.
 */
const here = dirname(fileURLToPath(import.meta.url));
const providersDirectory = join(here, "..", "providers");
const decisionPath = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "decisions",
  "0138-confinement-wraps-a-runtime-that-carries-one-thread.md",
);

const CONFINEMENT_MODULE = "../process/seatbeltProfile";

function providerProcessModules(): ReadonlyArray<string> {
  return readdirSync(providersDirectory)
    .filter((entry) => entry.endsWith("Process.ts") && !entry.includes(".test."))
    .sort();
}

function preparesConfinedLaunch(fileName: string): boolean {
  return readFileSync(join(providersDirectory, fileName), "utf8").includes(CONFINEMENT_MODULE);
}

describe("provider runtime confinement", () => {
  it("finds provider process modules to check", () => {
    expect(providerProcessModules().length).toBeGreaterThan(0);
  });

  it("names every provider runtime that launches without the shared confinement builder", () => {
    const record = readFileSync(decisionPath, "utf8");
    const unnamed = providerProcessModules()
      .filter((fileName) => !preparesConfinedLaunch(fileName))
      .filter((fileName) => !record.includes(`\`${fileName}\``));
    expect(unnamed).toEqual([]);
  });

  it("stops naming a provider runtime once it launches through the shared builder", () => {
    const record = readFileSync(decisionPath, "utf8");
    const stale = providerProcessModules()
      .filter((fileName) => preparesConfinedLaunch(fileName))
      .filter((fileName) => record.includes(`\`${fileName}\``));
    expect(stale).toEqual([]);
  });
});
