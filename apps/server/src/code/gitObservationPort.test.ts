import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { GitObservationPort, type GitObservation } from "./gitObservationPort";

const directories: string[] = [];

function confinedOptions() {
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  return {
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    gitExecutable: "/usr/bin/git",
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("GitObservationPort", () => {
  it("observes exact checkout state without mutating the repository", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const remote = join(root, "remote.git");
    const linked = join(root, "linked worktree");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "tracked.txt"), "before\n");
    git(repository, "add", "--", "tracked.txt");
    git(repository, "commit", "-m", "initial");
    execFileSync("git", ["init", "--bare", remote]);
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "--set-upstream", "origin", "main");
    git(repository, "worktree", "add", "-b", "feature/linked", linked);
    writeFileSync(join(repository, "tracked.txt"), "after\n");
    writeFileSync(join(repository, "new file.txt"), "new\n");
    const beforeHead = gitOutput(repository, "rev-parse", "HEAD").trim();

    const result = await new GitObservationPort({ maxDiffBytes: 80, ...confinedOptions() }).observe(
      repository,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.head).toEqual({ kind: "branch", name: "main", oid: beforeHead });
    expect(result.changedPaths).toEqual(["new file.txt", "tracked.txt"]);
    // Line totals come from numstat against the same baseline, so a truncated
    // unified diff cannot undercount the summary the thread later carries.
    expect(result.insertions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.statusEntries).toEqual([
      { path: "new file.txt", index: "?", worktree: "?" },
      { path: "tracked.txt", index: " ", worktree: "M" },
    ]);
    expect(result.diff.byteLength).toBeLessThanOrEqual(80);
    expect(result.diff.truncated).toBe(true);
    expect(result.remotes).toEqual([{ name: "origin", fetchUrl: remote, pushUrl: remote }]);
    expect(result.upstream).toEqual({
      remote: "origin",
      mergeRef: "refs/heads/main",
    });
    expect(result.worktrees.map((entry) => entry.path)).toEqual([
      realpathSync(repository),
      realpathSync(linked),
    ]);
    expect(gitOutput(repository, "rev-parse", "HEAD").trim()).toBe(beforeHead);
    expect(gitOutput(repository, "status", "--porcelain=v1")).toContain("tracked.txt");
  });

  it("leaves whitespace-only edits out of the diff when asked, without changing the state token", async () => {
    const repository = join(temporaryDirectory(), "repository");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "tracked.txt"), "alpha\nbeta\n");
    writeFileSync(join(repository, "spaced.txt"), "one\ntwo\n");
    git(repository, "add", "--", "tracked.txt", "spaced.txt");
    git(repository, "commit", "-m", "initial");
    writeFileSync(join(repository, "tracked.txt"), "alpha\n    beta\ngamma\n");
    writeFileSync(join(repository, "spaced.txt"), "one\n  two\n");
    const port = new GitObservationPort(confinedOptions());

    const shown = await port.observe(repository);
    const ignored = await port.observe(repository, undefined, { ignoreWhitespace: true });

    if (shown.status !== "ready" || ignored.status !== "ready") throw new Error("not ready");
    expect(shown.diff.text).toContain("spaced.txt");
    expect(ignored.diff.text).not.toContain("spaced.txt");
    expect(ignored.diff.text).toContain("+gamma");
    expect(ignored.changedPaths).toEqual(shown.changedPaths);
    expect(ignored.stateToken).toBe(shown.stateToken);
  });

  it("names an untracked directory without the slash git prints after it", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "tracked.txt"), "before\n");
    git(repository, "add", "--", "tracked.txt");
    git(repository, "commit", "-m", "initial");
    mkdirSync(join(repository, "notes"));
    writeFileSync(join(repository, "notes", "draft.md"), "untracked\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // A relative path in the contract never ends in a slash; with git's
    // `notes/` passed through, the whole observation was refused and the
    // Review tool showed only "Code operation failed".
    expect(result.statusEntries).toEqual([{ path: "notes", index: "?", worktree: "?" }]);
    expect(result.changedPaths).toEqual(["notes"]);
  });

  it("reports detached HEAD exactly and redacts credentials embedded in remote URLs", async () => {
    const repository = createRepository();
    git(repository, "checkout", "--detach", "HEAD");
    git(repository, "remote", "add", "origin", "https://user:secret@example.test/owner/repo.git");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.head).toEqual({
      kind: "detached",
      oid: gitOutput(repository, "rev-parse", "HEAD").trim(),
    });
    expect(result.remotes[0]).toEqual({
      name: "origin",
      fetchUrl: "https://example.test/owner/repo.git",
      pushUrl: "https://example.test/owner/repo.git",
      credentialed: true,
    });
  });

  it("reads sanitized remotes without collecting working-tree facts", async () => {
    const repository = createRepository();
    git(repository, "remote", "add", "origin", "https://github.com/acme/example.git");
    writeFileSync(join(repository, "untracked.txt"), "not part of identity\n");

    const remotes = await new GitObservationPort(confinedOptions()).observeRemotes(repository);

    expect(remotes).toEqual([
      {
        name: "origin",
        fetchUrl: "https://github.com/acme/example.git",
        pushUrl: "https://github.com/acme/example.git",
      },
    ]);
  });

  it("observes a checkout whose branch has no commits yet", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "staged.txt"), "first\n");
    git(repository, "add", "--", "staged.txt");
    writeFileSync(join(repository, "untracked.txt"), "loose\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.head).toEqual({ kind: "unborn", name: "main" });
    expect(result.statusEntries).toEqual([
      { path: "staged.txt", index: "A", worktree: " " },
      { path: "untracked.txt", index: "?", worktree: "?" },
    ]);
    // The empty tree is the only baseline an unborn branch has, so the staged
    // addition is the whole diff.
    expect(result.diff.text).toContain("+++ b/staged.txt");
    expect(result.diff.truncated).toBe(false);
    expect(result.upstream).toBeNull();
    expect(result.stateToken).toMatch(/^[a-f0-9]{64}$/);
  });

  // On any other branch `git diff HEAD` reaches the working tree, so a file
  // staged and then edited again shows its latest text. An unborn branch has to
  // reach just as far, or the pane shows content the file no longer has.
  it("shows the working-tree text of a file edited after staging on an unborn branch", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "staged.txt"), "first\n");
    git(repository, "add", "--", "staged.txt");
    writeFileSync(join(repository, "staged.txt"), "first\nsecond\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.statusEntries).toEqual([{ path: "staged.txt", index: "A", worktree: "M" }]);
    expect(result.diff.text).toContain("+second");
  });

  it("reports both sides of a staged rename as explicit changed paths", async () => {
    const repository = createRepository();
    git(repository, "mv", "README.md", "renamed.md");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.statusEntries).toEqual([
      {
        path: "renamed.md",
        originalPath: "README.md",
        index: "R",
        worktree: " ",
      },
    ]);
    expect(result.changedPaths).toEqual(["README.md", "renamed.md"]);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  it("derives path counts and insertion and deletion totals from one observation", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "README.md"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(repository, "untracked.txt"), "loose\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.changedPaths).toEqual(["README.md", "untracked.txt"]);
    expect(result.insertions).toBe(3);
    expect(result.deletions).toBe(1);
  });

  it("lists what differs between two trees, one row per path with its line counts", async () => {
    const repository = createRepository();
    const before = gitOutput(repository, "rev-parse", "HEAD^{tree}").trim();
    writeFileSync(join(repository, "README.md"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(repository, "notes.txt"), "loose\n");
    writeFileSync(join(repository, "logo.bin"), Buffer.from([0, 1, 2, 0, 255]));
    git(repository, "add", "-A");
    const after = gitOutput(repository, "write-tree").trim();
    const objects = allObjectNames(repository);

    const port = new GitObservationPort(confinedOptions());
    const result = await port.readTreeChanges({
      checkoutRoot: repository,
      from: before,
      to: after,
    });

    expect(result).toEqual({
      status: "ready",
      changes: [
        { path: "README.md", insertions: 3, deletions: 1, binary: false },
        { path: "logo.bin", insertions: 0, deletions: 0, binary: true },
        { path: "notes.txt", insertions: 1, deletions: 0, binary: false },
      ],
    });
    // Reading is only reading: no object is written to answer it.
    expect(allObjectNames(repository)).toEqual(objects);
    expect(
      await port.readTreeChanges({ checkoutRoot: repository, from: before, to: before }),
    ).toEqual({ status: "ready", changes: [] });
  });

  it("refuses a change list for anything that is not plainly a Git object id", async () => {
    const repository = createRepository();
    const tree = gitOutput(repository, "rev-parse", "HEAD^{tree}").trim();
    const port = new GitObservationPort(confinedOptions());

    // An id reaches a command line, so an option or a ref name is never quoted through.
    for (const from of ["--output=/tmp/owned", "HEAD", "main", ""]) {
      expect(await port.readTreeChanges({ checkoutRoot: repository, from, to: tree })).toEqual({
        status: "unavailable",
      });
    }
  });

  it("refuses observation when a numstat field is not a complete integer", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "README.md"), "changed\n");
    const result = await observationPortWithNumstat("12invalid\t1\tREADME.md\0").observe(
      repository,
    );
    expect(result).toEqual({ status: "failed" });
  });

  it("refuses observation when insertion or deletion totals overflow a safe integer", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "README.md"), "changed\n");
    const result = await observationPortWithNumstat(
      `${Number.MAX_SAFE_INTEGER}\t0\tREADME.md\0${1}\t0\tother.txt\0`,
    ).observe(repository);
    expect(result).toEqual({ status: "failed" });
  });

  it("reports unavailable without path or line counts when the checkout cannot be observed", async () => {
    const missing = join(temporaryDirectory(), "missing");
    const result = await new GitObservationPort(confinedOptions()).observe(missing);
    expect(result).toEqual({ status: "unavailable" });
  });

  it("binds the state token to reviewed bytes, untracked bytes, and remote destinations", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "README.md"), "first change\n");
    writeFileSync(join(repository, "untracked.txt"), "first untracked\n");
    git(repository, "remote", "add", "origin", "https://github.com/octant/one.git");
    const port = new GitObservationPort(confinedOptions());

    const first = await port.observe(repository);
    writeFileSync(join(repository, "README.md"), "second change\n");
    writeFileSync(join(repository, "untracked.txt"), "second untracked\n");
    const second = await port.observe(repository);
    git(repository, "remote", "set-url", "origin", "https://github.com/octant/two.git");
    const third = await port.observe(repository);
    writeFileSync(join(repository, "README.md"), "first staged\n");
    git(repository, "add", "README.md");
    writeFileSync(join(repository, "README.md"), "stable worktree\n");
    const fourth = await port.observe(repository);
    writeFileSync(join(repository, "README.md"), "second staged\n");
    git(repository, "add", "README.md");
    writeFileSync(join(repository, "README.md"), "stable worktree\n");
    const fifth = await port.observe(repository);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(third.status).toBe("ready");
    expect(fourth.status).toBe("ready");
    expect(fifth.status).toBe("ready");
    if (
      first.status !== "ready" ||
      second.status !== "ready" ||
      third.status !== "ready" ||
      fourth.status !== "ready" ||
      fifth.status !== "ready"
    )
      return;
    expect(second.statusEntries).toEqual(first.statusEntries);
    expect(second.stateToken).not.toBe(first.stateToken);
    expect(third.stateToken).not.toBe(second.stateToken);
    expect(fifth.statusEntries).toEqual(fourth.statusEntries);
    expect(fifth.stateToken).not.toBe(fourth.stateToken);
  });

  it("answers mergeability from a linked worktree without adding objects to the repository it shares", async () => {
    const repository = createRepository();
    const linked = join(repository, "..", "linked worktree");
    git(repository, "worktree", "add", "-b", "feature/compare", linked);
    // Both sides move, so the merged tree is one the repository has never
    // stored. A merge that resolves to an existing tree would write nothing
    // and could not tell a quarantined object database from a shared one.
    writeFileSync(join(repository, "base.txt"), "base\n");
    git(repository, "add", "--", "base.txt");
    git(repository, "commit", "-m", "base moves");
    writeFileSync(join(linked, "head.txt"), "head\n");
    git(linked, "add", "--", "head.txt");
    git(linked, "commit", "-m", "head moves");
    const before = allObjectNames(repository);

    const result = await new GitObservationPort(confinedOptions()).compareBranch({
      checkoutRoot: linked,
      baseRef: "main",
      headRef: "HEAD",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(1);
    expect(result.mergeability).toBe("clean");
    expect(allObjectNames(repository)).toEqual(before);
  });

  it("answers mergeability for a checkout whose path contains a newline", async () => {
    // A newline is legal in a macOS path, and the alternates file the merge
    // reads its objects through is newline-separated, so an unquoted entry
    // would name two directories that do not exist.
    const root = join(temporaryDirectory(), "one\ntwo");
    const repository = join(root, "repository");
    mkdirSync(repository, { recursive: true });
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "README.md"), "test\n");
    git(repository, "add", "--", "README.md");
    git(repository, "commit", "-m", "initial");
    git(repository, "checkout", "-q", "-b", "feature/newline");
    writeFileSync(join(repository, "head.txt"), "head\n");
    git(repository, "add", "--", "head.txt");
    git(repository, "commit", "-m", "head moves");

    const result = await new GitObservationPort(confinedOptions()).compareBranch({
      checkoutRoot: repository,
      baseRef: "main",
      headRef: "HEAD",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.mergeability).toBe("clean");
  });

  it("starts a fixed number of Git processes however many paths changed", async () => {
    const repository = createRepository();
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(repository, `tracked-${index}.txt`), "before\n");
    }
    git(repository, "add", "--", ".");
    git(repository, "commit", "-m", "tracked files");
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(repository, `tracked-${index}.txt`), "after\n");
      writeFileSync(join(repository, `untracked-${index}.txt`), "new\n");
    }
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(repository, `staged-${index}.txt`), "staged\n");
    }
    git(repository, "add", "--", "staged-0.txt", "staged-1.txt", "staged-2.txt");
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(repository, `extra-${index}.txt`), "extra\n");
    }
    const calls: string[][] = [];
    const port = recordingPort((args) => calls.push([...args]));

    const result = await port.observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.changedPaths).toHaveLength(30);
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  it("keeps the fixed process count when a deleted file and an untracked directory sit among many changes", async () => {
    const repository = createRepository();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(repository, `tracked-${index}.txt`), "before\n");
    }
    writeFileSync(join(repository, "deleted.txt"), "before\n");
    git(repository, "add", "--", ".");
    git(repository, "commit", "-m", "tracked files");
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(repository, `tracked-${index}.txt`), "after\n");
    }
    rmSync(join(repository, "deleted.txt"));
    mkdirSync(join(repository, "untracked-directory"));
    writeFileSync(join(repository, "untracked-directory", "inner.txt"), "new\n");
    const calls: string[][] = [];
    const port = recordingPort((args) => calls.push([...args]));

    const result = await port.observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.changedPaths).toEqual(
      expect.arrayContaining(["deleted.txt", "untracked-directory"]),
    );
    expect(calls.length).toBeLessThanOrEqual(12);
    expect(calls.filter((args) => args.includes("hash-object"))).toHaveLength(1);
    expect(result.stateToken).toBe(oracleStateToken(result));
  });

  it("reads the same content ids as one Git call per path for every kind of change", async () => {
    const repository = createRepository();
    const tracked = [
      "modified.txt",
      "staged.txt",
      "deleted.txt",
      "old-name.txt",
      "tracked space.txt",
      "tracked\nnewline.txt",
    ];
    for (const name of tracked) writeFileSync(join(repository, name), "before\n");
    git(repository, "add", "--", ...tracked);
    git(repository, "commit", "-m", "tracked files");
    writeFileSync(join(repository, "modified.txt"), "after\n");
    writeFileSync(join(repository, "staged.txt"), "staged\n");
    git(repository, "add", "--", "staged.txt");
    rmSync(join(repository, "deleted.txt"));
    git(repository, "mv", "old-name.txt", "new-name.txt");
    writeFileSync(join(repository, "tracked space.txt"), "after\n");
    writeFileSync(join(repository, "tracked\nnewline.txt"), "after\n");
    writeFileSync(join(repository, "untracked.txt"), "new\n");
    writeFileSync(join(repository, "new space.txt"), "new\n");
    mkdirSync(join(repository, "untracked-directory"));
    writeFileSync(join(repository, "untracked-directory", "inner.txt"), "new\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.changedPaths).toEqual(
      expect.arrayContaining([
        "deleted.txt",
        "old-name.txt",
        "new-name.txt",
        "untracked-directory",
        "tracked\nnewline.txt",
      ]),
    );
    expect(result.stateToken).toBe(oracleStateToken(result));
  });

  it("reads the same content ids as one Git call per path for an unmerged path", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "conflict.txt"), "base\n");
    git(repository, "add", "--", "conflict.txt");
    git(repository, "commit", "-m", "base");
    git(repository, "checkout", "-q", "-b", "other");
    writeFileSync(join(repository, "conflict.txt"), "other\n");
    git(repository, "commit", "-a", "-m", "other");
    git(repository, "checkout", "-q", "main");
    writeFileSync(join(repository, "conflict.txt"), "main\n");
    git(repository, "commit", "-a", "-m", "main");
    expect(() => git(repository, "merge", "other")).toThrow();

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.statusEntries.map((entry) => `${entry.index}${entry.worktree}`)).toEqual(["UU"]);
    expect(result.stateToken).toBe(oracleStateToken(result));
  });

  it("reads the same content ids as one Git call per path on an unborn branch", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    writeFileSync(join(repository, "staged.txt"), "staged\n");
    git(repository, "add", "--", "staged.txt");
    writeFileSync(join(repository, "untracked.txt"), "new\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.head.kind).toBe("unborn");
    expect(result.stateToken).toBe(oracleStateToken(result));
  });

  it("still reads ids for the other paths when one path of a batch was deleted", async () => {
    const repository = createRepository();
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repository, name), "x\n");
    git(repository, "add", "--", ".");
    git(repository, "commit", "-m", "files");
    writeFileSync(join(repository, "a.txt"), "changed\n");
    rmSync(join(repository, "b.txt"));
    writeFileSync(join(repository, "c.txt"), "changed\n");
    const port = new GitObservationPort(confinedOptions());

    const first = await port.observe(repository);
    const firstOracle = first.status === "ready" ? oracleStateToken(first) : undefined;
    writeFileSync(join(repository, "c.txt"), "changed again\n");
    const second = await port.observe(repository);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.stateToken).toBe(firstOracle);
    // Only a surviving path's id can move the token here, because the status
    // entries are unchanged between the two observations.
    expect(second.statusEntries).toEqual(first.statusEntries);
    expect(second.stateToken).not.toBe(first.stateToken);
  });

  it("reads index ids one path at a time when the batched listing fails", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "README.md"), "changed\n");
    writeFileSync(join(repository, "untracked.txt"), "new\n");
    git(repository, "add", "--", "README.md");
    const port = recordingPort(
      () => undefined,
      (args) => (args.includes("ls-files") ? { exitCode: 128, stdout: "" } : undefined),
    );

    const result = await port.observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.stateToken).toBe(oracleStateToken(result));
  });

  it("keeps rewritten remote URLs as git reports them", async () => {
    const repository = createRepository();
    git(repository, "remote", "add", "origin", "gh:octant/one.git");
    git(repository, "config", "url.https://github.com/.insteadOf", "gh:");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.remotes).toEqual([
      {
        name: "origin",
        fetchUrl: "https://github.com/octant/one.git",
        pushUrl: "https://github.com/octant/one.git",
      },
    ]);
  });
});

