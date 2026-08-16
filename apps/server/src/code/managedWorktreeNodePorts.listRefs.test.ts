import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorktreeRefs } from "./managedWorktreeNodePorts";

const execFileAsync = promisify(execFile);

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

describe("listWorktreeRefs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "octant-list-refs-"));
    await git(root, ["init", "--initial-branch=development"]);
    // Plumbing commands avoid commit signing and identity requirements.
    const tree = await git(root, ["write-tree"]);
    const commit = await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit-tree",
      tree,
      "-m",
      "init",
    ]);
    await git(root, ["update-ref", "refs/heads/development", commit]);
    await git(root, ["update-ref", "refs/heads/feature/picker", commit]);
    await git(root, ["update-ref", "refs/remotes/origin/development", commit]);
    await git(root, ["update-ref", "refs/remotes/origin/HEAD", commit]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists local and remote refs, marks the current branch, and drops remote HEAD", async () => {
    const refs = await listWorktreeRefs(root, new AbortController().signal);
    const byName = new Map(refs.map((ref) => [ref.name, ref]));

    expect(byName.get("development")).toMatchObject({ kind: "local", isCurrent: true });
    expect(byName.get("feature/picker")).toMatchObject({ kind: "local" });
    expect(byName.get("origin/development")).toMatchObject({
      kind: "remote",
      remoteName: "origin",
    });
    expect(byName.has("origin/HEAD")).toBe(false);
  });

  it("fails closed with an empty list outside a repository", async () => {
    const empty = await mkdtemp(join(tmpdir(), "octant-not-a-repo-"));
    try {
      await expect(listWorktreeRefs(empty, new AbortController().signal)).resolves.toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
