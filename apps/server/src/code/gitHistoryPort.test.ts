import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeGitHistoryQuery } from "@octant/contracts/git-history";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { GitHistoryPort } from "./gitHistoryPort";

const directories: string[] = [];
const scope = {
  threadId: "11111111-1111-4111-8111-111111111111",
  checkoutId: "22222222-2222-4222-8222-222222222222",
};
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "octant-history-test-"));
  directories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Octant Test");
  git(root, "config", "user.email", "test@octant.local");
  // Host signing/fsmonitor must not leak into fixture commits; 102 signed
  // commits miss the unit timeout on a managed Git identity.
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.fsmonitor", "false");
  return root;
}
function commit(root: string, subject: string) {
  writeFileSync(join(root, "note.txt"), subject);
  git(root, "add", "--", "note.txt");
  git(root, "commit", "-qm", subject);
  return git(root, "rev-parse", "HEAD");
}
const port = () => {
  const sandbox = createFakeSandboxConfinement();
  directories.push(sandbox.root);
  return new GitHistoryPort({
    confinement: sandbox.confinement,
    temporaryDirectory: sandbox.temporaryDirectory,
    gitExecutable: "/usr/bin/git",
  });
};
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local Git history", () => {
  it("pages from immutable tips while new commits arrive without changing the checkout", async () => {
    const root = repository();
    for (let i = 0; i < 102; i++) commit(root, `Saved note ${i}`);
    const reader = port();
    const first = await reader.read(root, decodeGitHistoryQuery({ kind: "history", ...scope }));
    expect(first.status).toBe("history");
    if (first.status !== "history") return;
    expect(first.commits).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const latest = commit(root, "A newer note");
    const next = await reader.read(
      root,
      decodeGitHistoryQuery({ kind: "history", ...scope, cursor: first.nextCursor }),
    );
    expect(next.status).toBe("history");
    if (next.status !== "history") return;
    expect(next.commits.map((entry) => entry.subject)).toEqual(["Saved note 1", "Saved note 0"]);
    expect(next.nextCursor).toBeNull();
    expect(git(root, "rev-parse", "HEAD")).toBe(latest);
  });
  it("reads a root commit and compares either parent of a merge", async () => {
    const root = repository();
    const initial = commit(root, "First note");
    const reader = port();
    const first = await reader.read(
      root,
      decodeGitHistoryQuery({ kind: "commit", ...scope, oid: initial, parent: 0 }),
    );
    expect(first.status).toBe("commit");
    if (first.status !== "commit") return;
    expect(first.parent).toBeNull();
    expect(first.files).toBe(1);
    expect(first.diff).toContain("+First note");
    git(root, "checkout", "-qb", "topic");
    writeFileSync(join(root, "topic.txt"), "Topic\n");
    git(root, "add", "--", "topic.txt");
    git(root, "commit", "-qm", "Topic work");
    const topic = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    commit(root, "Main work");
    git(root, "merge", "--no-ff", "-qm", "Joined work", "topic");
    const oid = git(root, "rev-parse", "HEAD");
    const merged = await reader.read(
      root,
      decodeGitHistoryQuery({ kind: "commit", ...scope, oid, parent: 1 }),
    );
    expect(merged.status).toBe("commit");
    if (merged.status !== "commit") return;
    expect(merged.commit.parents).toHaveLength(2);
    expect(merged.parent).toBe(topic);
    expect(merged.diff).toContain("+Main work");
    expect(
      (await reader.read(root, decodeGitHistoryQuery({ kind: "commit", ...scope, oid, parent: 2 })))
        .status,
    ).toBe("unavailable");
  });

  it("keeps non-text and renamed files and reports bounded diffs honestly", async () => {
    const root = repository();
    commit(root, "First note");
    git(root, "mv", "note.txt", "renamed note.txt");
    writeFileSync(join(root, "picture.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "large.txt"), "A long changed line\n".repeat(150_000));
    git(root, "add", "--", "picture.bin", "large.txt");
    git(root, "commit", "-qm", "Move and add files");
    const result = await port().read(
      root,
      decodeGitHistoryQuery({
        kind: "commit",
        ...scope,
        oid: git(root, "rev-parse", "HEAD"),
        parent: 0,
      }),
    );
    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.files).toBe(3);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("distinguishes an empty repository and searches beyond the first page", async () => {
    const root = repository();
    const reader = port();
    const empty = await reader.read(root, decodeGitHistoryQuery({ kind: "history", ...scope }));
    expect(empty).toMatchObject({ status: "history", commits: [], head: null });
    const oid = commit(root, "A searchable note");
    git(root, "branch", "forbedring/æøå");
    expect(
      await reader.read(
        root,
        decodeGitHistoryQuery({ kind: "history", ...scope, revision: "refs/heads/forbedring/æøå" }),
      ),
    ).toMatchObject({ status: "history", commits: [{ oid }] });
    git(root, "checkout", "--detach", "-q");
    const searched = await reader.read(
      root,
      decodeGitHistoryQuery({ kind: "history", ...scope, search: oid.slice(0, 9) }),
    );
    expect(searched).toMatchObject({ status: "history", branch: null, commits: [{ oid }] });
  });
  it("reads linked worktrees but refuses a folder inside another repository", async () => {
    const root = repository();
    commit(root, "Initial note");
    const sibling = mkdtempSync(join(tmpdir(), "octant-history-worktree-"));
    directories.push(sibling);
    const worktree = join(sibling, "checkout");
    git(root, "worktree", "add", "-qb", "linked", worktree);
    const reader = port();
    expect(
      await reader.read(worktree, decodeGitHistoryQuery({ kind: "history", ...scope })),
    ).toMatchObject({ status: "history", branch: "linked" });
    const inside = join(root, "nested");
    mkdirSync(inside);
    expect(
      (await reader.read(inside, decodeGitHistoryQuery({ kind: "history", ...scope }))).status,
    ).toBe("unavailable");
  });
});