function observationPortWithNumstat(stdout: string): GitObservationPort {
  return new GitObservationPort(confinedOptions(), {
    realpath,
    execFile: (file, args, environment, signal) =>
      new Promise((resolve) => {
        if (args.includes("--numstat")) {
          resolve({ exitCode: 0, stdout });
          return;
        }
        nodeExecFile(
          file,
          [...args],
          {
            encoding: "utf8",
            env: environment,
            shell: false,
            signal,
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdoutText) => {
            resolve({
              exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
              stdout: stdoutText,
            });
          },
        );
      }),
  });
}

/**
 * A port that runs real Git and reports every command it starts. `override`
 * answers a command in place of Git, for a failure Git will not produce itself.
 */
function recordingPort(
  onCall: (args: readonly string[]) => void,
  override: (args: readonly string[]) => { exitCode: number; stdout: string } | undefined = () =>
    undefined,
): GitObservationPort {
  return new GitObservationPort(confinedOptions(), {
    realpath,
    execFile: (file, args, environment, signal) =>
      new Promise((resolve) => {
        onCall(args);
        const replaced = override(args);
        if (replaced !== undefined) {
          resolve(replaced);
          return;
        }
        nodeExecFile(
          file,
          [...args],
          {
            encoding: "buffer",
            env: environment,
            shell: false,
            signal,
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdoutBytes) => {
            resolve({
              exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
              stdout: stdoutBytes.toString("utf8"),
            });
          },
        );
      }),
  });
}

