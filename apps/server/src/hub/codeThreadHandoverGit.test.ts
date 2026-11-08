import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitHandover, pushHandover, readHandoverCheckout } from "./codeThreadHandoverGit";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** An origin and the clone a thread works in, with the person's own commit identity. */
function repository(options: { readonly withRemote?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "octant-handover-git-"));
  folders.push(base);
  const origin = join(base, "origin.git");
  const laptop = join(base, "laptop");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, laptop);
  git(laptop, "config", "user.name", "Person");
  git(laptop, "config", "user.email", "person@example.invalid");
  writeFileSync(join(laptop, ".gitignore"), ".env\n");
  writeFileSync(join(laptop, "app.ts"), "export const version = 1;\n");
  git(laptop, "add", ".");
  git(laptop, "commit", "-q", "-m", "first");
  git(laptop, "push", "-q", "origin", "main");
  if (options.withRemote === false) git(laptop, "remote", "remove", "origin");
  return { origin, laptop };
}

describe("handing a Code thread over through its branch", () => {
  it("commits staged, unstaged and untracked work with the note, keeps secrets and ignored files out, and pushes", async () => {
    const { origin, laptop } = repository();
    git(laptop, "checkout", "-q", "-b", "feature/dark-mode");
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    git(laptop, "add", "app.ts");
    writeFileSync(join(laptop, "app.ts"), "export const version = 3;\n");
    writeFileSync(join(laptop, "notes.md"), "untracked notes\n");
    writeFileSync(
      join(laptop, "secrets.ts"),
      'const key = "sk-ant-api03-' + "a".repeat(90) + '";\n',
    );
    writeFileSync(join(laptop, ".env"), "LOCAL_ONLY=1\n");

    const before = await readHandoverCheckout(laptop);
    expect(before.branch).toBe("feature/dark-mode");
    expect(before.defaultBranch).toBe("main");
    expect(before.ignoredFiles).toBeGreaterThanOrEqual(1);

    const committed = await commitHandover({
      checkoutRoot: laptop,
      branch: "feature/dark-mode",
      message: "Hand over: Add dark mode\n\nOctant-Handover: 1234\n",
    });
    if (committed.status !== "committed") throw new Error(committed.reason);
    expect(committed.refusedFiles).toEqual(["secrets.ts"]);
    expect(git(laptop, "show", "HEAD:app.ts")).toBe("export const version = 3;");
    expect(git(laptop, "show", "HEAD:notes.md")).toBe("untracked notes");
    expect(() => git(laptop, "show", "HEAD:.env")).toThrow();
    expect(() => git(laptop, "show", "HEAD:secrets.ts")).toThrow();
    expect(git(laptop, "log", "-1", "--format=%B")).toContain("Octant-Handover: 1234");
    // The checkout's files stay as they are; only the refused file reads as changed.
    expect(readFileSync(join(laptop, "app.ts"), "utf8")).toBe("export const version = 3;\n");
    expect(git(laptop, "status", "--porcelain")).toBe("?? secrets.ts");

    expect(
      await pushHandover({
        checkoutRoot: laptop,
        branch: "feature/dark-mode",
        defaultBranch: "main",
      }),
    ).toEqual({ status: "pushed", remote: "origin" });
    expect(git(origin, "rev-parse", "feature/dark-mode")).toBe(committed.commit);
  });

  it("puts work on the default branch onto a new handover branch without moving the checkout", async () => {
    const { origin, laptop } = repository();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");

    const committed = await commitHandover({
      checkoutRoot: laptop,
      branch: "octant/handover/fix-the-thing-77777777",
      message: "Hand over\n",
    });
    if (committed.status !== "committed") throw new Error(committed.reason);
    expect(git(laptop, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(laptop, "rev-parse", "main")).not.toBe(committed.commit);
    expect(git(laptop, "show", "octant/handover/fix-the-thing-77777777:app.ts")).toBe(
      "export const version = 2;",
    );
    expect(
      (
        await pushHandover({
          checkoutRoot: laptop,
          branch: "octant/handover/fix-the-thing-77777777",
          defaultBranch: "main",
        })
      ).status,
    ).toBe("pushed");
    expect(git(origin, "rev-parse", "main")).not.toBe(committed.commit);
  });

  it("never pushes to the default branch, and says so when there is no remote", async () => {
    const { laptop } = repository({ withRemote: false });
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    expect(
      await pushHandover({ checkoutRoot: laptop, branch: "main", defaultBranch: "main" }),
    ).toEqual({ status: "not-pushed", shortfall: "push-failed" });
    expect(
      await pushHandover({
        checkoutRoot: laptop,
        branch: "octant/handover/x",
        defaultBranch: "main",
      }),
    ).toEqual({ status: "not-pushed", shortfall: "no-remote" });
  });

  it("refuses an empty handover rather than writing a commit with nothing in it", async () => {
    const { laptop } = repository();
    expect(
      await commitHandover({ checkoutRoot: laptop, branch: "main", message: "Hand over\n" }),
    ).toEqual({ status: "refused", reason: "nothing-to-commit" });
  });
});
