/**
 * Decide whether the preview ring should build this HEAD.
 *
 * The workflow used to ask `gh release list` for `targetCommitish`. That field
 * is not in the supported `--json` set (`createdAt`, `isDraft`, `isLatest`,
 * `isPrerelease`, `name`, `publishedAt`, `tagName`), so the decide job failed
 * before packaging ran. Even if the field existed, a release target can be a
 * branch name, which is not an immutable SHA.
 *
 * Compare the peeled tag commit to HEAD instead. A `gh` list failure is a
 * failure: treating it as "no previous preview" would skip the comparison and
 * publish on a broken query — the failure mode the unsupported field produced.
 */

import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

/** Newest-first window. A published preview older than this is not compared. */
export const PREVIEW_RELEASE_LIST_LIMIT = 30;

export const PREVIEW_RELEASE_LIST_JSON_FIELDS = "tagName,isPrerelease,isDraft" as const;

export interface ListedGitHubRelease {
  readonly tagName: string;
  readonly isPrerelease: boolean;
  readonly isDraft: boolean;
}

export type PreviewReleaseDecision =
  | { readonly kind: "build"; readonly reason: "no-previous-preview" }
  | {
      readonly kind: "build";
      readonly reason: "head-moved" | "forced";
      readonly previousTag: string;
      readonly previousCommit: string;
    }
  | {
      readonly kind: "skip";
      readonly reason: "same-commit";
      readonly previousTag: string;
      readonly previousCommit: string;
    }
  | {
      readonly kind: "failed";
      readonly reason: "list-unavailable" | "tag-unresolvable" | "head-unresolvable";
      readonly message: string;
    };

export interface DecidePreviewReleaseInput {
  readonly headCommit: string;
  readonly force: boolean;
  readonly listReleases: () => Promise<ReadonlyArray<ListedGitHubRelease>>;
  readonly resolveTagCommit: (tagName: string) => Promise<string>;
}

export function githubReleaseListArgv(): ReadonlyArray<string> {
  return [
    "gh",
    "release",
    "list",
    "--limit",
    String(PREVIEW_RELEASE_LIST_LIMIT),
    "--exclude-drafts",
    "--json",
    PREVIEW_RELEASE_LIST_JSON_FIELDS,
  ];
}

/**
 * Peel lightweight and annotated tags to the commit. Comparing the annotated
 * tag object would never match HEAD.
 */
export function gitPeelTagToCommitArgv(tagName: string): ReadonlyArray<string> {
  return ["git", "rev-parse", "--verify", "--end-of-options", `refs/tags/${tagName}^{commit}`];
}

export function parseGitHubReleaseListJson(text: string): ReadonlyArray<ListedGitHubRelease> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("gh release list returned invalid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("gh release list must return a JSON array.");
  }
  return parsed.map((item, index) => readListedRelease(item, index));
}

export async function decidePreviewRelease(
  input: DecidePreviewReleaseInput,
): Promise<PreviewReleaseDecision> {
  const headCommit = normalizeCommit(input.headCommit);
  if (headCommit === "") {
    return {
      kind: "failed",
      reason: "head-unresolvable",
      message: "HEAD did not resolve to a commit.",
    };
  }

  let releases: ReadonlyArray<ListedGitHubRelease>;
  try {
    releases = await input.listReleases();
  } catch (error) {
    return {
      kind: "failed",
      reason: "list-unavailable",
      message: errorMessage(error, "Failed to list GitHub releases."),
    };
  }

  const previous = releases.find((release) => release.isPrerelease && !release.isDraft);
  if (previous === undefined) {
    return { kind: "build", reason: "no-previous-preview" };
  }

  const previousTag = previous.tagName.trim();
  if (previousTag === "") {
    return {
      kind: "failed",
      reason: "tag-unresolvable",
      message: "Latest published preview has an empty tag name.",
    };
  }

  let previousCommit: string;
  try {
    previousCommit = normalizeCommit(await input.resolveTagCommit(previousTag));
  } catch (error) {
    return {
      kind: "failed",
      reason: "tag-unresolvable",
      message: errorMessage(error, `Could not resolve preview tag ${previousTag} to a commit.`),
    };
  }
  if (previousCommit === "") {
    return {
      kind: "failed",
      reason: "tag-unresolvable",
      message: `Preview tag ${previousTag} did not resolve to a commit.`,
    };
  }

  if (input.force) {
    return {
      kind: "build",
      reason: "forced",
      previousTag,
      previousCommit,
    };
  }
  if (previousCommit === headCommit) {
    return {
      kind: "skip",
      reason: "same-commit",
      previousTag,
      previousCommit,
    };
  }
  return {
    kind: "build",
    reason: "head-moved",
    previousTag,
    previousCommit,
  };
}

