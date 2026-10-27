import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeCodeRelativePath } from "@octant/contracts/code";
import { SshExecutorReadReply } from "@octant/contracts/ssh-executor-protocol";
import { SshRemotePath } from "@octant/contracts/ssh-target";
import type { ProcessConfinementPort } from "../process/seatbeltProfile";
import {
  answerExecutorRead,
  parsePorcelainV2,
  type ExecutorReadEnvironment,
} from "./executorReads";
import { createExecutorWorktree, removeExecutorWorktree } from "./executorWorktrees";

/**
 * The executor's reads against real folders on this machine. Confinement is
 * replaced by a port that records the grants and runs Git unconfined, so the
 * containment and Git parsing are proved wherever the tests run; the loopback
 * smoke test runs the same reads through bubblewrap on a real target.
 */

const remotePath = Schema.decodeUnknownSync(SshRemotePath);
let directory: string;
let checkout: string;
let environment: ExecutorReadEnvironment;
const grants: Array<Record<string, unknown>> = [];

const passThrough: ProcessConfinementPort = {
  prepare: (input) => {
    grants.push({
      writeBoundRoot: input.writeBoundRoot,
      allowProcessExec: input.allowProcessExec,
      allowProcessFork: input.allowProcessFork,
      networkEgress: input.networkEgress,
    });
    return { command: input.executable, args: input.args };
  },
};

function git(...args: ReadonlyArray<string>): void {
  const result = spawnSync(
    "git",
    ["-C", checkout, "-c", "user.name=Octant", "-c", "user.email=octant@example.invalid", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-executor-reads-")));
  checkout = join(directory, "app");
  mkdirSync(join(directory, "home", ".ssh", "keys"), { recursive: true });
  mkdirSync(join(directory, "runtime", "session"), { recursive: true });
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  writeFileSync(join(directory, "secret"), "outside\n");
  symlinkSync(join(directory, "secret"), join(checkout, "escape"));
  symlinkSync(join(directory, "home"), join(checkout, "home-link"));
  symlinkSync(checkout, join(directory, "app-link"));
  grants.length = 0;
  environment = {
    platform: process.platform,
    homeDirectory: join(directory, "home"),
    sessionDirectory: join(directory, "runtime", "session"),
    sessionParent: join(directory, "runtime"),
    confinement: passThrough,
  };
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("executor reads of a bound remote root", () => {
  it("resolves the folder to bind to its canonical path and refuses one holding or inside the SSH keys or the executor's runtime", async () => {
    expect(
      await answerExecutorRead(environment, {
        kind: "resolve-root",
        root: remotePath(join(directory, "app-link")),
      }),
    ).toEqual({ kind: "root-resolved", root: checkout });
    for (const root of [
      directory,
      join(directory, "home"),
      join(directory, "home", ".ssh", "keys"),
      "/",
      join(directory, "runtime", "session"),
    ]) {
      expect(
        await answerExecutorRead(environment, { kind: "resolve-root", root: remotePath(root) }),
      ).toEqual({ kind: "refused", reason: "root-not-confinable" });
    }
    expect(
      await answerExecutorRead(environment, {
        kind: "resolve-root",
        root: remotePath(join(directory, "app", "README.md")),
      }),
    ).toEqual({ kind: "refused", reason: "root-unavailable" });
    // A canonical path the host's schema refuses would end the session.
    mkdirSync(join(directory, "line\nbreak"));
    symlinkSync(join(directory, "line\nbreak"), join(directory, "plain-link"));
    expect(
      await answerExecutorRead(environment, {
        kind: "resolve-root",
        root: remotePath(join(directory, "plain-link")),
      }),
    ).toEqual({ kind: "refused", reason: "root-unavailable" });
  });

  it("refuses a link out of the root, leaves it out of listings, and refuses a root that moved", async () => {
    const root = remotePath(checkout);
    expect(await answerExecutorRead(environment, { kind: "list-directory", root })).toEqual({
      kind: "directory-listed",
      listing: {
        entries: [
          { kind: "file", path: "README.md", byteLength: 6 },
          { kind: "directory", path: "src" },
        ],
        truncated: false,
      },
    });
    for (const path of ["escape", "home-link/.ssh"]) {
      expect(
        await answerExecutorRead(environment, {
          kind: "read-file",
          root,
          path: decodeCodeRelativePath(path),
        }),
      ).toEqual({ kind: "refused", reason: "outside-root" });
    }
    expect(
      await answerExecutorRead(environment, {
        kind: "list-directory",
        root,
        directory: decodeCodeRelativePath("home-link"),
      }),
    ).toEqual({ kind: "refused", reason: "outside-root" });
    expect(
      await answerExecutorRead(environment, {
        kind: "read-file",
        root,
        path: decodeCodeRelativePath("missing.txt"),
      }),
    ).toEqual({ kind: "refused", reason: "not-found" });
    const read = await answerExecutorRead(environment, {
      kind: "read-file",
      root,
      path: decodeCodeRelativePath("README.md"),
    });
    expect(read).toEqual({
      kind: "file-read",
      file: {
        path: "README.md",
        byteLength: 6,
        contentBase64: Buffer.from("hello\n").toString("base64"),
      },
    });
    // The bound path through a link is not the canonical root it was bound as.
    expect(
      await answerExecutorRead(environment, {
        kind: "list-directory",
        root: remotePath(join(directory, "app-link")),
      }),
    ).toEqual({ kind: "refused", reason: "root-moved" });
  });

  it("reads Git status and diff with Plan's grants and nothing that starts another program", async () => {
    const root = remotePath(checkout);
    expect(await answerExecutorRead(environment, { kind: "git-status", root })).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
    git("init", "-q", "--initial-branch=main");
    expect(await answerExecutorRead(environment, { kind: "git-status", root })).toMatchObject({
      kind: "git-status",
      status: { head: { kind: "unborn", name: "main" } },
    });
    git("add", "README.md");
    git("commit", "-q", "-m", "initial");
    writeFileSync(join(checkout, "README.md"), "hello\nchanged\n");
    writeFileSync(join(checkout, "with space.txt"), "new\n");
    const status = await answerExecutorRead(environment, { kind: "git-status", root });
    expect(status).toMatchObject({
      kind: "git-status",
      status: { head: { kind: "branch", name: "main" }, truncated: false },
    });
    if (status.kind === "git-status") {
      expect(status.status.entries).toEqual([
        { path: "README.md", index: " ", worktree: "M" },
        { path: "escape", index: "?", worktree: "?" },
        { path: "home-link", index: "?", worktree: "?" },
        { path: "with space.txt", index: "?", worktree: "?" },
      ]);
    }
    const diff = await answerExecutorRead(environment, {
      kind: "git-diff",
      root,
      path: decodeCodeRelativePath("README.md"),
    });
    expect(diff.kind === "git-diff" && diff.diff.text).toContain("+changed");
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).toEqual({
        writeBoundRoot: false,
        allowProcessExec: false,
        allowProcessFork: false,
        networkEgress: "none",
      });
    }
  });

  it("cuts a diff whose text outgrows its bound once decoded, rather than sending a reply the host refuses", async () => {
    const root = remotePath(checkout);
    git("init", "-q", "--initial-branch=main");
    git("add", "README.md");
    git("commit", "-q", "-m", "initial");
    // Latin-1 text: each byte that is not UTF-8 decodes to a three-byte
    // replacement character, so 120 KiB of output is past 256 KiB as text.
    writeFileSync(join(checkout, "README.md"), Buffer.alloc(120 * 1_024, "\xe9\n", "latin1"));
    const diff = await answerExecutorRead(environment, { kind: "git-diff", root });
    expect(Schema.is(SshExecutorReadReply)(diff)).toBe(true);
    expect(diff).toMatchObject({ kind: "git-diff", diff: { truncated: true } });
  });

  it("reads no repository from a folder above the bound root when the root has none of its own", async () => {
    // The folder holding the checkout is a repository; the bound root is a
    // plain folder inside it. Git must not walk up to the one the person did
    // not bind, even where confinement would let it read there.
    const outer = join(directory, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "notes.txt"), "inner\n");
    spawnSync("git", ["init", "-q", outer], { encoding: "utf8" });
    const root = remotePath(inner);
    expect(await answerExecutorRead(environment, { kind: "git-status", root })).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
    expect(await answerExecutorRead(environment, { kind: "git-diff", root })).toMatchObject({
      kind: "refused",
    });
  });

  it("reads renamed and unmerged entries from porcelain status and drops a record a bound cut", () => {
    const output = Buffer.from(
      [
        "# branch.oid 0123456789abcdef0123456789abcdef01234567",
        "# branch.head main",
        "2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.ts",
        "old name.ts",
        "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts",
        "1 .M N... 100644 100644 100644 aaaa bbbb cut-off",
      ].join("\u0000"),
    );
    expect(parsePorcelainV2(output, true)).toEqual({
      head: { kind: "branch", name: "main", oid: "0123456789abcdef0123456789abcdef01234567" },
      entries: [
        { path: "new name.ts", originalPath: "old name.ts", index: "R", worktree: " " },
        { path: "conflict.ts", index: "U", worktree: "U" },
      ],
      truncated: true,
    });
  });
});

