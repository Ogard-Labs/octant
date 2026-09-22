import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitLinkedWorktreeMetadataRules,
  gitShimExtraRules,
  MACOS_GIT_SHIM_READ_PATHS,
  prepareGitSeatbeltLaunch,
  resolveGitExecutable,
} from "./gitSeatbeltLaunch";
import { makeSeatbeltConfinementLive, type SeatbeltConfinementPort } from "./seatbeltProfile";

describe("git Seatbelt launch", () => {
  it("grants confined git no read reach into the user's global config", () => {
    let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
    const confinement: SeatbeltConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: "/usr/bin/sandbox-exec", args: [] };
      },
    };
    prepareGitSeatbeltLaunch({
      confinement,
      platform: "darwin",
      gitExecutable: "/opt/toolchain/usr/bin/git",
      checkoutRoot: "/repo",
      args: ["status"],
      temporaryDirectory: "/tmp",
      networkEgress: "allow",
    });
    const roots = captured?.readRoots ?? [];
    // Every confined launch runs GIT_CONFIG_GLOBAL=/dev/null and
    // GIT_CONFIG_NOSYSTEM=1, so nothing opens these paths and the allowance
    // would be reach the profile carries for no reader.
    for (const root of [join(homedir(), ".gitconfig"), join(homedir(), ".config/git")]) {
      expect(roots).not.toContain(root);
    }
    expect(roots).toContain("/repo");
    expect(roots).toContain("/opt/toolchain/usr/bin");
  });

  it("exposes a write root under a shared temporary directory to a Linux launch", () => {
    // Bubblewrap replaces a shared host temp root with a private tmpfs rather
    // than binding it, so a directory created under /tmp is invisible to the
    // confined process until the launch names it. Mounts are emitted
    // shallowest first, which is what puts the bind inside that tmpfs.
    //
    // The fixture lives under /tmp rather than os.tmpdir() because only /tmp
    // and /var/tmp take that replacement. On macOS os.tmpdir() is a
    // per-user directory under /var/folders, which is bound like any other
    // write root, so a fixture there would never reach the branch this test
    // is about.
    const sharedTemporaryRoot = "/tmp";
    const directory = mkdtempSync(join(sharedTemporaryRoot, "octant-write-root-"));
    const bwrap = join(directory, "bwrap");
    writeFileSync(bwrap, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
    chmodSync(bwrap, 0o700);
    const quarantine = join(directory, "quarantine");
    mkdirSync(quarantine);
    try {
      const launch = prepareGitSeatbeltLaunch({
        confinement: makeSeatbeltConfinementLive({ platform: "linux", sandboxPath: bwrap }),
        platform: "linux",
        gitExecutable: "/usr/bin/git",
        checkoutRoot: directory,
        args: ["-C", directory, "merge-tree", "--write-tree", "HEAD", "HEAD"],
        temporaryDirectory: sharedTemporaryRoot,
        networkEgress: "none",
        additionalWriteRoots: [quarantine],
      });
      // A bind's target is the path the launch named, which is what the
      // confined process sees; only its source is canonicalized for the host.
      const bind = launch.args.findIndex(
        (argument, index) => argument === "--bind" && launch.args[index + 2] === quarantine,
      );
      const tmpfs = launch.args.findIndex(
        (argument, index) =>
          argument === "--tmpfs" && launch.args[index + 1] === sharedTemporaryRoot,
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
    const prepared: Parameters<SeatbeltConfinementPort["prepare"]>[0][] = [];
    const confinement: SeatbeltConfinementPort = {
      prepare: (input) => {
        prepared.push(input);
        return { command: "/usr/bin/sandbox-exec", args: [] };
      },
    };
    const launch = {
      confinement,
      gitExecutable: "/opt/toolchain/usr/bin/git",
      checkoutRoot: "/repo",
      args: ["status"],
      temporaryDirectory: "/tmp",
      networkEgress: "allow",
    } as const;
    prepareGitSeatbeltLaunch({ ...launch, platform: "darwin" });
    prepareGitSeatbeltLaunch({ ...launch, platform: "linux" });
    for (const path of MACOS_GIT_SHIM_READ_PATHS) {
      expect(prepared[0]?.extraRules).toContain(`(allow file-read* (literal "${path}"))`);
    }
    // These literals are Seatbelt, and Bubblewrap refuses any rule it cannot
    // express. The shape follows the platform the launch is confined for, not
    // the platform this process runs on: otherwise an ordinary checkout
    // prepared for Linux from a macOS host is refused before it runs.
    expect(prepared[1]?.extraRules).toBeUndefined();
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
        platform: "darwin",
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
        platform: "darwin",
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

  it("keeps an explicit executable and uses the plain system git off macOS", () => {
    expect(resolveGitExecutable("/custom/git", "darwin")).toBe("/custom/git");
    expect(resolveGitExecutable(undefined, "linux")).toBe("/usr/bin/git");
    expect(() => resolveGitExecutable("git", "darwin")).toThrow(/absolute/);
  });
});
