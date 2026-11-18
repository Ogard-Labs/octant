#!/usr/bin/env bun
/**
 * Approves an intended visual change by hand: downloads the `visual-check`
 * artifact of a failed CI run and copies every `*.actual.png` over its
 * baseline in `apps/web/visual-baselines`. The normal route is the
 * `design change` label on the pull request, which does the same in CI; use
 * this when the label cannot (a pull request from a fork, or a run you want to
 * review first). Review the `*.diff.png` pictures before you commit.
 *
 *   bun scripts/visual-baselines-from-ci.ts <run-id>
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
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

const result = Bun.spawnSync(
  ["gh", "run", "download", runId, "--name", "visual-check", "--dir", download],
  { stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) {
  console.error(`gh could not download the visual-check artifact of run ${runId}.`);
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
  const verb = existsSync(target) ? "updated" : "added";
  copyFileSync(actual, target);
  console.log(`${verb} ${name}`);
  count += 1;
}
console.log(
  count === 0
    ? "The run left no actual pictures: nothing changed visibly."
    : `${String(count)} baselines written to apps/web/visual-baselines. Review the diff pictures, then commit them.`,
);
