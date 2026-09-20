import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  it.skipIf(process.platform !== "darwin")(
    "starts the system shell without a shell-selection warning",
    () => {
      const root = temporaryRoot();
      const profile = buildDenyDefaultSeatbeltProfile({
        boundRoot: root,
        temporaryDirectory: root,
        networkEgress: "none",
        allowFileReadStar: true,
        privateHomeAllowPaths: [],
      });
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/bin/sh", "-c", "printf shell-ok"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("shell-ok");
      expect(result.stderr).toBe("");
      const unrelatedFile = join(temporaryRoot(), "private.txt");
      writeFileSync(unrelatedFile, "must remain private");
      const denied = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/bin/cat", unrelatedFile],
        {
          encoding: "utf8",
        },
      );
      expect(denied.status).not.toBe(0);
      expect(denied.stdout).toBe("");
      expect(denied.stderr).toContain("Operation not permitted");
    },
  );

  it("denies a bound root it may not write even when the temporary directory holds it", () => {
    // A scratch checkout under `$TMPDIR` — where the provider smokes put theirs
    // — was writable through the temporary directory's own subpath grant, so a
    // Plan launch could create a file inside the checkout it may only read.
    const temporaryDirectory = temporaryRoot();
    const checkout = join(temporaryDirectory, "checkout");
    mkdirSync(checkout);

    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: checkout,
      temporaryDirectory,
      networkEgress: "none",
      writeBoundRoot: false,
      allowFileReadStar: true,
      privateHomeAllowPaths: [],
    });

    const lines = profile.split("\n");
    expect(lines).toContain(seatbeltDenyRule("file-write*", checkout));
    expect(lines.indexOf(seatbeltDenyRule("file-write*", checkout))).toBeGreaterThan(
      lines.indexOf(seatbeltAllowRule("file-write*", temporaryDirectory)),
    );
    expect(profile).not.toContain(seatbeltAllowRule("file-write*", checkout));
  });

  it("opens a provider's credential lookup without opening the keychain files", () => {
    const root = temporaryRoot();
    const input = {
      boundRoot: root,
      temporaryDirectory: root,
      networkEgress: "allow",
      allowFileReadStar: true,
      privateHomeAllowPaths: [],
    } as const;

    const withLookup = buildDenyDefaultSeatbeltProfile({
      ...input,
      allowProviderCredentialLookup: true,
    });

    expect(withLookup).toContain('(allow mach-lookup (global-name "com.apple.SecurityServer"))');
    // The daemon opens the store; this process may never read it off disk.
    expect(withLookup).toContain(seatbeltDenyRule("file-read*", "/Library/Keychains"));
    expect(withLookup).not.toContain(seatbeltAllowRule("file-read*", "/Library/Keychains"));
    expect(buildDenyDefaultSeatbeltProfile(input)).not.toContain("com.apple.SecurityServer");
  });

  it("grants the resolved form of a launch root reached through a symlink", () => {
    const root = temporaryRoot();
    const checkout = join(root, "project");
    mkdirSync(checkout);
    const lexical = join(root, "project-link");
    symlinkSync(checkout, lexical);

    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: lexical,
      temporaryDirectory: lexical,
      networkEgress: "none",
      allowFileReadStar: true,
      privateHomeAllowPaths: [],
    });

    const resolved = realpathSync(lexical);
    expect(resolved).not.toBe(lexical);
    expect(profile).toContain(seatbeltAllowRule("file-read*", resolved));
    expect(profile).toContain(seatbeltAllowRule("file-write*", resolved));
    expect(profile).toContain(seatbeltAllowRule("file-read*", lexical));
  });

  it("refuses a launch root whose resolved form is an ancestor of a denied path", () => {
    const root = temporaryRoot();
    const link = join(root, "root-link");
    symlinkSync("/", link);

    expect(() =>
      buildDenyDefaultSeatbeltProfile({
        boundRoot: link,
        temporaryDirectory: join(root, "tmp"),
        networkEgress: "none",
        allowFileReadStar: true,
        privateHomeAllowPaths: [],
      }),
    ).toThrow(SeatbeltConfinementError);
  });

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
    expect(profile).toContain("(allow signal (target children))");
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

  it("opens the Simulator lookups and the runtime mount only when the launch drives the Simulator", () => {
    const common = {
      boundRoot: "/private/tmp/octant-project",
      temporaryDirectory: "/private/tmp/octant-temporary",
      networkEgress: "none",
      privateHomeAllowPaths: [],
    } as const;
    const ordinary = buildDenyDefaultSeatbeltProfile({ ...common });
    const simulator = buildDenyDefaultSeatbeltProfile({
      ...common,
      allowSimulatorControl: true,
    });

    // A repository test run never talks to CoreSimulatorService, so it keeps
    // the tighter profile.
    expect(ordinary).not.toContain("mach-lookup");
    expect(ordinary).not.toContain("cryptexd");
    expect(simulator).toContain(
      '(allow mach-lookup (global-name-prefix "com.apple.CoreSimulator."))',
    );
    expect(simulator).toContain(
      '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    );
    // The installed runtimes live on the cryptex mount. Without this read
    // `simctl` still exits 0, but reports an empty device set.
    expect(simulator).toContain(
      seatbeltAllowRule("file-read*", "/private/var/run/com.apple.security.cryptexd/mnt"),
    );
    // No unbounded wildcard: the named prefix above is the whole exception.
    expect(simulator).not.toContain('(allow mach-lookup (global-name "com.apple."))');
    expect(simulator).not.toContain("(allow mach-lookup)");
    expect(simulator.match(/mach-lookup/g)).toHaveLength(2);
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

  it("opens Apple trust evaluation only when the launch may reach the network", () => {
    const root = temporaryRoot();
    const input = {
      boundRoot: join(root, "project"),
      temporaryDirectory: join(root, "tmp"),
      privateHomeAllowPaths: [] as ReadonlyArray<string>,
    };
    const reachable = buildDenyDefaultSeatbeltProfile({ ...input, networkEgress: "allow" });
    expect(reachable).toContain('(allow mach-lookup (global-name "com.apple.trustd"))');
    expect(reachable).toContain('(allow mach-lookup (global-name "com.apple.trustd.agent"))');
    expect(reachable).toContain(seatbeltAllowRule("file-read*", "/System/Library/Keychains"));
    expect(reachable).toContain(seatbeltAllowRule("file-read*", "/System/Library/Security"));

    const offline = buildDenyDefaultSeatbeltProfile({ ...input, networkEgress: "none" });
    expect(offline).not.toContain("mach-lookup");
    expect(offline).not.toContain("/System/Library/Keychains");
    expect(offline).not.toContain("/System/Library/Security");
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

  it("keeps an env-resolved interpreter launcher readable without opening its sibling binaries", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const launcherDirectory = join(root, ".local/bin");
    const runtimeDirectory = join(root, ".hermes/node/bin");
    const packageDirectory = join(root, ".local/lib/provider");
    const sandboxPath = join(root, "sandbox-exec");
    const interpreter = join(runtimeDirectory, "node");
    const launcher = join(launcherDirectory, "node");
    const sibling = join(launcherDirectory, "npm");
    const script = join(packageDirectory, "cli.js");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    mkdirSync(launcherDirectory, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(interpreter, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(sibling, "#!/bin/sh\n", { mode: 0o700 });
    symlinkSync(interpreter, launcher);
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log(1)\n", { mode: 0o700 });

    const launch = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
      interpreterSearchPath: launcherDirectory,
    }).prepare({
      executable: script,
      args: [],
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
      allowFileReadStar: true,
      allowProcessExec: false,
      allowProcessFork: false,
    });

    const profile = launch.args[1];
    expect(profile).toContain(seatbeltExecRule(launcher));
    expect(profile).toContain(seatbeltExecRule(interpreter));
    expect(profile).not.toContain(seatbeltDenyRule("file-read*", launcherDirectory));
    expect(profile).not.toContain(seatbeltDenyRule("file-read*", launcher));
    expect(profile).toContain(seatbeltDenyRule("file-read*", sibling));
  });

  it("resolves the interpreter past env options and environment assignments", () => {
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
    writeFileSync(script, "#!/usr/bin/env -u NODE_OPTIONS FORCE_COLOR=0 node\nconsole.log(1)\n", {
      mode: 0o700,
    });

    const launch = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
      interpreterSearchPath: binDirectory,
    }).prepare({
      executable: script,
      args: [],
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
      writeBoundRoot: false,
      allowProcessExec: false,
      allowProcessFork: false,
    });

    const profile = launch.args[1];
    expect(profile).toContain(seatbeltExecRule(realpathSync(interpreter)));
  });

  it("allows the exact Python framework companion launched by a script interpreter", () => {
    const root = temporaryRoot();
    const boundRoot = join(root, "project");
    const temporaryDirectory = join(root, "tmp");
    const sandboxPath = join(root, "sandbox-exec");
    const frameworkRoot = join(root, "Python.framework", "Versions", "3.14");
    const interpreter = join(frameworkRoot, "bin", "python3.14");
    const companion = join(frameworkRoot, "Resources/Python.app/Contents/MacOS/Python");
    const script = join(root, "vibe-acp");
    mkdirSync(boundRoot);
    mkdirSync(temporaryDirectory);
    mkdirSync(join(frameworkRoot, "bin"), { recursive: true });
    mkdirSync(join(frameworkRoot, "Resources/Python.app/Contents/MacOS"), { recursive: true });
    writeFileSync(sandboxPath, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(interpreter, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(companion, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(script, `#!${interpreter}\n`, { mode: 0o700 });

    const launch = makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: root,
      usersDirectory: root,
    }).prepare({
      executable: script,
      args: [],
      boundRoot,
      temporaryDirectory,
      networkEgress: "none",
      allowProcessExec: false,
      allowProcessFork: false,
    });

    const profile = launch.args[1]!;
    expect(profile).toContain(seatbeltExecRule(realpathSync(companion)));
    expect(profile).not.toContain("(allow process-exec)\n");
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

  it("keeps a link that resolves through an allowed directory readable", () => {
    // A versioned launcher (`~/.local/bin/tool` -> `.../_versions/current/bin/tool`)
    // is only executable if the kernel can resolve the links on the way, and
    // resolving a link needs read-metadata on the link itself. The allowed
    // path is the resolved version directory, so the `current` link is not a
    // prefix of it and would otherwise be denied.
    const root = temporaryRoot();
    const versions = join(root, "versions");
    const allowedVersion = join(versions, "1.2.3");
    mkdirSync(join(allowedVersion, "bin"), { recursive: true });
    const allowedBinary = join(allowedVersion, "bin", "tool");
    writeFileSync(allowedBinary, "#!/bin/sh\n");
    symlinkSync("1.2.3", join(versions, "current"));
    mkdirSync(join(root, "elsewhere"));

    const rules = privateHomeDenyReadRules({
      allowedPaths: [allowedBinary, allowedVersion, join(root, "bin")],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(rules).not.toContain(seatbeltDenyRule("file-read*", join(versions, "current")));
    expect(rules).toContain(seatbeltDenyRule("file-read*", join(root, "elsewhere")));
  });

  it("keeps a broken link readable only while its target text is on an allowed path", () => {
    // The allowance reads the link's own target text and never follows it, so
    // a broken link onto an allowed path grants link metadata and nothing
    // else — there is no file to open. A broken link whose target is unrelated
    // to the allowed set stays denied.
    const root = temporaryRoot();
    const allowed = join(root, "allowed");
    mkdirSync(allowed);
    const ontoAllowed = join(root, "onto-allowed");
    const ontoElsewhere = join(root, "onto-elsewhere");
    symlinkSync(join(allowed, "missing"), ontoAllowed);
    symlinkSync(join(root, "elsewhere", "missing"), ontoElsewhere);

    const rules = privateHomeDenyReadRules({
      allowedPaths: [allowed],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(rules).not.toContain(seatbeltDenyRule("file-read*", ontoAllowed));
    expect(rules).toContain(seatbeltDenyRule("file-read*", ontoElsewhere));
  });

  it("keeps a link to a path outside the allowed set denied", () => {
    const root = temporaryRoot();
    const allowed = join(root, "allowed");
    const secrets = join(root, "secrets");
    mkdirSync(allowed);
    mkdirSync(secrets);
    symlinkSync(secrets, join(root, "escape"));

    const rules = privateHomeDenyReadRules({
      allowedPaths: [allowed],
      homeDirectory: root,
      usersDirectory: root,
    });

    expect(rules).toContain(seatbeltDenyRule("file-read*", join(root, "escape")));
  });
});
