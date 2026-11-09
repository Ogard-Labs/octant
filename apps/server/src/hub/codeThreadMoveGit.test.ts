import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureCheckoutForMove,
  checkoutStillMatchesMove,
  filesTheMoveLeft,
  measureCheckoutForMove,
  receiveCheckoutFromMove,
  removeMovedOutWorktree,
} from "./codeThreadMoveGit";

const MOVE = "99999999-9999-4999-8999-999999999999";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Person",
      GIT_AUTHOR_EMAIL: "person@example.invalid",
      GIT_COMMITTER_NAME: "Person",
      GIT_COMMITTER_EMAIL: "person@example.invalid",
    },
  }).trim();

/** An origin, the clone a thread is leaving, and the clone it moves to. */
function repositories() {
  const base = mkdtempSync(join(tmpdir(), "octant-move-git-"));
  folders.push(base);
  const origin = join(base, "origin.git");
  const laptop = join(base, "laptop");
  const desktop = join(base, "desktop");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, laptop);
  writeFileSync(join(laptop, ".gitignore"), ".env\n");
  writeFileSync(join(laptop, "app.ts"), "export const version = 1;\n");
  git(laptop, "add", ".");
  git(laptop, "commit", "-q", "-m", "first");
  git(laptop, "push", "-q", "origin", "main");
  git(base, "clone", "-q", origin, desktop);
  return { laptop, desktop };
}

const show = (cwd: string, object: string) => git(cwd, "show", object);

