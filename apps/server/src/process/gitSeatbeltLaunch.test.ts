import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitLinkedWorktreeMetadataPaths,
  gitLinkedWorktreeMetadataRules,
  gitShimExtraRules,
  MACOS_GIT_SHIM_READ_PATHS,
  prepareGitSeatbeltLaunch,
  resolveGitExecutable,
} from "./gitSeatbeltLaunch";
import { makeProcessConfinementLive, type ProcessConfinementPort } from "./seatbeltProfile";

/** Runs just after the host first looks at a path, so a test can swap it for a link then. */
const looked = vi.hoisted(() => ({ at: (_path: string): void => undefined }));
/** Runs just before the host resolves a path, so a test can swap another path then. */
const resolving = vi.hoisted(() => ({ before: (_path: string): void => undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const after =
    <Args extends ReadonlyArray<unknown>, Result>(read: (...args: Args) => Result) =>
    (...args: Args): Result => {
      const result = read(...args);
      looked.at(String(args[0]));
      return result;
    };
  return {
    ...actual,
    lstatSync: after(actual.lstatSync),
    openSync: after(actual.openSync),
    readFileSync: after(actual.readFileSync),
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      resolving.before(String(args[0]));
      return actual.realpathSync(...args);
    },
  };
});
afterEach(() => {
  looked.at = () => undefined;
  resolving.before = () => undefined;
});

/** A linked worktree record as Git writes it, with the marker and its reciprocal gitdir. */
function linkedWorktree(base: string, name: string) {
  const checkout = join(base, `${name}-checkout`);
  const common = join(base, `${name}-repository`, ".git");
  const gitdir = join(common, "worktrees", name);
  mkdirSync(checkout, { recursive: true });
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(checkout, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, "gitdir"), `${join(checkout, ".git")}\n`);
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  return { checkout, common, gitdir };
}