describe("executor managed worktrees of a bound root", () => {
  it("removes only its own worktree's record when the folder is already gone, keeping the person's other worktrees", async () => {
    git("init", "-q", "--initial-branch=main");
    git("add", "README.md");
    git("commit", "-q", "-m", "initial");
    const project = "11111111-1111-4111-8111-111111111111";
    const root = remotePath(checkout);
    const created = await createExecutorWorktree(environment, {
      kind: "create-worktree",
      root,
      project,
      name: "gone",
    });
    expect(created).toMatchObject({ kind: "worktree-created", branch: "octant/gone" });
    // The person's own worktree, whose folder is on a volume that is not
    // mounted right now.
    const mine = join(directory, "mine");
    git("worktree", "add", "-q", "-b", "mine", mine);
    rmSync(mine, { recursive: true, force: true });
    rmSync(join(directory, ".octant-worktrees", project, "gone"), { recursive: true, force: true });

    const remove = { kind: "remove-worktree", root, project, name: "gone" } as const;
    expect(await removeExecutorWorktree(environment, remove)).toEqual({ kind: "worktree-removed" });
    const listed = spawnSync("git", ["-C", checkout, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(listed).toContain(`worktree ${mine}`);
    expect(listed).not.toContain("octant/gone");
    // Asked again, there is nothing left of it to remove.
    expect(await removeExecutorWorktree(environment, remove)).toEqual({ kind: "worktree-removed" });
  });
});
