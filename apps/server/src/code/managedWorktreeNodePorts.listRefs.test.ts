import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listBranchNames, listWorktreeRefs } from "./managedWorktreeNodePorts";

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

describe("listBranchNames", () => {
  let root: string;
  let commit: string;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "octant-branch-names-"));
    await git(root, ["init", "--initial-branch=development"]);
    const tree = await git(root, ["write-tree"]);
    commit = await git(root, [
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
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists local branches, remote branches without the remote's name, and tags", async () => {
    await git(root, ["update-ref", "refs/heads/feature/picker", commit]);
    await git(root, ["update-ref", "refs/remotes/origin/octant/fix-login", commit]);
    await git(root, ["update-ref", "refs/remotes/upstream/octant/fix-login", commit]);
    await git(root, ["update-ref", "refs/remotes/origin/HEAD", commit]);
    await git(root, ["update-ref", "refs/tags/v1", commit]);
    await git(root, ["update-ref", "refs/octant/checkpoints/x/y", commit]);
    const listed = await listBranchNames(root, signal);
    if (listed.status !== "observed") throw new Error("expected names");
    expect(listed.truncated).toBe(false);
    expect([...listed.names].sort()).toEqual([
      "development",
      "feature/picker",
      "octant/fix-login",
      "v1",
    ]);
  });

  it("is not cut at the display list's 200 entries, and says so when it is cut at its own bound", async () => {
    // Packed refs are the way a repository comes to hold thousands of branches.
    const packed = Array.from(
      { length: 250 },
      (_, index) => `${commit} refs/heads/bulk/branch-${String(index).padStart(3, "0")}`,
    ).join("\n");
    await writeFile(join(root, ".git", "packed-refs"), `# pack-refs with: sorted\n${packed}\n`);
    const all = await listBranchNames(root, signal);
    if (all.status !== "observed") throw new Error("expected names");
    expect(all.names).toHaveLength(251);
    expect(all.names).toContain("bulk/branch-249");
    expect(all.truncated).toBe(false);
    const cut = await listBranchNames(root, signal, 100);
    expect(cut).toMatchObject({ status: "observed", truncated: true });
  });

  it("fails closed outside a repository", async () => {
    const empty = await mkdtemp(join(tmpdir(), "octant-not-a-repo-"));
    try {
      await expect(listBranchNames(empty, signal)).resolves.toEqual({ status: "failed" });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