describe("carrying a Code checkout between computers", () => {
  it("keeps an edit made in the same second as the staging, which a copied index would miss", async () => {
    const { laptop, desktop } = repositories();
    const file = join(laptop, "app.ts");
    writeFileSync(file, "export const version = 3;\n");
    git(laptop, "add", "app.ts");
    const staged = statSync(file);
    writeFileSync(file, "export const version = 4;\n");
    // Same size and the staged timestamp, as an edit within the same second
    // has; Git compares whole seconds. A second later the checkout's index
    // reads as older than nothing in it, so a copy of it trusts the stamp.
    utimesSync(file, staged.atime, staged.mtime);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const bundlePath = join(laptop, "..", "same-second.bundle");

    await captureCheckoutForMove({ checkoutRoot: laptop, moveId: MOVE, bundlePath });
    const received = await receiveCheckoutFromMove({
      repositoryRoot: desktop,
      moveId: MOVE,
      bundlePath,
    });
    if (received.status !== "received") throw new Error("The bundle was refused.");
    expect(show(desktop, `${received.checkout.worktreeTree}:app.ts`)).toBe(
      "export const version = 4;",
    );
    expect((await checkoutStillMatchesMove({ checkoutRoot: laptop, moveId: MOVE })).matches).toBe(
      true,
    );

    // An edit after the snapshot, with the same size and stamp, is still an
    // edit the move did not carry: the worktree must be kept.
    writeFileSync(file, "export const version = 5;\n");
    utimesSync(file, staged.atime, staged.mtime);
    expect((await checkoutStillMatchesMove({ checkoutRoot: laptop, moveId: MOVE })).matches).toBe(
      false,
    );
  });

  it("carries unpushed commits, staged and unstaged versions apart, and untracked files, but never ignored files", async () => {
    const { laptop, desktop } = repositories();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    git(laptop, "commit", "-q", "-am", "not pushed yet");
    writeFileSync(join(laptop, "app.ts"), "export const version = 3;\n");
    git(laptop, "add", "app.ts");
    writeFileSync(join(laptop, "app.ts"), "export const version = 4;\n");
    writeFileSync(join(laptop, "notes.md"), "untracked notes\n");
    writeFileSync(join(laptop, ".env"), "LOCAL_ONLY=1\n");
    const bundlePath = join(laptop, "..", "move.bundle");

    const captured = await captureCheckoutForMove({
      checkoutRoot: laptop,
      moveId: MOVE,
      bundlePath,
    });

    expect(captured.head).toBe(git(laptop, "rev-parse", "HEAD"));
    expect(captured.branch).toBe("main");
    expect(captured.remotes).toHaveLength(1);
    expect(captured.refusedFiles).toEqual([]);
    expect(captured.ignoredFiles).toBeGreaterThanOrEqual(1);
    // The source checkout is left exactly as it was.
    expect(readFileSync(join(laptop, "app.ts"), "utf8")).toBe("export const version = 4;\n");
    expect(git(laptop, "diff", "--cached", "--name-only")).toBe("app.ts");

    const received = await receiveCheckoutFromMove({
      repositoryRoot: desktop,
      moveId: MOVE,
      bundlePath,
    });
    if (received.status !== "received") throw new Error("The bundle was refused.");
    expect(received.checkout.head).toBe(captured.head);
    expect(show(desktop, `${received.checkout.head}:app.ts`)).toBe("export const version = 2;");
    expect(show(desktop, `${received.checkout.indexTree}:app.ts`)).toBe(
      "export const version = 3;",
    );
    expect(show(desktop, `${received.checkout.worktreeTree}:app.ts`)).toBe(
      "export const version = 4;",
    );
    expect(show(desktop, `${received.checkout.worktreeTree}:notes.md`)).toBe("untracked notes");
    expect(() => show(desktop, `${received.checkout.worktreeTree}:.env`)).toThrow();
  });

  it("leaves a changed file the Secret guard finds a secret in behind, and lists it", async () => {
    const { laptop, desktop } = repositories();
    writeFileSync(join(laptop, "config.ts"), `export const token = "ghp_${"a".repeat(36)}";\n`);
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    const bundlePath = join(laptop, "..", "move.bundle");

    const captured = await captureCheckoutForMove({
      checkoutRoot: laptop,
      moveId: MOVE,
      bundlePath,
    });

    expect(captured.refusedFiles).toEqual(["config.ts"]);
    const received = await receiveCheckoutFromMove({
      repositoryRoot: desktop,
      moveId: MOVE,
      bundlePath,
    });
    if (received.status !== "received") throw new Error("The bundle was refused.");
    expect(() => show(desktop, `${received.checkout.worktreeTree}:config.ts`)).toThrow();
    expect(show(desktop, `${received.checkout.worktreeTree}:app.ts`)).toBe(
      "export const version = 2;",
    );
  });

  it("leaves behind a secret that was staged and then edited out of the file on disk", async () => {
    const { laptop, desktop } = repositories();
    writeFileSync(join(laptop, "config.ts"), `export const token = "ghp_${"b".repeat(36)}";\n`);
    git(laptop, "add", "config.ts");
    writeFileSync(join(laptop, "config.ts"), "export const token = process.env.TOKEN;\n");
    const bundlePath = join(laptop, "..", "move.bundle");

    const captured = await captureCheckoutForMove({
      checkoutRoot: laptop,
      moveId: MOVE,
      bundlePath,
    });

    expect(captured.refusedFiles).toEqual(["config.ts"]);
    const received = await receiveCheckoutFromMove({
      repositoryRoot: desktop,
      moveId: MOVE,
      bundlePath,
    });
    if (received.status !== "received") throw new Error("The bundle was refused.");
    expect(() => show(desktop, `${received.checkout.indexTree}:config.ts`)).toThrow();
    expect(() => show(desktop, `${received.checkout.worktreeTree}:config.ts`)).toThrow();
  });

  it("lets the source remove a checkout only when it holds nothing the move did not carry", async () => {
    const { laptop } = repositories();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    const bundlePath = join(laptop, "..", "move.bundle");
    await captureCheckoutForMove({ checkoutRoot: laptop, moveId: MOVE, bundlePath });
    expect(await checkoutStillMatchesMove({ checkoutRoot: laptop, moveId: MOVE })).toEqual({
      matches: true,
      ignoredFiles: 0,
    });

    // An edit after the snapshot exists only here.
    writeFileSync(join(laptop, "app.ts"), "export const version = 5;\n");
    expect((await checkoutStillMatchesMove({ checkoutRoot: laptop, moveId: MOVE })).matches).toBe(
      false,
    );
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    writeFileSync(join(laptop, ".env"), "LOCAL_ONLY=1\n");
    expect(await checkoutStillMatchesMove({ checkoutRoot: laptop, moveId: MOVE })).toEqual({
      matches: true,
      ignoredFiles: 1,
    });
  });

  it("refuses a bundle whose base the destination's clone cannot reach", async () => {
    const { laptop } = repositories();
    const stranger = mkdtempSync(join(tmpdir(), "octant-move-stranger-"));
    folders.push(stranger);
    git(stranger, "init", "-q", "-b", "main");
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    const bundlePath = join(laptop, "..", "move.bundle");
    await captureCheckoutForMove({ checkoutRoot: laptop, moveId: MOVE, bundlePath });

    expect(
      await receiveCheckoutFromMove({ repositoryRoot: stranger, moveId: MOVE, bundlePath }),
    ).toEqual({ status: "refused", reason: "transfer-failed" });
  });
});

