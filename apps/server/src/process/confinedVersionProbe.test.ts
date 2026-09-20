import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { execVersionRead, prepareConfinedVersionProbe } from "./confinedVersionProbe";
import { makeSeatbeltConfinementLive, seatbeltAllowRule } from "./seatbeltProfile";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-version-probe-test-")));
  directories.push(directory);
  return directory;
}

/**
 * A host whose home, scratch root and `sandbox-exec` all sit inside one
 * throwaway directory, so a profile built here names no path of the real user.
 */
function host(): {
  readonly root: string;
  readonly home: string;
  readonly binaryPath: string;
  readonly confinement: ReturnType<typeof makeSeatbeltConfinementLive>;
  readonly temporaryRoot: string;
} {
  const root = temporaryRoot();
  const home = join(root, "home");
  const installDirectory = join(home, "tools", "example", "bin");
  mkdirSync(installDirectory, { recursive: true });
  // A sibling of the install tree, standing in for what the user keeps at home.
  mkdirSync(join(home, "credentials"), { recursive: true });
  writeFileSync(join(home, "credentials", "token"), "must stay private");
  const binaryPath = join(installDirectory, "example");
  writeFileSync(binaryPath, "#!/bin/sh\nprintf '1.2.3\\n'\n", { mode: 0o755 });
  chmodSync(binaryPath, 0o755);
  const sandboxPath = join(root, "sandbox-exec");
  writeFileSync(sandboxPath, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 });
  chmodSync(sandboxPath, 0o700);
  const scratchRoot = join(root, "scratch");
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  return {
    root,
    home,
    binaryPath,
    temporaryRoot: scratchRoot,
    confinement: makeSeatbeltConfinementLive({
      platform: "darwin",
      sandboxPath,
      homeDirectory: home,
      usersDirectory: root,
    }),
  };
}

function prepared(target: ReturnType<typeof host>, binaryPath = target.binaryPath) {
  const probe = prepareConfinedVersionProbe({
    binaryPath,
    displayName: "Example",
    environment: () => ({ PATH: "/usr/bin:/bin" }),
    confinement: target.confinement,
    temporaryRoot: target.temporaryRoot,
    homeDirectory: target.home,
  });
  if (probe.status === "refused") throw new Error(`Unexpected refusal: ${probe.message}`);
  return probe.launch;
}

