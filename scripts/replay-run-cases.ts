#!/usr/bin/env bun
/**
 * Maintainer-only replay script for stored Work and Code run cases.
 *
 * Reads the newest stored replayable run cases (at most 200, rebuilt from
 * finished receipts while excluding Leave no trace and purged threads), replays
 * each case through the maintainer's own running Octant host and provider
 * account via `octant agent --json`, and prints the share of cases whose
 * finished receipt was all `proven` (e.g. `N/M (XX.X%) all proven`).
 *
 * Runs only when explicitly asked — never part of `bun run test` or CI.
 *
 * Usage:
 *   bun scripts/replay-run-cases.ts [--dry-run] [--mode work|code] [--limit N]
 *     [--model <model>] [--journal <path>] [--cases <fixture.json>] [--json]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FinishedReceiptRecorded } from "@octant/contracts/finished-receipt";
import {
  MAX_REPLAYABLE_RUN_CASES,
  decodeReplayableRunCases,
  type ReplayableRunCase,
} from "@octant/contracts/replayable-run-cases";
import {
  isFinishedReceiptAllProven,
  summarizeAllProvenShare,
  type AllProvenShareSummary,
} from "@octant/domain/replayable-run-case-policy";
import { resolveHostRuntimePaths } from "@octant/host-runtime";
import {
  readLatestFinishedReceiptFromDatabase,
  readReplayableRunCasesFromDatabase,
} from "../apps/server/src/finishedReceipts/replayableRunCaseStore";
import { listAgentModels } from "../packages/cli/src/agentHost";
import { readActiveProjects } from "../packages/cli/src/agentStart";
import { openLocalControlSession } from "../packages/cli/src/localControl";

export interface ReplayRunCasesCommand {
  readonly journalPath?: string | undefined;
  readonly casesPath?: string | undefined;
  readonly mode?: "work" | "code" | undefined;
  readonly limit?: number | undefined;
  readonly modelOverride?: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface ReplayHostProject {
  readonly id: string;
  readonly name: string;
}

export interface ReplayHostModel {
  readonly instanceId: string;
  readonly endpoint: string;
  readonly modelId: string;
}

export interface ReplayHostCatalog {
  readonly projects: ReadonlyArray<ReplayHostProject>;
  readonly models: ReadonlyArray<ReplayHostModel>;
}

export type ReplayAgentArgsResult =
  | { readonly status: "ready"; readonly args: ReadonlyArray<string> }
  | { readonly status: "failed"; readonly reason: string };

export type ReplayCaseRunResult =
  | {
      readonly status: "completed";
      readonly replayThreadId?: string | undefined;
      readonly receipt?: FinishedReceiptRecorded | undefined;
      readonly stale?: boolean | undefined;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly replayThreadId?: string | undefined;
    };

export type ReplayCaseRunner = (
  runCase: ReplayableRunCase,
  options: { readonly modelOverride?: string | undefined },
) => Promise<ReplayCaseRunResult>;

export interface ReplayCaseEvaluatedResult {
  readonly runCase: ReplayableRunCase;
  readonly verdict: "all-proven" | "not-all-proven" | "failed";
  readonly replayThreadId?: string | undefined;
  readonly reason?: string | undefined;
}

export interface ReplayRunCasesReport {
  readonly dryRun: boolean;
  readonly results: ReadonlyArray<ReplayCaseEvaluatedResult>;
  readonly summary: AllProvenShareSummary;
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parseReplayRunCasesCommand(argv: ReadonlyArray<string>): ReplayRunCasesCommand {
  let journalPath: string | undefined;
  let casesPath: string | undefined;
  let mode: "work" | "code" | undefined;
  let limit: number | undefined;
  let modelOverride: string | undefined;
  let dryRun = false;
  let json = false;

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--journal") {
      journalPath = takeValue("--journal", index);
      index += 1;
      continue;
    }
    if (arg === "--cases") {
      casesPath = takeValue("--cases", index);
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      const value = takeValue("--mode", index);
      if (value !== "work" && value !== "code") {
        throw new Error("--mode must be 'work' or 'code'.");
      }
      mode = value;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const raw = takeValue("--limit", index);
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_REPLAYABLE_RUN_CASES) {
        throw new Error(
          `--limit must be an integer between 1 and ${String(MAX_REPLAYABLE_RUN_CASES)}.`,
        );
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      modelOverride = takeValue("--model", index);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(arg)}`);
  }

  return {
    ...(journalPath === undefined ? {} : { journalPath }),
    ...(casesPath === undefined ? {} : { casesPath }),
    ...(mode === undefined ? {} : { mode }),
    ...(limit === undefined ? {} : { limit }),
    ...(modelOverride === undefined ? {} : { modelOverride }),
    dryRun,
    json,
  };
}

/**
 * Resolve the exact `octant agent` arguments for replaying one stored case:
 * - `--project` receives the Project's current name (matched by Project id
 *   against the target host's active Projects, falling back to the stored
 *   Project name — never a UUID, which `octant agent --project` does not match).
 * - `--model` uses `modelOverride` if supplied, or qualifies the recorded
 *   `providerInstanceId` against the target host's offered models as
 *   `endpoint/model` so duplicate model IDs across endpoints never fail as
 *   ambiguous in `pickAgentModel`.
 */
