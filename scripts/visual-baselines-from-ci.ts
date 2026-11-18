#!/usr/bin/env bun
/**
 * Commits an intended visual change's pictures: downloads the `visual-check`
 * artifact of a CI run (a failed run, or a run of a pull request that carries
 * the `design change` label) and copies every `*.actual.png` over its baseline
 * in `apps/web/visual-baselines`. CI never pushes pictures itself. Review the
 * pictures (and the `*.diff.png` of a failed run), then commit and push.
 *
 *   bun scripts/visual-baselines-from-ci.ts <run-id>
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runId = process.argv[2];
if (runId === undefined || !/^\d+$/.test(runId)) {
  console.error("Usage: bun scripts/visual-baselines-from-ci.ts <run-id>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselines = join(root, "apps/web/visual-baselines");
const download = mkdtempSync(join(tmpdir(), "visual-check-"));

let exitCode: number;
let output = "";
try {
  const result = Bun.spawnSync(
    [
      "gh",
      "run",
      "download",
      runId,
      "--repo",
      "Ogard-Labs/octant",
      "--name",
      "visual-check",
      "--dir",
      download,
    ],
    { stdout: "inherit", stderr: "pipe" },
  );
  exitCode = result.exitCode;
  output = result.stderr.toString();
} catch {
  console.error("Install the GitHub CLI and run gh auth login, then try again.");
  process.exit(1);
}
if (exitCode !== 0) {
  console.error(output);
  console.error(
    /no artifact|not found|no valid artifacts/i.test(output)
      ? `Run ${runId} has no visual-check artifact: it may have expired, or the run never drew the screens.`
      : `gh could not download the visual-check artifact of run ${runId}. Check gh auth status and the run id.`,
  );
  process.exit(1);
}

function* actuals(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* actuals(path);
    else if (entry.name.endsWith(".actual.png")) yield path;
  }
}

mkdirSync(baselines, { recursive: true });
let count = 0;
for (const actual of actuals(download)) {
  const name = actual.slice(actual.lastIndexOf("/") + 1).replace(/\.actual\.png$/, ".png");
  const target = join(baselines, name);
  const existed = existsSync(target);
  if (existed && readFileSync(target).equals(readFileSync(actual))) continue;
  copyFileSync(actual, target);
  console.log(`${existed ? "updated" : "added"} ${name}`);
  count += 1;
}
console.log(
  count === 0
    ? "Nothing to change: the run left no picture that differs from its baseline."
    : `${String(count)} baselines written to apps/web/visual-baselines. Review the diff pictures, then commit them.`,
);