/**
 * The state token the observation had when each changed path cost two Git
 * processes: the worktree id from `hash-object`, the index id from `rev-parse`.
 */
function oracleStateToken(observation: GitObservation): string {
  const objectId = (args: string[]): string | null => {
    try {
      const text = execFileSync("git", ["-C", observation.checkoutRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text) ? text : null;
    } catch {
      return null;
    }
  };
  const contentObjects = observation.changedPaths.map((path) => ({
    path,
    objectId: objectId(["hash-object", "--no-filters", "--", path]),
    indexObjectId: objectId(["rev-parse", "--verify", `:${path}`]),
  }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        head: observation.head,
        statusEntries: observation.statusEntries,
        contentObjects,
        remotes: observation.remotes,
        upstream: observation.upstream,
        worktrees: observation.worktrees,
      }),
    )
    .digest("hex");
}

function createRepository(): string {
  const root = temporaryDirectory();
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Octant Test");
  git(repository, "config", "user.email", "test@octant.local");
  writeFileSync(join(repository, "README.md"), "test\n");
  git(repository, "add", "--", "README.md");
  git(repository, "commit", "-m", "initial");
  return repository;
}

/** Every object the repository holds, so a stray write shows up by name. */
function allObjectNames(root: string): readonly string[] {
  return gitOutput(root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
    .split("\n")
    .filter(Boolean)
    .sort();
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-git-observation-"));
  directories.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function gitOutput(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
