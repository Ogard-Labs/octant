import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SeatbeltConfinementError,
  buildDenyDefaultSeatbeltProfile,
  escapeSeatbeltPath,
  makeSeatbeltConfinementLive,
  privateHomeDenyReadRules,
  requireSandboxExec,
  seatbeltAllowRule,
  seatbeltExecRule,
  seatbeltDenyRule,
  wrapCommandInSandboxExec,
} from "./seatbeltProfile";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-seatbelt-")));
  directories.push(directory);
  return directory;
}

describe("shared Seatbelt profile builder", () => {
  it("builds a deny-default profile with exactly one bound root write plus private temp", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    const homeSibling = join(root, "home-sibling");
    mkdirSync(homeSibling);

    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot,
      temporaryDirectory,
      readRoots: [boundRoot, temporaryDirectory],
      networkEgress: "none",
      privateHomeAllowPaths: [boundRoot, temporaryDirectory],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-exec)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain("(allow signal (target self))");
    expect(profile).toContain("(allow sysctl-read)");
    expect(profile).not.toContain("(allow network*)");
    expect(profile).toContain(seatbeltAllowRule("file-write*", boundRoot));
    expect(profile).toContain(seatbeltAllowRule("file-write*", temporaryDirectory));
    expect(profile).toContain(seatbeltAllowRule("file-read*", boundRoot));
    expect(profile).toContain('(allow file-write-data (literal "/dev/null"))');
    expect(profile).toContain(seatbeltDenyRule("file-read*", homeSibling));
    expect(profile.split(seatbeltAllowRule("file-write*", boundRoot)).length - 1).toBe(1);
  });

  it("includes network* only when OS egress materializes to allow", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);

    const denied = buildDenyDefaultSeatbeltProfile({
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
      privateHomeAllowPaths: [boundRoot, temporaryDirectory],
      homeDirectory: root,
      usersDirectory: root,
    });
    const allowed = buildDenyDefaultSeatbeltProfile({
      boundRoot,
      temporaryDirectory,
      networkEgress: "allow",
      privateHomeAllowPaths: [boundRoot, temporaryDirectory],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(denied).not.toContain("(allow network*)");
    expect(allowed).toContain("(allow network*)");
  });

  it("denies sensitive system reads even for toolchain profiles with network egress", () => {
    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: "/private/tmp/octant-project",
      temporaryDirectory: "/private/tmp/octant-temporary",
      networkEgress: "allow",
      allowFileReadStar: true,
      readRoots: ["/private/tmp/octant-project", "/private/tmp/octant-temporary"],
      privateHomeAllowPaths: [],
    });

    for (const path of ["/etc/ssh", "/var/root", "/Library/Keychains", "/private"]) {
      expect(profile).toContain(seatbeltDenyRule("file-read*", path));
    }
    expect(profile).toContain("(allow network*)");

    // The broad /private deny must not make a legitimate exact bound root
    // unreadable; the later allow is the narrow exception for this launch.
    expect(profile.indexOf(seatbeltDenyRule("file-read*", "/private"))).toBeLessThan(
      profile.indexOf(seatbeltAllowRule("file-read*", "/private/tmp/octant-project")),
    );
  });

  it("keeps a toolchain launch able to read its own roots without restating them", () => {
    // The broad-read escape hatch exists for runtimes like Git and provider
    // CLIs. macOS resolves the temporary directory beneath `/private`, so a
    // launch that did not repeat its roots in `readRoots` lost the one
    // directory every one of those runtimes writes through.
    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: "/private/tmp/octant-project",
      temporaryDirectory: "/private/tmp/octant-temporary",
      additionalWriteRoots: ["/private/tmp/octant-provider-home"],
      networkEgress: "none",
      allowFileReadStar: true,
      privateHomeAllowPaths: [],
    });

    // Assert the deny rule is actually present before comparing indexOf
    // positions below: indexOf returns -1 for a missing rule, which is
    // smaller than any real match position, so the ordering check would
    // pass vacuously if this deny rule were ever dropped from the profile.
    expect(profile).toContain(seatbeltDenyRule("file-read*", "/private"));

    for (const path of [
      "/private/tmp/octant-project",
      "/private/tmp/octant-temporary",
      "/private/tmp/octant-provider-home",
    ]) {
      expect(profile).toContain(seatbeltAllowRule("file-read*", path));
      expect(profile.indexOf(seatbeltDenyRule("file-read*", "/private"))).toBeLessThan(
        profile.indexOf(seatbeltAllowRule("file-read*", path)),
      );
    }
  });

  it("denies the sensitive paths no matter what a caller asks for", () => {
    // The boundary is the product's, not the caller's: a launch that could
    // replace it would pair an empty list with the broad read rule and reach
    // the Keychain.
    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: "/private/tmp/octant-project",
      temporaryDirectory: "/private/tmp/octant-temporary",
      networkEgress: "none",
      allowFileReadStar: true,
      additionalDenyReadPaths: ["/private/tmp/octant-sibling"],
      privateHomeAllowPaths: [],
    });

    for (const path of ["/Volumes", "/Network", "/etc/ssh", "/var/root", "/Library/Keychains"]) {
      expect(profile).toContain(seatbeltDenyRule("file-read*", path));
    }
    expect(profile).toContain(seatbeltDenyRule("file-read*", "/private/tmp/octant-sibling"));
  });

  it("refuses a launch root that is an ancestor of a denied sensitive path", () => {
    // Seatbelt is last-match-wins: the launch-root allow rules are emitted
    // after the DEFAULT_DENY_READ_PATHS deny rules (see the comment above
    // that block), so an allow subpath at or above a denied path would win
    // and reopen the whole denied subtree, including /Library/Keychains.
    expect(() =>
      buildDenyDefaultSeatbeltProfile({
        boundRoot: "/Library",
        temporaryDirectory: "/private/tmp/octant-temporary",
        networkEgress: "none",
        privateHomeAllowPaths: [],
      }),
    ).toThrow(SeatbeltConfinementError);
  });

  it("refuses a launch root equal to a denied sensitive path", () => {
    expect(() =>
      buildDenyDefaultSeatbeltProfile({
        boundRoot: "/private/tmp/octant-project",
        temporaryDirectory: "/private",
        networkEgress: "none",
        privateHomeAllowPaths: [],
      }),
    ).toThrow(SeatbeltConfinementError);
  });

  it("still allows a launch root that is a descendant of a denied sensitive path", () => {
    // The temporary directory always resolves under /private/var, so a
    // descendant of a denied path must remain reachable even though the
    // ancestor itself is refused.
    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: "/private/tmp/octant-project",
      temporaryDirectory: "/private/tmp/octant-temporary",
      networkEgress: "none",
      privateHomeAllowPaths: [],
    });
    expect(profile).toContain(seatbeltAllowRule("file-read*", "/private/tmp/octant-project"));
  });

  it("escapes Seatbelt path literals", () => {
    expect(escapeSeatbeltPath('/tmp/weird"path\\here')).toBe('/tmp/weird\\"path\\\\here');
    expect(seatbeltAllowRule("file-read*", '/tmp/x"y')).toBe(
      '(allow file-read* (subpath "/tmp/x\\"y"))',
    );
    expect(seatbeltDenyRule("file-write*", "/tmp/z")).toBe('(deny file-write* (subpath "/tmp/z"))');
  });

  it("enumerates deny rules for the remainder of the user home", () => {
    const root = temporaryRoot();
    const allowed = join(root, "allowed");
    const denied = join(root, "denied");
    mkdirSync(allowed);
    mkdirSync(denied);

    const rules = privateHomeDenyReadRules({
      allowedPaths: [allowed],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(rules).toContain(seatbeltDenyRule("file-read*", denied));
    expect(rules).not.toContain(seatbeltDenyRule("file-read*", allowed));
  });

  it("wraps a command with sandbox-exec -p profile --", () => {
    const launch = wrapCommandInSandboxExec({
      sandboxPath: "/usr/bin/sandbox-exec",
      profile: "(version 1)\n(deny default)\n",
      executable: "/usr/bin/git",
      args: ["status"],
    });
    expect(launch).toEqual({
      command: "/usr/bin/sandbox-exec",
      args: ["-p", "(version 1)\n(deny default)\n", "--", "/usr/bin/git", "status"],
    });
  });

  it("fails closed when sandbox-exec is missing or not executable", () => {
    const root = temporaryRoot();
    const missing = join(root, "missing-sandbox-exec");
    expect(() => requireSandboxExec({ platform: "darwin", sandboxPath: missing })).toThrow(
      SeatbeltConfinementError,
    );
    expect(() =>
      requireSandboxExec({ platform: "linux", sandboxPath: "/usr/bin/sandbox-exec" }),
    ).toThrow(SeatbeltConfinementError);

    const notExecutable = join(root, "sandbox-exec");
    writeFileSync(notExecutable, "#!/bin/sh\n", { mode: 0o600 });
    expect(() => requireSandboxExec({ platform: "darwin", sandboxPath: notExecutable })).toThrow(
      SeatbeltConfinementError,
    );
  });

  it("live confinement prepares a sandboxed launch and never falls back unconfined", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const sandboxPath = join(root, "sandbox-exec");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(sandboxPath, 0o700);

    const confinement = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
    });
    const launch = confinement.prepare({
      executable: "/usr/bin/true",
      args: [],
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
    });

    expect(launch.command).toBe(sandboxPath);
    expect(launch.args[0]).toBe("-p");
    expect(launch.args[1]).toContain("(deny default)");
    expect(launch.args[1]).toContain(seatbeltAllowRule("file-write*", boundRoot));
    expect(launch.args[1]).toContain(seatbeltAllowRule("file-write*", temporaryDirectory));
    expect(launch.args[1]).not.toContain("(allow network*)");
    expect(launch.args.slice(2, 4)).toEqual(["--", "/usr/bin/true"]);

    const missing = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath: join(root, "absent"),
      homeDirectory: root,
      usersDirectory: root,
    });
    expect(() =>
      missing.prepare({
        executable: "/usr/bin/true",
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "allow",
      }),
    ).toThrow(SeatbeltConfinementError);
    expect(existsSync(join(root, "absent"))).toBe(false);
  });

  it("supports provider-style additional write roots without dropping bound-root semantics", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const providerHome = join(root, "provider-home");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    mkdirSync(providerHome);

    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot,
      temporaryDirectory,
      additionalWriteRoots: [providerHome],
      readRoots: [boundRoot, temporaryDirectory, providerHome],
      networkEgress: "allow",
      allowFileReadStar: true,
      privateHomeAllowPaths: [boundRoot, temporaryDirectory, providerHome],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain(seatbeltDenyRule("file-read*", "/Volumes"));
    expect(profile).toContain(seatbeltDenyRule("file-read*", "/Network"));
    expect(profile).toContain(seatbeltAllowRule("file-write*", boundRoot));
    expect(profile).toContain(seatbeltAllowRule("file-write*", temporaryDirectory));
    expect(profile).toContain(seatbeltAllowRule("file-write*", providerHome));
  });

  it("can omit bound-root writes for plan/read-only profiles", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const providerHome = join(root, "provider-home");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    mkdirSync(providerHome);

    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot,
      temporaryDirectory,
      writeBoundRoot: false,
      additionalWriteRoots: [providerHome],
      allowFileReadStar: true,
      networkEgress: "allow",
      allowProcessExec: false,
      allowProcessFork: false,
      privateHomeAllowPaths: [boundRoot, temporaryDirectory, providerHome],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(profile).not.toContain("(allow process-exec)");
    expect(profile).not.toContain("(allow process-fork)");
    expect(profile).not.toContain(seatbeltAllowRule("file-write*", boundRoot));
    expect(profile).toContain(seatbeltAllowRule("file-write*", providerHome));
    expect(profile).toContain(seatbeltAllowRule("file-write*", temporaryDirectory));
  });

  it("prepares a Plan launch without process-exec, process-fork, or bound-root writes", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const providerHome = join(root, "provider-home");
    const sandboxPath = join(root, "sandbox-exec");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    mkdirSync(providerHome);
    writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(sandboxPath, 0o700);

    const launch = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
    }).prepare({
      executable: "/usr/bin/true",
      args: [],
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
      writeBoundRoot: false,
      allowProcessExec: false,
      allowProcessFork: false,
      additionalWriteRoots: [providerHome],
    });

    const profile = launch.args[1];
    expect(profile).not.toContain("(allow process-exec)");
    expect(profile).not.toContain("(allow process-fork)");
    expect(profile).not.toContain(seatbeltAllowRule("file-write*", boundRoot));
    expect(profile).toContain(seatbeltAllowRule("file-write*", temporaryDirectory));
    expect(profile).toContain(seatbeltAllowRule("file-write*", providerHome));
  });

  it("keeps a confined script and its env-resolved interpreter executable when exec is otherwise denied", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const binDirectory = join(root, "bin");
    const sandboxPath = join(root, "sandbox-exec");
    const interpreter = join(binDirectory, "node");
    const script = join(root, "cli.js");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    mkdirSync(binDirectory);
    writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(interpreter, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log(1)\n", { mode: 0o700 });

    const launch = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
      interpreterSearchPath: `/nonexistent:${binDirectory}`,
    }).prepare({
      executable: script,
      args: ["--mode", "rpc"],
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
      writeBoundRoot: false,
      allowProcessExec: false,
      allowProcessFork: false,
    });

    const profile = launch.args[1];
    expect(profile).not.toContain("(allow process-exec)");
    expect(profile).toContain(seatbeltExecRule(realpathSync(script)));
    expect(profile).toContain(seatbeltExecRule("/usr/bin/env"));
    expect(profile).toContain(seatbeltExecRule(realpathSync(interpreter)));
    expect(profile).not.toContain(seatbeltExecRule("/bin/sh"));
  });

  it("keeps process-exec fully denied for a program with no interpreter beyond itself", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const sandboxPath = join(root, "sandbox-exec");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });

    const launch = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
    }).prepare({
      executable: "/usr/bin/true",
      args: [],
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
      allowProcessExec: false,
    });

    const execRules = launch.args[1]!.split("\n").filter((line) => line.includes("process-exec"));
    expect(execRules).toEqual([seatbeltExecRule("/usr/bin/true")]);
  });
});

describe("host home deny helper defaults", () => {
  it("uses the process home when callers do not override directories", () => {
    const allowed = realpathSync(homedir());
    const rules = privateHomeDenyReadRules({ allowedPaths: [allowed] });
    expect(rules.every((rule) => rule.startsWith("(deny file-read*"))).toBe(true);
  });
});
