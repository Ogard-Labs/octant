// Owner: selected Git hunks. Finite60s wrapper; owns only named temporary Git/confinement roots.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { GitObservationPort } from "./gitObservationPort";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
test("selected native hunks preserve mixed index/worktree state and refuse drift", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-hunks-mixed-")));
  const confinement = createFakeSandboxConfinement("octant-hunks-confinement-");
  const executable = (process.env.PATH ?? "")
    .split(delimiter)
    .map((path) => join(path, "git"))
    .find((path) => existsSync(path));
  const git = (...args: string[]) => {
    if (executable === undefined) throw Error("Configured Git unavailable");
    return execFileSync(executable, ["-C", root, ...args], { encoding: "utf8" });
  };
  const { GitMutationPort } = await import("./gitMutationPort");
  const { GitService } = await import("./gitService");
  const { selectedGitHunkPatch } = await import("./gitHunks");
  try {
    if (executable === undefined) throw new Error("Configured Git unavailable.");
    git("init", "-b", "main");
    git("config", "user.name", "Hunk fixture");
    git("config", "user.email", "hunks@example.invalid");
    const original = Array.from({ length: 60 }, (_, index) => `original line ${index + 1}`);
    const lines = [...original];
    const path = join(root, "mixed.txt");
    const write = () => writeFileSync(path, lines.join("\n") + "\n");
    write();
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "baseline");
    lines[1] = "staged-change";
    write();
    git("add", "mixed.txt");
    lines[19] = "first-unstaged";
    lines[44] = "second-unstaged";
    write();
    const options = {
      confinement: confinement.confinement,
      temporaryDirectory: confinement.temporaryDirectory,
      gitExecutable: executable,
    };
    const native = new GitMutationPort(undefined, options);
    const service = new GitService(new GitObservationPort(options), native);
    const scope = (kind: "unstaged" | "staged") => ({
      checkoutId: "fixture",
      checkoutRoot: root,
      scope: kind,
      current: () => true,
    });
    const prepare = async (kind: "unstaged" | "staged") => {
      const value = await service.prepareHunks(scope(kind));
      assert.equal(value.status, "ready");
      if (value.status !== "ready") throw Error("Comparison unavailable");
      return value;
    };
    const apply = async (
      comparison: Awaited<ReturnType<typeof prepare>>,
      action: "stage" | "unstage" | "reverse",
      selected: readonly string[],
      current = () => true,
    ) =>
      service.applyHunks({
        ...scope(comparison.scope),
        action,
        selected,
        expectedStateToken: comparison.stateToken,
        expectedDigest: comparison.digest,
        executionPolicy: "full-access",
        current,
      });
    const beforeHead = git("rev-parse", "HEAD");
    const worktree = lines.join("\n") + "\n";
    let preview = await prepare("unstaged");
    assert.equal(preview.hunks.length, 2);
    assert.deepEqual(await apply(preview, "stage", [preview.hunks[0]!.id]), { status: "applied" });
    assert.equal(git("show", ":mixed.txt").split("\n")[19], "first-unstaged");
    assert.equal(git("show", ":mixed.txt").split("\n")[44], original[44]);
    assert.equal(readFileSync(path, "utf8"), worktree);
    preview = await prepare("staged");
    assert.equal(preview.hunks.length, 2);
    const first = preview.hunks.find((h) => h.newStart > 10)!;
    assert.deepEqual(await apply(preview, "unstage", [first.id]), { status: "applied" });
    assert.equal(git("show", ":mixed.txt").split("\n")[1], "staged-change");
    assert.equal(git("show", ":mixed.txt").split("\n")[19], original[19]);
    assert.equal(readFileSync(path, "utf8"), worktree);
    preview = await prepare("unstaged");
    const second = preview.hunks.find((h) => h.newStart > 30)!;
    assert.deepEqual(await apply(preview, "reverse", [second.id]), { status: "applied" });
    lines[44] = original[44]!;
    assert.equal(readFileSync(path, "utf8"), lines.join("\n") + "\n");
    assert.equal(git("show", ":mixed.txt").split("\n")[1], "staged-change");
    preview = await prepare("unstaged");
    const index = git("write-tree");
    assert.deepEqual(await apply(preview, "stage", [preview.hunks[0]!.id, preview.hunks[0]!.id]), {
      status: "rejected",
      reason: "invalid-hunks",
    });
    assert.deepEqual(await apply(preview, "unstage", [preview.hunks[0]!.id]), {
      status: "rejected",
      reason: "invalid-hunks",
    });
    assert.deepEqual(await apply(preview, "stage", [preview.hunks[0]!.id], () => false), {
      status: "rejected",
      reason: "stale-state",
    });
    const patch = selectedGitHunkPatch(preview, [preview.hunks[0]!.id], "reverse")!;
    assert.ok(patch);
    writeFileSync(path, "external inserted line\n" + lines.join("\n") + "\n");
    assert.deepEqual(await apply(preview, "stage", [preview.hunks[0]!.id]), {
      status: "rejected",
      reason: "stale-state",
    });
    const moved = await native.applyHunks({
      checkoutRoot: root,
      action: "reverse",
      patch,
      beforeApply: async () => true,
      current: () => true,
      executionPolicy: "full-access",
    });
    assert.deepEqual(moved, { status: "rejected", reason: "hunk-offset" });
    assert.equal(readFileSync(path, "utf8"), "external inserted line\n" + lines.join("\n") + "\n");
    assert.equal(git("write-tree"), index);
    write();
    preview = await prepare("unstaged");
    lines[54] = "external index change";
    write();
    git("add", "mixed.txt");
    assert.deepEqual(await apply(preview, "stage", [preview.hunks[0]!.id]), {
      status: "rejected",
      reason: "stale-state",
    });
    assert.equal(git("rev-parse", "HEAD"), beforeHead);
    git("reset", "--hard", "HEAD");
    unlinkSync(path);
    preview = await prepare("unstaged");
    assert.equal(preview.hunks.length, 1);
    assert.equal(preview.hunks[0]!.newLines, 0);
    assert.deepEqual(await apply(preview, "stage", [preview.hunks[0]!.id]), { status: "applied" });
    assert.equal(git("ls-files", "mixed.txt"), "");
    assert.equal(existsSync(path), false);
    preview = await prepare("staged");
    assert.deepEqual(await apply(preview, "unstage", [preview.hunks[0]!.id]), {
      status: "applied",
    });
    assert.equal(git("ls-files", "mixed.txt").trim(), "mixed.txt");
    assert.equal(existsSync(path), false);
    preview = await prepare("unstaged");
    assert.deepEqual(await apply(preview, "reverse", [preview.hunks[0]!.id]), {
      status: "applied",
    });
    assert.equal(existsSync(path), true);
    assert.equal(git("rev-parse", "HEAD"), beforeHead);
    git("checkout", "-b", "conflicting");
    writeFileSync(path, "branch change\n" + original.slice(1).join("\n") + "\n");
    git("add", "mixed.txt");
    git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "branch");
    git("checkout", "main");
    writeFileSync(path, "main change\n" + original.slice(1).join("\n") + "\n");
    git("add", "mixed.txt");
    git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "main");
    let conflicted = false;
    try {
      git("-c", "core.hooksPath=/dev/null", "merge", "conflicting");
    } catch {
      conflicted = true;
    }
    assert.equal(conflicted, true);
    preview = await prepare("unstaged");
    assert.equal(preview.hunks.length, 0);
    assert.ok(
      preview.unavailable.some((item) => item.path === "mixed.txt" && item.reason === "conflict"),
    );
    git("merge", "--abort");
    git("reset", "--hard", "HEAD");
    git("mv", "mixed.txt", "renamed.txt");
    preview = await prepare("staged");
    assert.equal(preview.hunks.length, 0);
    assert.ok(preview.unavailable.some((item) => item.reason === "rename"));
    git("reset", "--hard", "HEAD");
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    git("add", "binary.dat");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "binary baseline",
    );
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 2, 3]));
    preview = await prepare("unstaged");
    assert.equal(preview.hunks.length, 0);
    assert.ok(
      preview.unavailable.some((item) => item.path === "binary.dat" && item.reason === "binary"),
    );
    git("reset", "--hard", "HEAD");
    writeFileSync(path, Buffer.from([0xff, 0x0a]));
    const nonUtf8 = await service.prepareHunks(scope("unstaged"));
    assert.equal(nonUtf8.status, "unavailable");
    console.log("PASS actual rename/binary refusal and non-UTF-8 canonical read fails closed.");
    console.log(
      "PASS actual deleted file stage/unstage/reverse and native unmerged conflict refusal.",
    );
    console.log(
      "PASS actual selected stage/unstage/reversal; unrelated index/worktree preserved; duplicate/scope/authority/stale index/stale worktree/offset refused; HEAD unchanged by hunk operations.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(confinement.root, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        cleanup: {
          repoRemoved: !existsSync(root),
          confinementRemoved: !existsSync(confinement.root),
        },
      }),
    );
  }
}, 60_000);