export function buildAgentReplayArgs(input: {
  readonly runCase: ReplayableRunCase;
  readonly modelOverride?: string | undefined;
  readonly hostProjects?: ReadonlyArray<ReplayHostProject> | undefined;
  readonly hostModels?: ReadonlyArray<ReplayHostModel> | undefined;
}): ReplayAgentArgsResult {
  const projectId = String(input.runCase.project.id);
  const hostProjects = input.hostProjects ?? [];
  const hostProject = hostProjects.find((entry) => entry.id === projectId);
  const resolvedProjectName =
    hostProject?.name.trim() || input.runCase.project.name?.trim() || undefined;
  if (resolvedProjectName === undefined) {
    return {
      status: "failed",
      reason: `Project ${projectId} has no resolvable Project name for octant agent --project.`,
    };
  }
  const normalizedProjectName = resolvedProjectName.toLowerCase();
  const matchingProjects = hostProjects.filter(
    (entry) => entry.name.trim().toLowerCase() === normalizedProjectName,
  );
  if (matchingProjects.length > 1) {
    return {
      status: "failed",
      reason: `Project name "${resolvedProjectName}" matches multiple active Projects on this host; refusing to replay Project ${projectId} into an ambiguous target.`,
    };
  }
  if (matchingProjects.length === 1 && matchingProjects[0]?.id !== projectId) {
    return {
      status: "failed",
      reason: `Project name "${resolvedProjectName}" belongs to a different active Project (${String(matchingProjects[0]?.id)}) than recorded Project ${projectId}.`,
    };
  }

  let modelArg: string | undefined;
  if (input.modelOverride !== undefined) {
    modelArg = input.modelOverride;
  } else if (input.runCase.model !== undefined) {
    const providerId = String(input.runCase.model.providerInstanceId);
    const modelId = String(input.runCase.model.modelId);
    const models = input.hostModels ?? [];
    const exact = models.find(
      (choice) =>
        choice.instanceId === providerId && choice.modelId.toLowerCase() === modelId.toLowerCase(),
    );
    if (exact !== undefined) {
      modelArg = `${exact.endpoint}/${exact.modelId}`;
    } else {
      const byInstance = models.find((choice) => choice.instanceId === providerId);
      if (byInstance !== undefined) {
        modelArg = `${byInstance.endpoint}/${modelId}`;
      } else {
        const sameModelMatches = models.filter(
          (choice) => choice.modelId.toLowerCase() === modelId.toLowerCase(),
        );
        if (sameModelMatches.length > 1) {
          return {
            status: "failed",
            reason: `Model "${modelId}" is offered by multiple endpoints and recorded provider ${providerId} is unavailable; pass --model endpoint/model.`,
          };
        }
        modelArg = modelId;
      }
    }
  }

  return {
    status: "ready",
    args: [
      resolve(repoRoot, "packages/cli/src/bin.ts"),
      "agent",
      "--json",
      "--mode",
      input.runCase.mode,
      "--project",
      resolvedProjectName,
      ...(modelArg === undefined ? [] : ["--model", modelArg]),
      "--prompt",
      input.runCase.request,
    ],
  };
}