describe("confined version probe", () => {
  it("reads the version through the confinement runtime rather than the configured program", () => {
    const target = host();
    const launch = prepared(target);

    expect(launch.command).toBe(join(target.root, "sandbox-exec"));
    expect(launch.args.slice(-2)).toEqual([target.binaryPath, "--version"]);
    launch.release();
  });

  it("binds no project root and grants the read nothing writable but its own scratch", () => {
    const target = host();
    const launch = prepared(target);
    const profile = launch.args[1] ?? "";

    const writeAllows = profile.split("\n").filter((rule) => rule.startsWith("(allow file-write*"));
    expect(writeAllows).toEqual(
      expect.arrayContaining([seatbeltAllowRule("file-write*", launch.workingDirectory)]),
    );
    expect(writeAllows.filter((rule) => !rule.includes(launch.workingDirectory))).toEqual([]);
    expect(launch.workingDirectory.startsWith(target.temporaryRoot)).toBe(true);
    expect(launch.environment.HOME).toBe(launch.workingDirectory);
    expect(launch.environment.TMPDIR).toBe(launch.workingDirectory);
    launch.release();
  });

  it("denies the version read the network", () => {
    const target = host();
    const launch = prepared(target);

    expect(launch.args[1]).not.toContain("(allow network*)");
    launch.release();
  });

  it("opens the program's own install tree and leaves the rest of the home denied", () => {
    const target = host();
    const launch = prepared(target);
    const profile = launch.args[1] ?? "";

    expect(profile).toContain(
      seatbeltAllowRule("file-read*", join(target.home, "tools", "example")),
    );
    expect(profile).toContain(`(deny file-read* (subpath "${join(target.home, "credentials")}"))`);
    launch.release();
  });

  it("keeps the home out of the read roots when the program sits directly in it", () => {
    const target = host();
    const binaryPath = join(target.home, "example");
    writeFileSync(binaryPath, "#!/bin/sh\nprintf '1.2.3\\n'\n", { mode: 0o755 });
    chmodSync(binaryPath, 0o755);
    const launch = prepared(target, binaryPath);

    expect(launch.args[1]).not.toContain(seatbeltAllowRule("file-read*", target.home));
    launch.release();
  });

  it("refuses the read rather than running the program unconfined on a host with no sandbox runtime", () => {
    const target = host();
    const probe = prepareConfinedVersionProbe({
      binaryPath: target.binaryPath,
      displayName: "Example",
      environment: () => ({}),
      confinement: makeSeatbeltConfinementLive({
        platform: "darwin",
        sandboxPath: join(target.root, "absent"),
      }),
      temporaryRoot: target.temporaryRoot,
      homeDirectory: target.home,
    });

    expect(probe).toEqual({
      status: "refused",
      reason: "incompatible",
      message: expect.stringContaining("sandbox-exec"),
    });
    expect(existsSync(target.temporaryRoot)).toBe(true);
  });

  it("hands the version read no credential and no real config home", () => {
    // A family builds the environment it always built; the read keeps only a
    // fixed set of inherited names, what the family computed from the scratch,
    // and the static guards it named. Provider credentials, cloud keys and a
    // family's config-home variables are dropped, so a program that consults
    // one falls back to HOME, which is the scratch.
    const target = host();
    const probe = prepareConfinedVersionProbe({
      binaryPath: target.binaryPath,
      displayName: "Example",
      environment: (scratch) => ({
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        USER: "person",
        HOME: target.home,
        OPENAI_API_KEY: "sk-secret",
        GITHUB_TOKEN: "ghp_secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        CODEX_HOME: join(target.home, ".codex"),
        CLAUDE_CONFIG_DIR: join(target.home, ".claude"),
        PI_CODING_AGENT_DIR: join(target.home, ".pi", "agent"),
        XDG_CONFIG_HOME: join(target.home, ".config"),
        NODE_OPTIONS: "--require /tmp/hook.js",
        // Computed from the scratch by the family, so it stays.
        OMP_HOME: scratch,
        VIBE_HOME: join(scratch, ".vibe"),
        FAMILY_SWITCH: "off",
      }),
      guards: { FAMILY_SWITCH: "off" },
      confinement: target.confinement,
      temporaryRoot: target.temporaryRoot,
      homeDirectory: target.home,
    });
    if (probe.status === "refused") throw new Error(`Unexpected refusal: ${probe.message}`);
    const { launch } = probe;

    expect(launch.environment).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      USER: "person",
      HOME: launch.workingDirectory,
      TMPDIR: launch.workingDirectory,
      OMP_HOME: launch.workingDirectory,
      VIBE_HOME: join(launch.workingDirectory, ".vibe"),
      FAMILY_SWITCH: "off",
    });
    launch.release();
  });

  it("does not keep a guard whose value the host changed", () => {
    // A guard passes only where it is the static constant the family named. A
    // host variable of the same name with another value is host-derived.
    const target = host();
    const probe = prepareConfinedVersionProbe({
      binaryPath: target.binaryPath,
      displayName: "Example",
      environment: () => ({ PATH: "/usr/bin:/bin", FAMILY_SWITCH: "on" }),
      guards: { FAMILY_SWITCH: "off" },
      confinement: target.confinement,
      temporaryRoot: target.temporaryRoot,
      homeDirectory: target.home,
    });
    if (probe.status === "refused") throw new Error(`Unexpected refusal: ${probe.message}`);

    expect(probe.launch.environment).not.toHaveProperty("FAMILY_SWITCH");
    probe.launch.release();
  });

  it("does not open the home when the launcher's directory is a link to it", () => {
    // The builder canonicalises every root it is given. A program kept directly
    // in the home and reached through a link to it has a launcher directory
    // that names the home only through the link: it passed a check on its own
    // spelling and then opened the whole home once resolved.
    const target = host();
    const kept = join(target.home, "example");
    writeFileSync(kept, "#!/bin/sh\nprintf '1.2.3\\n'\n", { mode: 0o755 });
    chmodSync(kept, 0o755);
    const linkDirectory = join(target.root, "link");
    symlinkSync(target.home, linkDirectory);
    const launch = prepared(target, join(linkDirectory, "example"));
    const profile = launch.args[1] ?? "";

    expect(profile).not.toContain(seatbeltAllowRule("file-read*", target.home));
    expect(profile).not.toContain(seatbeltAllowRule("file-read*", linkDirectory));
    // The program itself still opens, under its resolved name.
    expect(profile).toContain(seatbeltAllowRule("file-read*", kept));
    launch.release();
  });

  it("takes the scratch directory away when the caller releases the launch", () => {
    const target = host();
    const launch = prepared(target);
    expect(existsSync(launch.workingDirectory)).toBe(true);

    launch.release();

    expect(existsSync(launch.workingDirectory)).toBe(false);
  });

  it("runs a Linux launch in its own scratch with no network and no host temp", () => {
    // Bubblewrap cannot be installed here, so this covers what the launch asks
    // bwrap for, not what the kernel then enforces. The writable-scratch half
    // is only proved on macOS above: bwrap would bind the scratch writable
    // either way, because the temporary-directory bind replaces the bound
    // root's read-only one at the same mount point.
    const target = host();
    const bwrap = join(target.root, "bwrap");
    writeFileSync(bwrap, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
    chmodSync(bwrap, 0o700);
    const probe = prepareConfinedVersionProbe({
      binaryPath: target.binaryPath,
      displayName: "Example",
      environment: () => ({ PATH: "/usr/bin:/bin" }),
      confinement: makeSeatbeltConfinementLive({ platform: "linux", sandboxPath: bwrap }),
      temporaryRoot: target.temporaryRoot,
      homeDirectory: target.home,
    });
    if (probe.status === "refused") throw new Error(`Unexpected refusal: ${probe.message}`);
    const { launch } = probe;
    const args = [...launch.args];

    expect(args).toContain("--unshare-all");
    expect(args).not.toContain("--share-net");
    // The scratch is the root the launch binds, so bwrap chdirs into it and
    // binds it rather than leaving the read in the host's working directory.
    expect(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2)).toEqual([
      "--chdir",
      launch.workingDirectory,
    ]);
    expect(args[args.indexOf("--bind") + 2]).toBe(launch.workingDirectory);
    expect(args.slice(-2)).toEqual([target.binaryPath, "--version"]);
    launch.release();
  });

  it.skipIf(process.platform !== "darwin")(
    "reads the version from a program that starts another program, and refuses its writes outside the scratch",
    () => {
      const root = temporaryRoot();
      const installDirectory = join(root, "tools", "bin");
      mkdirSync(installDirectory, { recursive: true });
      const child = join(installDirectory, "child");
      writeFileSync(child, "#!/bin/sh\nprintf '4.5.6\\n'\n", { mode: 0o755 });
      chmodSync(child, 0o755);
      const outside = join(root, "outside.txt");
      // A launcher shape: the configured program is a script that starts the
      // program that answers, which is what an npm entry point and a version
      // manager's shim both do.
      const binaryPath = join(installDirectory, "launcher");
      writeFileSync(
        binaryPath,
        `#!/bin/sh\nprintf 'escaped' > '${outside}'\nprintf 'kept' > scratch.txt\nexec '${child}' "$@"\n`,
        { mode: 0o755 },
      );
      chmodSync(binaryPath, 0o755);

      const probe = prepareConfinedVersionProbe({
        binaryPath,
        displayName: "Example",
        environment: () => ({ PATH: "/usr/bin:/bin" }),
      });
      if (probe.status === "refused") throw new Error(`Unexpected refusal: ${probe.message}`);
      const { launch } = probe;
      const result = spawnSync(launch.command, [...launch.args], {
        cwd: launch.workingDirectory,
        env: launch.environment,
        encoding: "utf8",
      });
      const inside = join(launch.workingDirectory, "scratch.txt");
      const wroteInside = existsSync(inside);
      launch.release();

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("4.5.6\n");
      expect(existsSync(outside)).toBe(false);
      // The scratch is the one path the read may write, so a rule that denies
      // a bound root it may not write must not reach it.
      expect(wroteInside).toBe(true);
    },
  );

  describe("execVersionRead", () => {
    const options = { env: { PATH: "/usr/bin:/bin" }, timeout: 5_000, maxBuffer: 1_024 };

    function program(body: string): string {
      const path = join(temporaryRoot(), "program");
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      chmodSync(path, 0o755);
      return path;
    }

    function isRunning(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }

    it("ends a background process the program leaves behind when it exits", async () => {
      // The program forks a process, closes the pipes it inherited, and exits.
      // `execFile` settles on that exit and never looks at the descendant, which
      // then outlives the scratch directory the read was confined to.
      const pidFile = join(temporaryRoot(), "background.pid");
      const path = program(`sleep 60 >/dev/null 2>&1 &\necho $! > '${pidFile}'\nprintf '1.2.3\\n'`);

      const read = await execVersionRead(path, [], options);
      const background = Number(readFileSync(pidFile, "utf8"));

      expect(read.stdout).toBe("1.2.3\n");
      await vi.waitFor(() => expect(isRunning(background)).toBe(false), { timeout: 3_000 });
    });

    it("ends the whole group when the read times out", async () => {
      const pidFile = join(temporaryRoot(), "background.pid");
      const path = program(`sleep 60 &\necho $! > '${pidFile}'\nsleep 60`);

      await expect(execVersionRead(path, [], { ...options, timeout: 300 })).rejects.toThrow(
        /timed out/,
      );
      const background = Number(readFileSync(pidFile, "utf8"));

      await vi.waitFor(() => expect(isRunning(background)).toBe(false), { timeout: 3_000 });
    });

    it("rejects a non-zero exit and output past the limit, as execFile does", async () => {
      await expect(execVersionRead(program("exit 3"), [], options)).rejects.toThrow(
        /exited with 3/,
      );
      await expect(
        execVersionRead(program("head -c 4096 /dev/zero | tr '\\0' x"), [], options),
      ).rejects.toThrow(/output limit/);
    });
  });
});