test("selected native hunks apply cleanly when an earlier unselected hunk changes the line count", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-hunks-shifted-")));
  const confinement = createFakeSandboxConfinement("octant-hunks-shifted-confinement-");
  const executable = (process.env.PATH ?? "")
    .split(delimiter)
    .map((path) => join(path, "git"))
    .find((path) => existsSync(path));
  const git = (...args: string[]) => {
    if (executable === undefined) throw Error("Configured Git unavailable");
    return execFileSync(executable, ["-C", root, ...args], { encoding: "utf8" });
  };
  const { GitMutationPort } = await import("./gitMutationPort");
  const { GitService } = await import("./gitService");
  try {
    if (executable === undefined) throw new Error("Configured Git unavailable.");
    git("init", "-b", "main");
    git("config", "user.name", "Hunk fixture");
    git("config", "user.email", "hunks@example.invalid");
    const original = Array.from({ length: 40 }, (_, index) => `original line ${index + 1}`);
    const path = join(root, "shifted.txt");
    const write = (lines: readonly string[]) => writeFileSync(path, lines.join("\n") + "\n");
    write(original);
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "baseline");
    const options = {
      confinement: confinement.confinement,
      temporaryDirectory: confinement.temporaryDirectory,
      gitExecutable: executable,
    };
    const service = new GitService(
      new GitObservationPort(options),
      new GitMutationPort(undefined, options),
    );
    const scope = (kind: "unstaged" | "staged") => ({
      checkoutId: "fixture",
      checkoutRoot: root,
      scope: kind,
      current: () => true,
    });
    const prepare = async (kind: "unstaged" | "staged") => {
      const value = await service.prepareHunks(scope(kind));
      if (value.status !== "ready") throw Error("Comparison unavailable");
      return value;
    };
    const applyLater = async (
      kind: "unstaged" | "staged",
      action: "stage" | "unstage" | "reverse",
    ) => {
      const comparison = await prepare(kind);
      assert.equal(comparison.hunks.length, 2);
      const later = comparison.hunks.find((hunk) => hunk.oldStart > 20);
      if (later === undefined) throw Error("Later hunk missing");
      return service.applyHunks({
        ...scope(kind),
        action,
        selected: [later.id],
        expectedStateToken: comparison.stateToken,
        expectedDigest: comparison.digest,
        executionPolicy: "full-access",
        current: () => true,
      });
    };
    // An earlier three-line insertion stays unselected; only the later replacement moves.
    const edited = [
      ...original.slice(0, 2),
      "inserted 1",
      "inserted 2",
      "inserted 3",
      ...original.slice(2),
    ];
    edited[29] = "later replacement";
    write(edited);
    assert.deepEqual(await applyLater("unstaged", "stage"), { status: "applied" });
    const staged = [...original];
    staged[26] = "later replacement";
    assert.equal(git("show", ":shifted.txt"), staged.join("\n") + "\n");
    git("add", "shifted.txt");
    assert.deepEqual(await applyLater("staged", "unstage"), { status: "applied" });
    assert.equal(
      git("show", ":shifted.txt"),
      [
        ...original.slice(0, 2),
        "inserted 1",
        "inserted 2",
        "inserted 3",
        ...original.slice(2),
      ].join("\n") + "\n",
    );
    git("reset", "-q", "--", "shifted.txt");
    assert.deepEqual(await applyLater("unstaged", "reverse"), { status: "applied" });
    const reversed = [...edited];
    reversed[29] = original[26]!;
    assert.equal(readFileSync(path, "utf8"), reversed.join("\n") + "\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(confinement.root, { recursive: true, force: true });
  }
}, 60_000);