/**
 * Extract the created thread id emitted by `octant agent --json`.
 */
export function parseAgentReplayThreadId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      parsed.kind === "thread" &&
      "threadId" in parsed &&
      typeof parsed.threadId === "string" &&
      parsed.threadId.length > 0
    ) {
      return parsed.threadId;
    }
  }
  return undefined;
}

/**
 * Evaluate stored cases either in dry-run mode (baseline stored receipts, no
 * model calls) or by replaying each selected case through `runner`.
 */
export async function runReplayCases(input: {
  readonly cases: ReadonlyArray<ReplayableRunCase>;
  readonly mode?: "work" | "code" | undefined;
  readonly limit?: number | undefined;
  readonly modelOverride?: string | undefined;
  readonly dryRun: boolean;
  readonly runner?: ReplayCaseRunner | undefined;
}): Promise<ReplayRunCasesReport> {
  const filtered =
    input.mode === undefined
      ? input.cases
      : input.cases.filter((runCase) => runCase.mode === input.mode);
  const selected = input.limit === undefined ? filtered : filtered.slice(0, input.limit);

  const results: ReplayCaseEvaluatedResult[] = [];
  const summaryInputs: Array<{
    readonly receipt?: FinishedReceiptRecorded | undefined;
    readonly stale?: boolean | undefined;
  }> = [];

  if (input.dryRun) {
    for (const runCase of selected) {
      const allProven = isFinishedReceiptAllProven(runCase.receipt);
      results.push({
        runCase,
        verdict: allProven ? "all-proven" : "not-all-proven",
      });
      summaryInputs.push({ receipt: runCase.receipt });
    }
    return {
      dryRun: true,
      results,
      summary: summarizeAllProvenShare(summaryInputs),
    };
  }

  if (input.runner === undefined) {
    throw new Error("A replay runner is required outside --dry-run mode.");
  }

  for (const runCase of selected) {
    const outcome = await input.runner(runCase, { modelOverride: input.modelOverride });
    if (outcome.status === "failed") {
      results.push({
        runCase,
        verdict: "failed",
        ...(outcome.replayThreadId === undefined ? {} : { replayThreadId: outcome.replayThreadId }),
        reason: outcome.reason,
      });
      summaryInputs.push({ receipt: undefined });
      continue;
    }
    const allProven = isFinishedReceiptAllProven(outcome.receipt, { stale: outcome.stale });
    results.push({
      runCase,
      verdict: allProven ? "all-proven" : "not-all-proven",
      ...(outcome.replayThreadId === undefined ? {} : { replayThreadId: outcome.replayThreadId }),
    });
    summaryInputs.push({ receipt: outcome.receipt, stale: outcome.stale });
  }

  return {
    dryRun: false,
    results,
    summary: summarizeAllProvenShare(summaryInputs),
  };
}

export function formatReplayRunCasesReport(report: ReplayRunCasesReport): string {
  const lines: string[] = [];
  const headerMode = report.dryRun ? "dry-run, stored baseline" : "live replay";
  lines.push(`Octant replayable run cases (${headerMode}): ${String(report.results.length)} cases`);
  for (const [index, entry] of report.results.entries()) {
    const projectLabel = entry.runCase.project.name ?? String(entry.runCase.project.id);
    const modelLabel = entry.runCase.model?.modelId ?? "default";
    const snippet = entry.runCase.request.replace(/\s+/g, " ").slice(0, 72);
    const detail = entry.reason === undefined ? "" : ` — ${entry.reason}`;
    lines.push(
      `  ${String(index + 1)}. [${entry.verdict}] ${entry.runCase.mode} | ${projectLabel} | ${String(modelLabel)} | ${snippet}${detail}`,
    );
  }
  lines.push(`Summary: ${report.summary.formatted}`);
  return lines.join("\n");
}

function defaultHostJournalPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const paths = resolveHostRuntimePaths(
    {
      env: process.env,
      platform: process.platform,
      home: homedir(),
      temporaryDirectory: tmpdir(),
      uid,
    },
    { createDataDirectory: false },
  );
  return join(paths.dataDirectory, "octant.sqlite3");
}

async function loadTargetHostCatalog(): Promise<ReplayHostCatalog> {
  const session = await openLocalControlSession({
    host: { env: process.env, platform: process.platform, home: homedir() },
  });
  if (session.kind !== "opened") {
    return { projects: [], models: [] };
  }
  try {
    const [projectsResult, models] = await Promise.all([
      readActiveProjects(session),
      listAgentModels(session, "harness"),
    ]);
    const projects =
      projectsResult.kind === "read"
        ? projectsResult.active.map((project) => ({
            id: String(project.id),
            name: project.name,
          }))
        : [];
    return { projects, models };
  } finally {
    await session.close();
  }
}

function createHostReplayCaseRunner(journalPath: string): ReplayCaseRunner {
  let cachedCatalog: Promise<ReplayHostCatalog> | undefined;
  return async (runCase, options) => {
    cachedCatalog ??= loadTargetHostCatalog();
    const catalog = await cachedCatalog;
    const built = buildAgentReplayArgs({
      runCase,
      modelOverride: options.modelOverride,
      hostProjects: catalog.projects,
      hostModels: catalog.models,
    });
    if (built.status === "failed") {
      return { status: "failed", reason: built.reason };
    }

    const spawned = await new Promise<
      | { readonly status: "ran"; readonly exitCode: number; readonly stdout: string }
      | { readonly status: "error"; readonly message: string }
    >((done) => {
      const child = spawn("bun", built.args, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "inherit"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.on("error", (error) => done({ status: "error", message: error.message }));
      child.on("close", (code) => done({ status: "ran", exitCode: code ?? 1, stdout }));
    });

    if (spawned.status === "error") {
      return { status: "failed", reason: spawned.message };
    }
    const replayThreadId = parseAgentReplayThreadId(spawned.stdout);
    if (spawned.exitCode !== 0) {
      return {
        status: "failed",
        reason: `octant agent exited with code ${String(spawned.exitCode)}.`,
        ...(replayThreadId === undefined ? {} : { replayThreadId }),
      };
    }
    if (replayThreadId === undefined || !existsSync(journalPath)) {
      return {
        status: "completed",
        ...(replayThreadId === undefined ? {} : { replayThreadId }),
      };
    }
    const observed = readLatestFinishedReceiptFromDatabase(journalPath, replayThreadId);
    return {
      status: "completed",
      replayThreadId,
      ...(observed === undefined ? {} : { receipt: observed.receipt, stale: observed.stale }),
    };
  };
}

async function main(): Promise<number> {
  const command = parseReplayRunCasesCommand(process.argv.slice(2));
  const journalPath = command.journalPath ?? defaultHostJournalPath();
  let cases: ReadonlyArray<ReplayableRunCase>;
  if (command.casesPath !== undefined) {
    const raw = JSON.parse(await readFile(command.casesPath, "utf8")) as unknown;
    cases = decodeReplayableRunCases(raw);
  } else {
    if (!existsSync(journalPath)) {
      throw new Error(`No Octant journal found at ${journalPath}.`);
    }
    cases = readReplayableRunCasesFromDatabase(journalPath);
  }

  const report = await runReplayCases({
    cases,
    mode: command.mode,
    limit: command.limit,
    modelOverride: command.modelOverride,
    dryRun: command.dryRun,
    runner: command.dryRun ? undefined : createHostReplayCaseRunner(journalPath),
  });

  if (command.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReplayRunCasesReport(report)}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
