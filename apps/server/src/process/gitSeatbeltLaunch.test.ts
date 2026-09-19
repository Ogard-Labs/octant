import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitGlobalConfigReadRoots,
  gitLinkedWorktreeMetadataRules,
  gitShimExtraRules,
  MACOS_GIT_SHIM_READ_PATHS,
  prepareGitSeatbeltLaunch,
  resolveGitExecutable,
} from "./gitSeatbeltLaunch";
import { makeSeatbeltConfinementLive, type SeatbeltConfinementPort } from "./seatbeltProfile";

describe("git Seatbelt launch", () => {
  it("lets confined git read the user's global config alongside the checkout", () => {
    let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
    const confinement: SeatbeltConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: "/usr/bin/sandbox-exec", args: [] };
      },
    };
    prepareGitSeatbeltLaunch({
      confinement,
      gitExecutable: "/opt/toolchain/usr/bin/git",
      checkoutRoot: "/repo",
      args: ["status"],
      temporaryDirectory: "/tmp",
      networkEgress: "allow",
    });
    const roots = captured?.readRoots ?? [];
    for (const root of gitGlobalConfigReadRoots()) expect(roots).toContain(root);
    expect(roots).toContain("/repo");
    expect(roots).toContain("/opt/toolchain/usr/bin");
  });

  it("exposes a write root under a shared temporary directory to a Linux launch", () => {
    // Bubblewrap replaces a shared host temp root with a private tmpfs rather
    // than binding it, so a directory created under /tmp is invisible to the
    // confined process until the launch names it. Mounts are emitted
    // shallowest first, which is what puts the bind inside that tmpfs.
    const directory = mkdtempSync(join(tmpdir(), "octant-write-root-"));
    const bwrap = join(directory, "bwrap");
    writeFileSync(bwrap, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
    chmodSync(bwrap, 0o700);
    const quarantine = join(directory, "quarantine");
    mkdirSync(quarantine);
    try {
      const launch = prepareGitSeatbeltLaunch({
        confinement: makeSeatbeltConfinementLive({ platform: "linux", sandboxPath: bwrap }),
        gitExecutable: "/usr/bin/git",
        checkoutRoot: directory,
        args: ["-C", directory, "merge-tree", "--write-tree", "HEAD", "HEAD"],
        temporaryDirectory: tmpdir(),
        networkEgress: "none",
        additionalWriteRoots: [quarantine],
      });
      const bind = launch.args.findIndex(
        (argument, index) =>
          argument === "--bind" && launch.args[index + 2] === realpathSync(quarantine),
      );
      const tmpfs = launch.args.findIndex(
        (argument, index) => argument === "--tmpfs" && launch.args[index + 1] === tmpdir(),
      );
      expect(bind).toBeGreaterThan(-1);
      expect(tmpfs).toBeGreaterThan(-1);
      expect(bind).toBeGreaterThan(tmpfs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("appends the xcode-select shim literals after the rest of the profile", () => {
    expect(gitShimExtraRules("darwin")).toEqual(
      MACOS_GIT_SHIM_READ_PATHS.map((path) => `(allow file-read* (literal "${path}"))`),
    );
    expect(gitShimExtraRules("linux")).toEqual([]);
    if (process.platform !== "darwin") return;
    let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
    const confinement: SeatbeltConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: "/usr/bin/sandbox-exec", args: [] };
      },
    };
    prepareGitSeatbeltLaunch({
      confinement,
      gitExecutable: "/opt/toolchain/usr/bin/git",
      checkoutRoot: "/repo",
      args: ["status"],
      temporaryDirectory: "/tmp",
      networkEgress: "allow",
    });
    for (const path of MACOS_GIT_SHIM_READ_PATHS) {
      expect(captured?.extraRules).toContain(`(allow file-read* (literal "${path}"))`);
    }
  });

  it("allows a linked worktree's gitdir and commondir outside the bound root", () => {
    expect(gitLinkedWorktreeMetadataRules("/does-not-exist")).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), "octant-git-worktree-"));
    try {
      const worktree = join(root, "worktree");
      const gitdir = join(root, "main.git", "worktrees", "feature");
      const common = join(root, "main.git");
      mkdirSync(worktree);
      mkdirSync(gitdir, { recursive: true });
      writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
      writeFileSync(join(gitdir, "commondir"), `${common}\n`);
      const rules = gitLinkedWorktreeMetadataRules(worktree);
      expect(rules.some((rule) => rule.includes(gitdir))).toBe(true);
      expect(rules.some((rule) => rule.includes(common))).toBe(true);
      // Git canonicalises the out-of-root metadata by walking its
      // components, so every ancestor needs metadata of its own — and only
      // metadata: the worktree root's contents stay unreadable.
      expect(rules).toContain(`(allow file-read-metadata (literal "${root}"))`);
      // These rules are appended last and Seatbelt resolves by last matching
      // rule, so a write allow here would override a read-only caller's own
      // write deny on the same path. Observing history must not come with
      // write authority over the parent repository's refs, objects and hooks.
      expect(rules.some((rule) => rule.includes("file-write"))).toBe(false);
      expect(gitLinkedWorktreeMetadataRules(worktree, { writable: true })).toContain(
        `(allow file-write* (subpath "${common}"))`,
      );

      // The launch itself defaults to read-only. These rules are appended
      // last, so a caller that simply forgets the option is confined rather
      // than silently handed write on another repository's .git.
      let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
      prepareGitSeatbeltLaunch({
        confinement: {
          prepare: (input) => {
            captured = input;
            return { command: "/usr/bin/sandbox-exec", args: [] };
          },
        },
        gitExecutable: "/usr/bin/git",
        checkoutRoot: worktree,
        args: ["status"],
        temporaryDirectory: "/tmp",
        networkEgress: "none",
      });
      expect((captured?.extraRules ?? []).some((rule) => rule.includes("file-write"))).toBe(false);
      expect(rules).not.toContain(`(allow file-read* (subpath "${root}"))`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries the worktree's ancestors into the final Darwin profile", () => {
    const root = mkdtempSync(join(tmpdir(), "octant-git-worktree-profile-"));
    try {
      const worktree = join(root, "worktree");
      const gitdir = join(root, "main.git", "worktrees", "feature");
      const sandboxPath = join(root, "sandbox-exec");
      mkdirSync(worktree);
      mkdirSync(gitdir, { recursive: true });
      mkdirSync(join(root, "tmp"));
      writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
      writeFileSync(join(gitdir, "commondir"), `${join(root, "main.git")}\n`);
      writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });
      chmodSync(sandboxPath, 0o700);

      // The rules have to survive composition into the profile the process is
      // actually launched with, not only the helper that builds them: a
      // regression that drops extraRules would still pass the helper's own
      // assertions while confined git dies on its first path.
      const launch = prepareGitSeatbeltLaunch({
        confinement: makeSeatbeltConfinementLive({
          platform: "darwin",
          sandboxPath,
          homeDirectory: root,
          usersDirectory: root,
        }),
        gitExecutable: "/opt/toolchain/usr/bin/git",
        checkoutRoot: worktree,
        args: ["-C", worktree, "status", "--short"],
        temporaryDirectory: join(root, "tmp"),
        networkEgress: "none",
      });

      const profile = launch.args[1] ?? "";
      expect(profile).toContain(`(allow file-read-metadata (literal "${root}"))`);
      expect(profile).not.toContain(`(allow file-read* (subpath "${root}"))`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives global config roots from the home and XDG config directories", () => {
    const readConfig = () => undefined;
    expect(gitGlobalConfigReadRoots({ home: "/Users/example", env: {}, readConfig })).toEqual([
      "/Users/example/.gitconfig",
      "/Users/example/.config/git",
    ]);
    expect(
      gitGlobalConfigReadRoots({
        home: "/Users/example",
        env: { XDG_CONFIG_HOME: "/Users/example/xdg" },
        readConfig,
      }),
    ).toEqual(["/Users/example/.gitconfig", "/Users/example/xdg/git"]);
  });

  it("follows include and includeIf paths from the global config to a bounded depth", () => {
    const files = new Map<string, string>([
      [
        "/Users/example/.gitconfig",
        '[user]\n\tname = Example\n[include]\n\tpath = ~/.gitconfig.local\n\tpath = "relative/extra"\n[includeIf "gitdir:~/Dev/"]\n\tpath = /Users/example/Dev/.gitconfig-dev\n[alias]\n\tpath = not-an-include\n',
      ],
      [
        "/Users/example/.gitconfig.local",
        "[include]\n\tpath = ~/.gitconfig\n\tpath = ~/.gitconfig.work\n",
      ],
      ["/Users/example/.gitconfig.work", "[include]\n\tpath = ~/.gitconfig.local\n"],
    ]);
    expect(
      gitGlobalConfigReadRoots({
        home: "/Users/example",
        env: {},
        readConfig: (path) => files.get(path),
      }),
    ).toEqual([
      "/Users/example/.gitconfig",
      "/Users/example/.config/git",
      "/Users/example/.gitconfig.local",
      "/Users/example/.gitconfig.work",
      "/Users/example/relative/extra",
      "/Users/example/Dev/.gitconfig-dev",
    ]);
  });

  it("keeps an explicit executable and uses the plain system git off macOS", () => {
    expect(resolveGitExecutable("/custom/git", "darwin")).toBe("/custom/git");
    expect(resolveGitExecutable(undefined, "linux")).toBe("/usr/bin/git");
    expect(() => resolveGitExecutable("git", "darwin")).toThrow(/absolute/);
  });
});
