#!/usr/bin/env bun
/**
 * Native harness benchmark scoreboard.
 *
 * Runs the canned tasks in `scripts/harness-benchmark-tasks.json` through
 * `octant agent --json` against the running host and appends one row per task
 * to `docs/harness-scoreboard.json`: tokens, turns, and wall-clock. There is no
 * absolute target; the trend across releases is the gate. It needs a running
 * host with a configured endpoint provider, so it is run by hand and never in
 * CI.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface BenchmarkTask {
  readonly id: string;
  readonly prompt: string;
  readonly project?: string;
}

interface ScoreboardRow {
  readonly task: string;
  readonly recordedAt: string;
  readonly commit: string;
  readonly wallClockMs: number;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly outcome: string;
}

const root = resolve(import.meta.dir, "..");
const tasksPath = resolve(root, "scripts/harness-benchmark-tasks.json");
const scoreboardPath = resolve(root, "docs/harness-scoreboard.json");

async function runTask(task: BenchmarkTask, commit: string): Promise<ScoreboardRow> {
  const started = Date.now();
  const args = [
    resolve(root, "packages/cli/src/bin.ts"),
    "agent",
    "--json",
    "--prompt",
    task.prompt,
    ...(task.project === undefined ? [] : ["--project", task.project]),
  ];
  const output = await new Promise<string>((done, fail) => {
    const child = spawn("bun", args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
    });
    child.on("error", fail);
    child.on("close", () => done(text));
  });
  const lines = output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const outcome = lines.find((line) => line.kind === "outcome");
  const usage = (outcome?.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
  return {
    task: task.id,
    recordedAt: new Date().toISOString(),
    commit,
    wallClockMs: Date.now() - started,
    turns: lines.filter((line) => line.kind === "outcome").length,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    outcome: String(outcome?.outcome ?? "unknown"),
  };
}

async function main(): Promise<number> {
  const tasks = JSON.parse(await readFile(tasksPath, "utf8")) as BenchmarkTask[];
  const commit = await new Promise<string>((done) => {
    const child = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
    });
    child.on("close", () => done(text.trim()));
  });
  let scoreboard: ScoreboardRow[] = [];
  try {
    scoreboard = JSON.parse(await readFile(scoreboardPath, "utf8")) as ScoreboardRow[];
  } catch {
    scoreboard = [];
  }
  for (const task of tasks) {
    const row = await runTask(task, commit);
    scoreboard.push(row);
    process.stdout.write(
      `${row.task}: ${row.outcome} in ${row.wallClockMs}ms, ${row.inputTokens} in / ${row.outputTokens} out\n`,
    );
  }
  await writeFile(scoreboardPath, `${JSON.stringify(scoreboard, null, 2)}\n`);
  return 0;
}

process.exitCode = await main();