export function githubOutputLines(
  decision: Exclude<PreviewReleaseDecision, { kind: "failed" }>,
): ReadonlyArray<string> {
  if (decision.kind === "build" && decision.reason === "no-previous-preview") {
    return ["build=true"];
  }
  return [
    `build=${decision.kind === "build" ? "true" : "false"}`,
    `previous-commit=${decision.previousCommit}`,
  ];
}

export function resolveGitTagCommit(
  tagName: string,
  options: { readonly cwd?: string } = {},
): string {
  const trimmed = tagName.trim();
  if (trimmed === "") {
    throw new Error("Preview tag name is empty.");
  }
  return normalizeCommit(runCommand(gitPeelTagToCommitArgv(trimmed), options));
}

export function listGitHubReleases(): ReadonlyArray<ListedGitHubRelease> {
  return parseGitHubReleaseListJson(runCommand(githubReleaseListArgv()));
}

function readListedRelease(value: unknown, index: number): ListedGitHubRelease {
  if (!isRecord(value)) {
    throw new Error(`GitHub release list item ${String(index)} is not an object.`);
  }
  const tagName = value["tagName"];
  const isPrerelease = value["isPrerelease"];
  const isDraft = value["isDraft"];
  if (typeof tagName !== "string") {
    throw new Error(`GitHub release list item ${String(index)} is missing tagName.`);
  }
  if (typeof isPrerelease !== "boolean") {
    throw new Error(`GitHub release list item ${String(index)} is missing isPrerelease.`);
  }
  if (typeof isDraft !== "boolean") {
    throw new Error(`GitHub release list item ${String(index)} is missing isDraft.`);
  }
  return { tagName, isPrerelease, isDraft };
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCommit(value: string): string {
  return value.trim().toLowerCase();
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return fallback;
}

function runCommand(argv: ReadonlyArray<string>, options: { readonly cwd?: string } = {}): string {
  const command = argv[0];
  if (command === undefined) {
    throw new Error("A command is required.");
  }
  const result = spawnSync(command, argv.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (result.error !== undefined) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(stderr === "" ? `${argv.join(" ")} failed.` : stderr);
  }
  return result.stdout.trim();
}

async function writeGithubOutput(lines: ReadonlyArray<string>): Promise<void> {
  const body = `${lines.join("\n")}\n`;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath !== undefined && outputPath !== "") {
    await appendFile(outputPath, body);
    return;
  }
  process.stdout.write(body);
}

async function main(): Promise<void> {
  const decision = await decidePreviewRelease({
    headCommit: runCommand(["git", "rev-parse", "--verify", "HEAD"]),
    force: process.env.FORCE === "true",
    listReleases: async () => listGitHubReleases(),
    resolveTagCommit: async (tagName) => resolveGitTagCommit(tagName),
  });
  if (decision.kind === "failed") {
    console.error(decision.message);
    process.exitCode = 1;
    return;
  }
  if (decision.kind === "skip") {
    console.log(
      `Main has not moved since the last preview (${decision.previousCommit}). Nothing to build.`,
    );
  }
  await writeGithubOutput(githubOutputLines(decision));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