describe("the worktree a moved-out thread leaves behind", () => {
  it("names what the move did not carry: a refused file, a later edit, and ignored files", async () => {
    const { laptop } = repositories();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    writeFileSync(join(laptop, "config.ts"), `export const token = "ghp_${"c".repeat(36)}";\n`);
    const bundlePath = join(laptop, "..", "left.bundle");
    await captureCheckoutForMove({ checkoutRoot: laptop, moveId: MOVE, bundlePath });
    writeFileSync(join(laptop, "notes.md"), "written after the snapshot\n");
    writeFileSync(join(laptop, ".env"), "LOCAL_ONLY=1\n");

    expect(await filesTheMoveLeft({ checkoutRoot: laptop, moveId: MOVE })).toEqual([
      ".env",
      "config.ts",
      "notes.md",
    ]);
  });

  it("removes a kept linked worktree with its untracked and ignored files, and leaves its branch", async () => {
    const { laptop } = repositories();
    const kept = join(laptop, "..", "laptop-thread-moved-out-99999999");
    git(laptop, "worktree", "add", "-q", "-b", "octant/thread", kept);
    writeFileSync(join(kept, ".env"), "LOCAL_ONLY=1\n");
    writeFileSync(join(kept, "draft.md"), "not committed\n");

    expect(await removeMovedOutWorktree(kept)).toBe("removed");
    expect(existsSync(kept)).toBe(false);
    expect(git(laptop, "worktree", "list")).not.toContain("moved-out");
    expect(git(laptop, "branch", "--list", "octant/thread")).toContain("octant/thread");
    // Asked again, the folder is already gone.
    expect(await removeMovedOutWorktree(kept)).toBe("removed");
  });

  it("refuses to remove a repository's main checkout or a folder Git does not list", async () => {
    const { laptop } = repositories();
    const stray = mkdtempSync(join(tmpdir(), "octant-move-stray-"));
    folders.push(stray);

    expect(await removeMovedOutWorktree(laptop)).toBe("not-a-linked-worktree");
    expect(await removeMovedOutWorktree(stray)).toBe("not-a-linked-worktree");
    expect(existsSync(join(laptop, "app.ts"))).toBe(true);
    expect(existsSync(stray)).toBe(true);
  });
});

describe("sizing a Code checkout before a move", () => {
  it("measures nothing for a checkout its remote already holds", async () => {
    const { laptop } = repositories();
    expect(await measureCheckoutForMove(laptop)).toBe(0);
  });

  it("counts unpushed commits and changed files but not ignored ones, and writes nothing", async () => {
    const { laptop } = repositories();
    // Random bytes do not compress, so the object on disk is about the file's size.
    writeFileSync(join(laptop, "data.bin"), randomBytes(200_000));
    git(laptop, "add", "data.bin");
    git(laptop, "commit", "-q", "-m", "not pushed yet");
    writeFileSync(join(laptop, "notes.txt"), randomBytes(50_000));
    writeFileSync(join(laptop, ".env"), randomBytes(400_000));
    const indexBefore = statSync(join(laptop, ".git", "index")).mtimeMs;

    const bytes = await measureCheckoutForMove(laptop);

    expect(bytes).toBeGreaterThanOrEqual(250_000);
    expect(bytes).toBeLessThan(300_000);
    expect(git(laptop, "for-each-ref", "refs/octant")).toBe("");
    expect(statSync(join(laptop, ".git", "index")).mtimeMs).toBe(indexBefore);
    expect(git(laptop, "status", "--porcelain")).toBe("?? notes.txt");
  });
});
