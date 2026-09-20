import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Confinement gate for provider runtime launches.
 *
 * 0009 says every Octant-spawned subprocess that can execute arbitrary code
 * launches through the shared builder, and unit coverage cannot see a module
 * that stops doing so: a driver that spawns its runtime directly is green,
 * shipped, and visible only to a grep. Three provider process modules had
 * drifted out of the rule that way with nothing recording it, which is what
 * 0141 settles.
 *
 * What this proves: a provider process module either uses the shared builder or
 * appears in {@link UNWRAPPED} with a reason, and 0141 names each one that does
 * not. What it does not prove: that every launch inside a wrapped module goes
 * through the builder. A wrapped module still spawns directly for its version
 * probe, and on Full access returns the binary unwrapped by design, so a
 * per-launch claim would need each module to declare its launches in a manifest
 * this gate could read rather than a source scan. The observed failure was
 * whole modules never adopting the builder, and that is the failure this
 * catches. Its reach is the provider runtime modules only: discovery scans run
 * candidate executables from `discoveryService`, which this never reads, and
 * the threat model carries that gap instead.
 *
 * {@link UNWRAPPED}, not 0141, is the live set. An accepted record keeps its
 * history — a later ADR supersedes it rather than editing it — so reading the
 * live set out of 0141 would make confining Codex fail this suite until someone
 * deleted that history. Confining a runtime deletes its entry here instead.
 */
const UNWRAPPED: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
  {
    file: "claudeProcess.ts",
    reason: "The Agent SDK composes the launch and passes no mode or execution policy.",
  },
  {
    file: "codexProcess.ts",
    reason: "One app-server carries every thread on a provider instance, so it has no one root.",
  },
  {
    file: "ohMyPiProcess.ts",
    reason: "A probe with no turn, unconfined against 0009 and 0122 both. Held, not excused.",
  },
];

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
  "0141-confinement-wraps-a-runtime-that-carries-one-thread.md",
);

function providerProcessModules(): ReadonlyArray<string> {
  return readdirSync(providersDirectory)
    .filter((entry) => entry.endsWith("Process.ts") && !entry.includes(".test."))
    .sort();
}

function usesConfinementBuilder(fileName: string): boolean {
  const source = readFileSync(join(providersDirectory, fileName), "utf8");
  return source.includes("../process/seatbeltProfile") && source.includes("confinement.prepare(");
}

describe("provider runtime confinement", () => {
  it("finds provider process modules to check", () => {
    expect(providerProcessModules().length).toBeGreaterThan(0);
  });

  it("refuses a provider runtime that launches without the shared confinement builder", () => {
    const declared = new Set(UNWRAPPED.map(({ file }) => file));
    const undeclared = providerProcessModules().filter(
      (fileName) => !usesConfinementBuilder(fileName) && !declared.has(fileName),
    );
    expect(undeclared).toEqual([]);
  });

  it("drops a provider runtime from the exception set once it uses the shared builder", () => {
    const stale = UNWRAPPED.map(({ file }) => file).filter((file) => usesConfinementBuilder(file));
    expect(stale).toEqual([]);
  });

  it("keeps the decision record naming every runtime the exception set still covers", () => {
    const record = readFileSync(decisionPath, "utf8");
    const unnamed = UNWRAPPED.map(({ file }) => file).filter(
      (file) => !record.includes(`\`${file}\``),
    );
    expect(unnamed).toEqual([]);
  });
});
