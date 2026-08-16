import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRootError, ProjectRootPort } from "./projectRootPort";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ProjectRootPort", () => {
  it("canonicalizes Work symlinks and rejects files and missing roots without disclosing paths", async () => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    writeFileSync(join(root, "file"), "data");
    const port = new ProjectRootPort();

    expect(await port.validate("work", link)).toEqual({ canonicalRoot: realpathSync(target) });
    for (const candidate of [join(root, "file"), join(root, "missing")]) {
      const error = await port.validate("work", candidate).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        name: "ProjectRootError",
        message: "The selected Project root is unavailable.",
      });
      expect(String(error)).not.toContain(candidate);
    }
  });

  it("accepts Git repository and linked-worktree roots but rejects nested Code paths", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const nested = join(repository, "nested");
    const worktree = join(root, "worktree");
    mkdirSync(repository);
    execFileSync("git", ["-C", repository, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Octant Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@octant.local"]);
    writeFileSync(join(repository, "README.md"), "test");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
    mkdirSync(nested);
    execFileSync("git", ["-C", repository, "worktree", "add", "-b", "linked", worktree]);
    const port = new ProjectRootPort();

    expect(await port.validate("code", repository)).toEqual({
      canonicalRoot: realpathSync(repository),
    });
    expect(await port.validate("code", worktree)).toEqual({
      canonicalRoot: realpathSync(worktree),
    });
    await expect(port.validate("code", nested)).rejects.toBeInstanceOf(ProjectRootError);
  });

  it("invokes Git with an argument array and no shell", async () => {
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_URL", "http://127.0.0.1:41000/");
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_TOKEN", "broker-secret");
    vi.stubEnv("OCTANT_DESKTOP_BRIDGE_SECRET", "desktop-secret");
    vi.stubEnv("OCTANT_TEST_ALLOWED_ENV", "allowed-value");
    const execFile = vi.fn(
      async (_file: string, _args: readonly string[], _environment: NodeJS.ProcessEnv) => ({
        stdout: "/canonical\n",
      }),
    );
    const port = new ProjectRootPort({
      realpath: async () => "/canonical",
      stat: async () => ({ isDirectory: () => true }),
      execFile,
    });

    await port.validate("code", "/candidate");
    expect(execFile).toHaveBeenCalledOnce();
    const [file, args, environment] = execFile.mock.calls[0]!;
    expect(file).toBe("git");
    expect(args).toEqual(["-C", "/canonical", "rev-parse", "--show-toplevel"]);
    expect(environment).toMatchObject({ OCTANT_TEST_ALLOWED_ENV: "allowed-value" });
    expect(environment).not.toHaveProperty("OCTANT_CREDENTIAL_BROKER_URL");
    expect(environment).not.toHaveProperty("OCTANT_CREDENTIAL_BROKER_TOKEN");
    expect(environment).not.toHaveProperty("OCTANT_DESKTOP_BRIDGE_SECRET");
    expect(process.env.OCTANT_CREDENTIAL_BROKER_TOKEN).toBe("broker-secret");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-root-"));
  directories.push(directory);
  return directory;
}
