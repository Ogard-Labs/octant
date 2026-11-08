import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCheckoutForMove, receiveCheckoutFromMove } from "./codeThreadMoveGit";

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
