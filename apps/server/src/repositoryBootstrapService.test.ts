import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProjectId, decodeWindowId, type Project } from "@octant/contracts";
import { decodeRepositoryBootstrapOperationId } from "@octant/contracts/repository-bootstrap";
import { afterEach, describe, expect, it } from "vitest";
import { BindingReceiptStore } from "./bindingReceiptStore";
import { ProjectRootPort } from "./projectRootPort";
import {
  RepositoryBootstrapService,
  buildBootstrapCloneArgs,
  buildBootstrapCloneEnvironment,
  type RepositoryBootstrapCloneRunner,
} from "./repositoryBootstrapService";

const PROJECT_ID = decodeProjectId("22222222-2222-4222-8222-222222222222");
const WINDOW_ID = decodeWindowId("33333333-3333-4333-8333-333333333333");
const OTHER_WINDOW_ID = decodeWindowId("44444444-4444-4444-8444-444444444444");

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function initGitRepo(dir: string, originUrl?: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(
    join(dir, ".gitignore"),
    [
      ".env",
      ".env.local",
      "node_modules/",
      "dist/",
      ".DS_Store",
      "Thumbs.db",
      "secret-link",
      "*.log",
    ].join("\n") + "\n",
  );
  execFileSync("git", ["-C", dir, "add", "README.md", ".gitignore"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  if (originUrl !== undefined) {
    execFileSync("git", ["-C", dir, "remote", "add", "origin", originUrl]);
  }
}

function makeCodeProject(canonicalRoot: string, name = "demo"): Project {
  return {
    type: "code",
    id: PROJECT_ID,
    name,
    lifecycle: "active",
    pinned: false,
    rank: "a0",
    createdAt: "2026-11-24T20:00:00.000Z",
    binding: { canonicalRoot },
    bindingHistory: [],
  } as unknown as Project;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("repository bootstrap service", () => {
  it("inspects origin remotes and lists plain gitignored files while excluding ignored directories, symlinks, OS junk, and .git internals", async () => {
    const repoDir = makeTempDir("octant-repo-inspect-");
    const outsideDir = makeTempDir("octant-repo-outside-");
    initGitRepo(repoDir, "git@github.com:org/demo.git");

    // Plain ignored files (should be listed)
    writeFileSync(join(repoDir, ".env"), "API_KEY=secret\n", { mode: 0o600 });
    mkdirSync(join(repoDir, "apps", "web"), { recursive: true });
    writeFileSync(join(repoDir, "apps", "web", ".env.local"), "PORT=3000\n", { mode: 0o644 });
    writeFileSync(join(repoDir, "local.log"), "hello\n", { mode: 0o644 });

    // Whole ignored directories (should be excluded)
    mkdirSync(join(repoDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(repoDir, "dist"), { recursive: true });
    writeFileSync(join(repoDir, "dist", "bundle.js"), "console.log(1);\n");

    // OS junk (should be excluded)
    writeFileSync(join(repoDir, ".DS_Store"), "junk");
    writeFileSync(join(repoDir, "apps", "web", "Thumbs.db"), "junk");

    // Symlink (should be excluded)
    writeFileSync(join(outsideDir, "outside.txt"), "secret-outside");
    symlinkSync(join(outsideDir, "outside.txt"), join(repoDir, "secret-link"));

    const service = new RepositoryBootstrapService({
      readProject: (id) =>
        String(id) === String(PROJECT_ID) ? makeCodeProject(repoDir) : undefined,
      bindingReceiptStore: new BindingReceiptStore(),
      projectRootPort: new ProjectRootPort(),
      homeDir: outsideDir,
    });

    try {
      const result = await service.inspect({ projectId: PROJECT_ID }, new AbortController().signal);
      expect(result.repositoryName).toBe("demo");
      expect(result.defaultDestinationPath).toBe("~/demo");
      expect(result.remotes).toEqual({
        originUrl: "git@github.com:org/demo.git",
        sshUrl: "git@github.com:org/demo.git",
        httpsUrl: "https://github.com/org/demo.git",
        defaultTransport: "ssh",
      });
      expect(result.ignoredFiles).toEqual([
        { path: ".env", bytes: 15, secretGuardMatched: true },
        { path: "apps/web/.env.local", bytes: 10, secretGuardMatched: true },
        { path: "local.log", bytes: 6, secretGuardMatched: false },
      ]);
      expect(result.truncated).toBe(false);
      expect(result.omittedCount).toBe(0);
      expect(result.omittedOversizedCount).toBe(0);
    } finally {
      service.close();
    }
  });

  it("reports structured truncation metadata when entry or byte caps are exceeded", async () => {
    const repoDir = makeTempDir("octant-repo-caps-");
    initGitRepo(repoDir, "https://github.com/org/demo.git");
    writeFileSync(join(repoDir, "a.log"), "12345");
    writeFileSync(join(repoDir, "b.log"), "12345");
    writeFileSync(join(repoDir, "big.log"), "12345678901234567890");

    const service = new RepositoryBootstrapService({
      readProject: () => makeCodeProject(repoDir),
      bindingReceiptStore: new BindingReceiptStore(),
      projectRootPort: new ProjectRootPort(),
      homeDir: repoDir,
      caps: { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 100 },
    });

    try {
      const result = await service.inspect({ projectId: PROJECT_ID }, new AbortController().signal);
      expect(result.ignoredFiles).toEqual([{ path: "a.log", bytes: 5, secretGuardMatched: false }]);
      expect(result.truncated).toBe(true);
      expect(result.omittedCount).toBe(1);
      expect(result.omittedOversizedCount).toBe(1);
    } finally {
      service.close();
    }
  });

  it("reads only explicitly requested gitignored plain files and refuses tracked files, symlinks, and .git internals", async () => {
    const repoDir = makeTempDir("octant-repo-read-");
    const outsideDir = makeTempDir("octant-repo-read-outside-");
    initGitRepo(repoDir, "git@github.com:org/demo.git");

    writeFileSync(join(repoDir, ".env"), "SECRET=1\n");
    chmodSync(join(repoDir, ".env"), 0o600);
    writeFileSync(join(outsideDir, "outside.env"), "NOPE=1\n");
    symlinkSync(join(outsideDir, "outside.env"), join(repoDir, "secret-link"));

    const service = new RepositoryBootstrapService({
      readProject: () => makeCodeProject(repoDir),
      bindingReceiptStore: new BindingReceiptStore(),
      projectRootPort: new ProjectRootPort(),
      homeDir: outsideDir,
    });

    try {
      const file = await service.readIgnoredFile(
        { projectId: PROJECT_ID, relativePath: ".env" },
        new AbortController().signal,
      );
      expect(file.relativePath).toBe(".env");
      expect(file.bytes).toBe(9);
      expect(file.mode).toBe(0o600);
      expect(Buffer.from(file.contentBase64, "base64").toString("utf8")).toBe("SECRET=1\n");
      expect(file.sha256).toBe(createHash("sha256").update("SECRET=1\n").digest("hex"));

      await expect(
        service.readIgnoredFile(
          { projectId: PROJECT_ID, relativePath: "README.md" },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      await expect(
        service.readIgnoredFile(
          { projectId: PROJECT_ID, relativePath: "secret-link" },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      await expect(
        service.readIgnoredFile(
          { projectId: PROJECT_ID, relativePath: ".git/config" },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    } finally {
      service.close();
    }
  });

  it("clones into a clean destination folder, issues a binding receipt, and lands only chosen ignored files with mode & 0o777", async () => {
    const homeDir = makeTempDir("octant-dest-home-");
    const receiptStore = new BindingReceiptStore();
    const runner: RepositoryBootstrapCloneRunner = {
      clone: async ({ stagingPath, onProgress }) => {
        onProgress("Receiving objects: 100%");
        mkdirSync(stagingPath, { recursive: true });
        initGitRepo(stagingPath, "git@github.com:org/demo.git");
        return { kind: "completed" };
      },
      verifyNonBareCheckout: async () => true,
      close: () => undefined,
    };

    const service = new RepositoryBootstrapService({
      readProject: () => undefined,
      bindingReceiptStore: receiptStore,
      projectRootPort: new ProjectRootPort(),
      homeDir,
      cloneRunner: runner,
    });

    const operationId = decodeRepositoryBootstrapOperationId(
      "55555555-5555-4555-8555-555555555555",
    );

    try {
      await service.startClone(WINDOW_ID, {
        operationId,
        remoteUrl: "git@github.com:org/demo.git",
        transport: "ssh",
        destinationPath: "~/demo",
      });

      // Wait briefly for the fake async clone runner to settle.
      let status = service.cloneStatus(WINDOW_ID, { operationId }).operation;
      for (let attempt = 0; attempt < 20 && status.state === "cloning"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = service.cloneStatus(WINDOW_ID, { operationId }).operation;
      }

      expect(status.state).toBe("cloned");
      if (status.state !== "cloned") throw new Error("Expected cloned state");
      expect(status.projectName).toBe("demo");

      // Receipt is bound to the exact caller window and canonical clone root.
      const consumed = receiptStore.consume({
        receiptId: status.receiptId,
        authenticatedWindowId: WINDOW_ID,
        projectType: "code",
        now: Date.now(),
      });
      expect(consumed.canonicalRoot).toBe(status.canonicalDestination);

      // Cross-window status read is refused.
      expect(() => service.cloneStatus(OTHER_WINDOW_ID, { operationId })).toThrow();

      // Land one valid file plus several forbidden payloads (symlink escape, .., .git/config, bad hash).
      const outsideDir = makeTempDir("octant-symlink-target-");
      symlinkSync(outsideDir, join(status.canonicalDestination, "escape-dir"));

      const envBytes = Buffer.from("TOKEN=abc\n", "utf8");
      const envSha = createHash("sha256").update(envBytes).digest("hex");

      const landed = await service.landFiles(WINDOW_ID, {
        operationId,
        files: [
          {
            relativePath: "apps/web/.env.local",
            bytes: envBytes.byteLength,
            sha256: envSha,
            mode: 0o600,
            contentBase64: envBytes.toString("base64"),
          },
          {
            relativePath: "escape-dir/.env",
            bytes: envBytes.byteLength,
            sha256: envSha,
            mode: 0o600,
            contentBase64: envBytes.toString("base64"),
          },
          {
            relativePath: "../escape.env",
            bytes: envBytes.byteLength,
            sha256: envSha,
            mode: 0o600,
            contentBase64: envBytes.toString("base64"),
          },
          {
            relativePath: ".git/config",
            bytes: envBytes.byteLength,
            sha256: envSha,
            mode: 0o600,
            contentBase64: envBytes.toString("base64"),
          },
          {
            relativePath: "bad-hash.env",
            bytes: envBytes.byteLength,
            sha256: "0".repeat(64),
            mode: 0o600,
            contentBase64: envBytes.toString("base64"),
          },
        ],
      });

      expect(landed.status).toBe("partial-copy");
      expect(landed.landed).toEqual(["apps/web/.env.local"]);
      expect(landed.failed.map((item) => [item.relativePath, item.reason])).toEqual([
        ["escape-dir/.env", "symlink-refused"],
        ["../escape.env", "invalid-path"],
        [".git/config", "git-internal-refused"],
        ["bad-hash.env", "hash-mismatch"],
      ]);

      const landedPath = join(status.canonicalDestination, "apps", "web", ".env.local");
      expect(readFileSync(landedPath, "utf8")).toBe("TOKEN=abc\n");
      expect(statSync(landedPath).mode & 0o777).toBe(0o600);
    } finally {
      service.close();
    }
  });

  it("refuses unsafe clone URLs and existing non-empty destination folders", async () => {
    const homeDir = makeTempDir("octant-dest-refuse-");
    mkdirSync(join(homeDir, "occupied"), { recursive: true });
    writeFileSync(join(homeDir, "occupied", "file.txt"), "existing");

    const service = new RepositoryBootstrapService({
      readProject: () => undefined,
      bindingReceiptStore: new BindingReceiptStore(),
      projectRootPort: new ProjectRootPort(),
      homeDir,
    });

    try {
      await expect(
        service.startClone(WINDOW_ID, {
          operationId: decodeRepositoryBootstrapOperationId("66666666-6666-4666-8666-666666666666"),
          remoteUrl: "file:///tmp/repo",
          transport: "https",
          destinationPath: "~/clean",
        }),
      ).rejects.toMatchObject({ failure: { code: "invalid-url" } });

      await expect(
        service.startClone(WINDOW_ID, {
          operationId: decodeRepositoryBootstrapOperationId("77777777-7777-4777-8777-777777777777"),
          remoteUrl: "-oProxyCommand=id",
          transport: "ssh",
          destinationPath: "~/clean",
        }),
      ).rejects.toMatchObject({ failure: { code: "invalid-url" } });

      await expect(
        service.startClone(WINDOW_ID, {
          operationId: decodeRepositoryBootstrapOperationId("88888888-8888-4888-8888-888888888888"),
          remoteUrl: "git@github.com:org/demo.git",
          transport: "ssh",
          destinationPath: "~/occupied",
        }),
      ).rejects.toMatchObject({ failure: { code: "destination-not-empty" } });
    } finally {
      service.close();
    }
  });

  it("builds fail-closed non-interactive SSH and HTTPS git clone arguments and environments", () => {
    const context = {
      root: "/tmp/git",
      templateDir: "/tmp/git/template",
      hooksDir: "/tmp/git/hooks",
      sshConfigPath: "/tmp/git/gitconfig-ssh",
    };

    const sshEnv = buildBootstrapCloneEnvironment(
      { PATH: "/usr/bin", HOME: "/home/dev", SSH_AUTH_SOCK: "/tmp/agent.sock", SECRET_TOKEN: "no" },
      context,
      "ssh",
    );
    expect(sshEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(sshEnv.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(sshEnv.GIT_ALLOW_PROTOCOL).toBe("ssh");
    expect(sshEnv.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -o StrictHostKeyChecking=yes");
    expect(sshEnv.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(sshEnv.SECRET_TOKEN).toBeUndefined();

    const httpsEnv = buildBootstrapCloneEnvironment(
      { PATH: "/usr/bin", HOME: "/home/dev", SSH_AUTH_SOCK: "/tmp/agent.sock" },
      context,
      "https",
    );
    expect(httpsEnv.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(httpsEnv.GIT_SSH_COMMAND).toBeUndefined();
    expect(httpsEnv.SSH_AUTH_SOCK).toBeUndefined();

    const args = buildBootstrapCloneArgs({
      remoteUrl: "git@github.com:org/demo.git",
      transport: "ssh",
      stagingPath: "/tmp/stage",
      hooksDir: context.hooksDir,
      templateDir: context.templateDir,
    });
    expect(args).toContain("core.hooksPath=/tmp/git/hooks");
    expect(args).toContain("protocol.allow=never");
    expect(args).toContain("protocol.ssh.allow=always");
    expect(args.slice(-3)).toEqual(["--", "git@github.com:org/demo.git", "/tmp/stage"]);
  });
});
