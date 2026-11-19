import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The headless build job runs the built source's own code, so it must never
 * hold a release key; the signing job reads only the key of the ring it signs
 * for. Read as text, as the Windows workflow's test does: the scripts
 * workspace declares no YAML parser.
 */
const workflowsDirectory = resolve(import.meta.dirname, "..", ".github", "workflows");
const workflow = readFileSync(resolve(workflowsDirectory, "release-headless.yml"), "utf8");

function job(name: string, next: string | undefined): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const end = next === undefined ? workflow.length : workflow.indexOf(`\n  ${next}:\n`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("the headless release workflow", () => {
  it("builds with no secret and no environment", () => {
    const build = job("build", "sign");
    expect(build).not.toContain("secrets.");
    expect(build).not.toContain("environment:");
    expect(build).toContain("bun scripts/package-headless.ts");
  });

  it("signs in the ring's environment with only that ring's key", () => {
    const sign = job("sign", undefined);
    expect(sign).toContain("environment: ${{ inputs.environment }}");
    expect(sign).toContain(
      "OCTANT_UPDATE_FEED_PRIVATE_KEY: ${{ inputs.ring == 'stable' && secrets.OCTANT_UPDATE_FEED_PRIVATE_KEY || '' }}",
    );
    expect(sign).toContain(
      "OCTANT_UPDATE_FEED_PREVIEW_PRIVATE_KEY: ${{ inputs.ring != 'stable' && secrets.OCTANT_UPDATE_FEED_PREVIEW_PRIVATE_KEY || '' }}",
    );
    expect(sign).toContain("bun scripts/sign-headless-artifact.ts");
    expect(sign).not.toContain("package-headless.ts");
  });

  it("ships only with Octant releases, never with Octant Nightly", () => {
    const shared = readFileSync(resolve(workflowsDirectory, "release-build.yml"), "utf8");
    expect(shared).toContain(
      "if: inputs.flavor == 'stable' && inputs.source_commit == ''\n    permissions:\n      contents: write\n    uses: ./.github/workflows/release-headless.yml",
    );
    const stable = readFileSync(resolve(workflowsDirectory, "release-stable.yml"), "utf8");
    expect(stable).toContain("uses: ./.github/workflows/release-headless.yml");
    expect(stable).toContain("ring: stable\n      product: Octant\n      environment: stable");
  });
});
