import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A Nightly rollback builds an older tag. The installer tooling this
 * repository added later is not in that tag, so the Windows build job must
 * run it from the workflow's own checkout and give the rollback source only
 * the commands every Windows-packaging tag has. Read as text: the scripts
 * workspace declares no YAML parser, and the shape checked here is a few
 * fixed lines.
 */
const workflow = readFileSync(
  resolve(import.meta.dirname, "..", ".github", "workflows", "release-windows.yml"),
  "utf8",
);

function buildJobSteps(): ReadonlyArray<string> {
  const start = workflow.indexOf("\n  build:\n");
  const end = workflow.indexOf("\n  sign:\n");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const job = workflow.slice(start, end);
  return job.split("\n      - ").slice(1);
}

const runsFromSource = (step: string) =>
  /working-directory: (release-source|\$\{\{ env\.SOURCE_DIR \}\})/.test(step);

/** What a Windows-packaging tag already had before installers existed. */
const SOURCE_COMMANDS = [
  "run: bun install --frozen-lockfile",
  "run: node scripts/ensure-ci-electron.ts",
  "run: bun run package:desktop",
];

describe("the Windows release build on a rollback", () => {
  it("checks out the workflow's own revision for its tooling and the rollback source beside it", () => {
    const [first, second] = buildJobSteps();
    expect(first?.trim()).toBe("uses: actions/checkout@v4");
    expect(second).toContain("ref: ${{ inputs.source_commit }}");
    expect(second).toContain("path: release-source");
  });

  it("runs only commands older tags have from the rollback source", () => {
    const fromSource = buildJobSteps().filter(runsFromSource);
    expect(fromSource.length).toBeGreaterThan(0);
    for (const step of fromSource) {
      expect(SOURCE_COMMANDS.some((command) => step.includes(command))).toBe(true);
    }
  });

  it("runs the installer tooling from the workflow's own checkout", () => {
    const tooling = buildJobSteps().filter(
      (step) =>
        step.includes("scripts/windows-installer/") ||
        step.includes("scripts/package-windows-installer.ts"),
    );
    expect(tooling.length).toBe(2);
    for (const step of tooling) expect(runsFromSource(step)).toBe(false);
  });

  it("skips signing and publishing when the source predates Windows packaging", () => {
    expect(workflow).toContain("windows: ${{ steps.support.outputs.windows }}");
    expect(workflow).toContain("needs: build\n    if: needs.build.outputs.windows == 'true'");
  });
});