describe("git Seatbelt launch", () => {
  it("grants confined git no read reach into the user's global config", () => {
    let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    const confinement: ProcessConfinementPort = {
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
        confinement: makeProcessConfinementLive({ platform: "linux", sandboxPath: bwrap }),
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
    const prepared: Parameters<ProcessConfinementPort["prepare"]>[0][] = [];
    const confinement: ProcessConfinementPort = {
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
      writeFileSync(join(gitdir, "gitdir"), `${join(worktree, ".git")}\n`);
      writeFileSync(join(gitdir, "commondir"), `${common}\n`);
      const rules = gitLinkedWorktreeMetadataRules(worktree);
      expect(rules.some((rule) => rule.includes(realpathSync(gitdir)))).toBe(true);
      expect(rules.some((rule) => rule.includes(realpathSync(common)))).toBe(true);
      // Git canonicalises the out-of-root metadata by walking its
      // components, so every ancestor needs metadata of its own — and only
      // metadata: the worktree root's contents stay unreadable.
      expect(rules).toContain(`(allow file-read-metadata (literal "${realpathSync(root)}"))`);
      // These rules are appended last and Seatbelt resolves by last matching
      // rule, so a write allow here would override a read-only caller's own
      // write deny on the same path. Observing history must not come with
      // write authority over the parent repository's refs, objects and hooks.
      expect(rules.some((rule) => rule.includes("file-write"))).toBe(false);
      expect(gitLinkedWorktreeMetadataRules(worktree, { writable: true })).toContain(
        `(allow file-write* (subpath "${realpathSync(common)}"))`,
      );

      // The launch itself defaults to read-only. These rules are appended
      // last, so a caller that simply forgets the option is confined rather
      // than silently handed write on another repository's .git.
      let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
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
      expect(rules).not.toContain(`(allow file-read* (subpath "${realpathSync(root)}"))`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grants nothing when a rewritten marker fails to prove the reciprocal worktree record", () => {
    const root = mkdtempSync(join(tmpdir(), "octant-git-forged-"));
    try {
      const worktree = join(root, "worktree");
      const outside = join(root, "outside");
      mkdirSync(worktree);
      mkdirSync(outside);
      // A marker can name any existing directory; none of these is the
      // reciprocal record Git writes for a linked worktree, so confinement
      // must never bind them.
      const attempts = [
        () => writeFileSync(join(worktree, ".git"), `gitdir: ${outside}\n`),
        () => {
          const gitdir = join(root, "main.git", "worktrees", "feature");
          mkdirSync(gitdir, { recursive: true });
          writeFileSync(join(gitdir, "commondir"), `${join(root, "main.git")}\n`);
          writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
        },
        () => {
          const gitdir = join(root, "main.git", "worktrees", "feature");
          writeFileSync(join(gitdir, "gitdir"), `${join(worktree, ".git")}\n`);
          writeFileSync(join(gitdir, "commondir"), `${outside}\n`);
          writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
        },
      ];
      for (const attempt of attempts) {
        attempt();
        expect(gitLinkedWorktreeMetadataPaths(worktree)).toEqual({
          readPaths: [],
          writePaths: [],
        });
        expect(gitLinkedWorktreeMetadataPaths(worktree, { writable: true })).toEqual({
          readPaths: [],
          writePaths: [],
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The marker sits in the agent-writable checkout. It passed the first look as
  // a regular file, was then swapped for a link to another repository's
  // linked-worktree marker, and the pointer read and the reciprocity check both
  // followed the link, so a mutation launch got write access to that
  // repository's refs, objects, and hooks.
  it("never grants another repository's metadata when the marker is swapped for a link after the first look", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-git-marker-swap-")));
    try {
      const own = linkedWorktree(base, "own");
      const host = linkedWorktree(base, "host");
      const marker = join(own.checkout, ".git");
      let swapped = false;
      looked.at = (path) => {
        if (swapped || path !== marker) return;
        swapped = true;
        renameSync(marker, join(own.checkout, ".git-real"));
        symlinkSync(join(host.checkout, ".git"), marker);
      };
      const granted = gitLinkedWorktreeMetadataPaths(own.checkout, { writable: true });
      expect(granted.readPaths).not.toContain(host.common);
      expect(granted.writePaths).not.toContain(host.common);
      expect(granted.writePaths).not.toContain(host.gitdir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // The agent writes the marker, so it can name another repository's
  // linked-worktree record outright; that record's backlink names the other
  // checkout's marker. Resolving this marker again for the reciprocity check,
  // after it was read and then swapped for a link to that other marker, made
  // the two sides agree and granted that repository writable.
  it("never grants another repository's metadata when the marker names it and is swapped for a link after being read", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-git-marker-named-")));
    try {
      const own = linkedWorktree(base, "own");
      const host = linkedWorktree(base, "host");
      const marker = join(own.checkout, ".git");
      writeFileSync(marker, `gitdir: ${host.gitdir}\n`);
      let swapped = false;
      resolving.before = (path) => {
        if (swapped || path !== host.gitdir) return;
        swapped = true;
        renameSync(marker, join(own.checkout, ".git-real"));
        symlinkSync(join(host.checkout, ".git"), marker);
      };
      const granted = gitLinkedWorktreeMetadataPaths(own.checkout, { writable: true });
      expect(swapped).toBe(true);
      expect(granted).toEqual({ readPaths: [], writePaths: [] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("binds a linked worktree's out-of-root metadata instead of writing Seatbelt rules on Linux", () => {
    const root = mkdtempSync(join(tmpdir(), "octant-git-worktree-linux-"));
    try {
      const worktree = join(root, "worktree");
      const gitdir = join(root, "main.git", "worktrees", "feature");
      const common = join(root, "main.git");
      mkdirSync(worktree);
      mkdirSync(gitdir, { recursive: true });
      writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
      writeFileSync(join(gitdir, "gitdir"), `${join(worktree, ".git")}\n`);
      writeFileSync(join(gitdir, "commondir"), `${common}\n`);

      for (const writable of [false, true]) {
        let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
        prepareGitSeatbeltLaunch({
          confinement: {
            prepare: (input) => {
              captured = input;
              return { command: "/usr/bin/bwrap", args: [] };
            },
          },
          platform: "linux",
          gitExecutable: "/usr/bin/git",
          checkoutRoot: worktree,
          args: ["status"],
          temporaryDirectory: "/tmp",
          networkEgress: "none",
          writable,
        });
        // The Linux backend refuses any rule it cannot express; the same
        // authority is carried as binds, which is also what lets a linked
        // worktree's history read run there at all.
        expect(captured?.extraRules).toBeUndefined();
        expect(captured?.readRoots).toContain(realpathSync(gitdir));
        expect(captured?.readRoots).toContain(realpathSync(common));
        if (writable) {
          expect(captured?.additionalWriteRoots).toContain(realpathSync(gitdir));
          expect(captured?.additionalWriteRoots).toContain(realpathSync(common));
        } else {
          expect(captured?.additionalWriteRoots ?? []).not.toContain(realpathSync(gitdir));
        }
      }
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
      writeFileSync(join(gitdir, "gitdir"), `${join(worktree, ".git")}\n`);
      writeFileSync(join(gitdir, "commondir"), `${join(root, "main.git")}\n`);
      writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });
      chmodSync(sandboxPath, 0o700);

      // The rules have to survive composition into the profile the process is
      // actually launched with, not only the helper that builds them: a
      // regression that drops extraRules would still pass the helper's own
      // assertions while confined git dies on its first path.
      const launch = prepareGitSeatbeltLaunch({
        confinement: makeProcessConfinementLive({
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
      expect(profile).toContain(`(allow file-read-metadata (literal "${realpathSync(root)}"))`);
      expect(profile).not.toContain(`(allow file-read* (subpath "${realpathSync(root)}"))`);
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
