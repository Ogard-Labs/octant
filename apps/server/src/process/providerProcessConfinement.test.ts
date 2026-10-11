import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { CONFINED_CLAUDE_EXECUTION_POLICIES } from "../providers/claudeProcess";

/**
 * Confinement gate for provider runtime launches.
 *
 * 0009 says every Octant-spawned subprocess that can execute arbitrary code
 * launches through the shared builder, and unit coverage cannot see a module
 * that stops doing so: a driver that spawns its runtime directly is green,
 * shipped, and visible only to a grep. Three provider process modules had
 * drifted out of the rule that way with nothing recording it, which is what
 * 0143 settles.
 *
 * What this proves: a provider process module either uses the shared builder or
 * appears in {@link UNWRAPPED} with a reason, and the confinement matrix in the
 * architecture's security section names each one that does not. What it does not prove: that every launch inside a wrapped module goes
 * through the builder. A module drops the deny-default profile on Full access
 * by design, so a per-launch claim would need each module to declare its
 * launches in a manifest this gate could read rather than a source scan. The
 * observed failure was whole modules never adopting the builder, and that is
 * the failure this catches. Its reach is the runtime launch only: a module's
 * `--version` read is confined separately through `confinedVersionProbe` under
 * 0146, which an entry in {@link UNWRAPPED} still reaches and which this gate
 * does not read, and `discoveryService` runs candidate executables this never
 * sees.
 *
 * {@link UNWRAPPED} is the live set, and the architecture matrix is where a
 * person reads it. The archived decision records are history, not a design
 * authority, so nothing here reads them. Confining a runtime deletes its entry
 * here and its unwrapped row there.
 *
 * An exception may also narrow to the postures a module still launches
 * unwrapped, which is how the Claude exception closes one posture at a time
 * (0145). Full access is never listed: 0009 calls it a genuine unrestricted
 * posture, so no runtime confines it and it is outside this rule rather than an
 * exception to it.
 */
const UNWRAPPED: ReadonlyArray<{
  readonly file: string;
  readonly reason: string;
  /** Postures still launched unwrapped; absent means all of them. */
  readonly postures?: ReadonlyArray<ProviderExecutionPolicy>;
}> = [
  {
    file: "claudeProcess.ts",
    postures: ["approval-gated", "auto-accept-edits"],
    reason: "The runtime's own sandbox settings still answer for the postures that write.",
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
const architecturePath = join(here, "..", "..", "..", "..", "docs", "architecture.md");

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
    const stale = UNWRAPPED.filter(
      ({ file, postures }) => postures === undefined && usesConfinementBuilder(file),
    ).map(({ file }) => file);
    expect(stale).toEqual([]);
  });

  it("holds a partly confined runtime to the exact postures it still launches unwrapped", () => {
    const claude = UNWRAPPED.find(({ file }) => file === "claudeProcess.ts");
    // Every posture but Full access, which 0009 leaves unconfined by design, is
    // either confined by the module or declared here — never neither, and never
    // both. Confining one more posture fails this until the entry is narrowed,
    // and the last narrowing empties the entry away.
    expect([...(claude?.postures ?? []), ...CONFINED_CLAUDE_EXECUTION_POLICIES].sort()).toEqual<
      ProviderExecutionPolicy[]
    >(["approval-gated", "auto-accept-edits", "plan"]);
  });

  it("keeps the architecture's confinement matrix naming every runtime launched unwrapped", () => {
    const architecture = readFileSync(architecturePath, "utf8");
    const security = architecture.slice(architecture.indexOf("\n## Security and authority\n"));
    const unnamed = UNWRAPPED.map(({ file }) => file).filter(
      (file) => !security.includes(`\`${file}\``),
    );
    expect(unnamed).toEqual([]);
  });
});
