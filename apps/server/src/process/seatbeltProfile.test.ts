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
      allowProcessFork: false,
      privateHomeAllowPaths: [boundRoot, temporaryDirectory, providerHome],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(profile).not.toContain("(allow process-fork)");
    expect(profile).not.toContain(seatbeltAllowRule("file-write*", boundRoot));
    expect(profile).toContain(seatbeltAllowRule("file-write*", providerHome));
    expect(profile).toContain(seatbeltAllowRule("file-write*", temporaryDirectory));
  });
});

describe("host home deny helper defaults", () => {
  it("uses the process home when callers do not override directories", () => {
    const allowed = realpathSync(homedir());
    const rules = privateHomeDenyReadRules({ allowedPaths: [allowed] });
    expect(rules.every((rule) => rule.startsWith("(deny file-read*"))).toBe(true);
  });
});
