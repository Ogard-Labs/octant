import {
  accessSync,
  chmodSync,
  constants,
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
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLinuxAllowDefaultDenyLaunch,
  buildBubblewrapLaunch,
  DEFAULT_BWRAP_PATH,
  requireLinuxConfinement,
} from "./linuxConfinement";
import { LINUX_EGRESS_FORWARDER_PORT, LINUX_EGRESS_FORWARDER_SOURCE } from "./proxiedNetworkEgress";
import { ProcessConfinementError } from "./seatbeltProfile";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): {
  readonly root: string;
  readonly boundRoot: string;
  readonly temporaryDirectory: string;
  readonly bwrapPath: string;
} {
  // The launch builder resolves bind sources through symlinks; macOS's tmpdir
  // sits behind /var → /private/var, so the fixture must hand out resolved
  // paths or every bind-pair expectation fails on a Mac host.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-linux-confinement-")));
  directories.push(root);
  const boundRoot = join(root, "project");
  const temporaryDirectory = join(root, "tmp");
  const bwrapPath = join(root, "bwrap");
  mkdirSync(boundRoot);
  mkdirSync(temporaryDirectory);
  writeFileSync(bwrapPath, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  chmodSync(bwrapPath, 0o700);
  return { root, boundRoot, temporaryDirectory, bwrapPath };
}

function canRunHostBwrap(): boolean {
  try {
    accessSync(DEFAULT_BWRAP_PATH, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

describe("Linux Full access extension denials", () => {
  it("keeps the host root and overlays denied files and directories", () => {
    const { boundRoot, bwrapPath, root } = fixture();
    const skills = join(root, "skills");
    const mcp = join(root, "mcp.json");
    mkdirSync(skills);
    writeFileSync(mcp, "{}\n");
    const launch = buildLinuxAllowDefaultDenyLaunch(
      {
        executable: "/bin/true",
        args: ["acp"],
        cwd: boundRoot,
        denyPaths: [skills, mcp],
      },
      { bwrapPath },
    );
    expect(launch.command).toBe(bwrapPath);
    expect(launch.args.slice(0, 9)).toEqual([
      "--die-with-parent",
      "--dev-bind",
      "/dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      "/",
      "/",
    ]);
    expect(launch.args).toContain("--tmpfs");
    expect(launch.args).toContain(skills);
    expect(launch.args).toContain("--ro-bind");
    expect(launch.args.at(-2)).toBe("/bin/true");
    expect(launch.args.at(-1)).toBe("acp");
  });

  it("leaves a deny path that does not exist alone instead of creating it in the folder", () => {
    const { boundRoot, bwrapPath } = fixture();
    const missingSkills = join(boundRoot, ".claude", "skills");
    const missingAgents = join(boundRoot, ".agents");
    const launch = buildLinuxAllowDefaultDenyLaunch(
      {
        executable: "/bin/true",
        args: ["acp"],
        cwd: boundRoot,
        denyPaths: [missingSkills, missingAgents],
      },
      { bwrapPath },
    );
    // With the host root bound writable, Bubblewrap would make the mount point
    // in the person's own Project and leave an empty folder behind.
    expect(launch.args).not.toContain(missingSkills);
    expect(launch.args).not.toContain(missingAgents);
    expect(launch.args).not.toContain("--tmpfs");
  });

  it("fails closed when a deny file cannot be overlaid", () => {
    const { boundRoot, bwrapPath, root } = fixture();
    const fifo = join(root, "mcp.json");
    spawnSync("mkfifo", [fifo], { stdio: "ignore" });
    if (!existsSync(fifo)) return;
    expect(() =>
      buildLinuxAllowDefaultDenyLaunch(
        {
          executable: "/bin/true",
          args: ["acp"],
          cwd: boundRoot,
          denyPaths: [fifo],
        },
        { bwrapPath },
      ),
    ).toThrow(/could not be overlaid/);
  });

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "hides a linked file or folder at its target and still starts the command",
    () => {
      const { root, boundRoot } = fixture();
      const shared = join(root, "shared");
      mkdirSync(join(shared, "skills"), { recursive: true });
      mkdirSync(join(shared, "agents"));
      writeFileSync(join(shared, "mcp.json"), "hidden");
      writeFileSync(join(shared, "settings.json"), "hidden");
      writeFileSync(join(shared, "skills", "SKILL.md"), "hidden");
      writeFileSync(join(shared, "agents", "SKILL.md"), "hidden");
      // Absolute links refused the whole launch with "Can't mount tmpfs on
      // /newroot/..." before the command started; relative ones are covered
      // the same way so both forms behave alike.
      symlinkSync(join(shared, "mcp.json"), join(boundRoot, ".mcp.json"));
      symlinkSync(join(shared, "skills"), join(boundRoot, "skills"));
      symlinkSync("../shared/settings.json", join(boundRoot, "settings.json"));
      symlinkSync("../shared/agents", join(boundRoot, ".agents"));
      const denied = [".mcp.json", "skills", "settings.json", ".agents"].map((name) =>
        join(boundRoot, name),
      );
      const launch = buildLinuxAllowDefaultDenyLaunch({
        executable: "/bin/sh",
        args: [
          "-c",
          'for path in "$@"; do cat "$path" "$path/SKILL.md"; done; echo end',
          "sh",
          ...denied,
        ],
        cwd: boundRoot,
        denyPaths: denied,
      });
      const result = spawnSync(launch.command, [...launch.args], { encoding: "utf8" });
      // The command's own refusals stay on stderr; only Bubblewrap's would
      // mean the launch never started.
      expect(result.stderr).not.toContain("bwrap:");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("end\n");
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "keeps a denied link to a missing file from being written through",
    () => {
      const { root, boundRoot } = fixture();
      const shared = join(root, "shared");
      mkdirSync(shared);
      const absolute = join(boundRoot, ".mcp.json");
      const relative = join(boundRoot, "settings.json");
      symlinkSync(join(shared, "mcp.json"), absolute);
      symlinkSync("../shared/settings.json", relative);
      const launch = buildLinuxAllowDefaultDenyLaunch({
        executable: "/bin/sh",
        args: [
          "-c",
          'for path in "$@"; do { echo planted > "$path"; } && echo written; done; echo end',
          "sh",
          absolute,
          relative,
        ],
        cwd: boundRoot,
        denyPaths: [absolute, relative],
      });
      const result = spawnSync(launch.command, [...launch.args], { encoding: "utf8" });
      expect(result.stderr).not.toContain("bwrap:");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("end\n");
    },
  );
});

describe("Linux Bubblewrap confinement", () => {
  it("keeps a linked launcher visible through its parent without overlaying the link", () => {
    const { root, boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const bin = join(root, "home", ".local", "bin");
    const versions = join(root, "home", ".local", "share", "tool", "versions");
    mkdirSync(bin, { recursive: true });
    mkdirSync(versions, { recursive: true });
    const target = join(versions, "1.2.3");
    writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const linked = join(bin, "tool");
    symlinkSync(target, linked);
    const launch = buildBubblewrapLaunch(
      {
        executable: linked,
        args: ["--version"],
        boundRoot,
        temporaryDirectory,
        readRoots: [bin, versions],
        allowProcessExec: true,
        networkEgress: "none",
      },
      { bwrapPath },
    );

    expect(launch.args.slice(-2)).toEqual([linked, "--version"]);
    expect(boundPairs(launch.args, "--ro-bind")).toContainEqual([bin, bin]);
    expect(boundPairs(launch.args, "--ro-bind")).toContainEqual([versions, versions]);
    expect(boundPairs(launch.args, "--ro-bind")).not.toContainEqual([target, linked]);
    expect(launch.args).not.toContain("--share-net");
  });

  it("names only an absent runtime as one a person can fix by installing it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-linux-bwrap-")));
    directories.push(root);
    const notExecutable = join(root, "bwrap");
    writeFileSync(notExecutable, "");
    chmodSync(notExecutable, 0o644);

    const refusal = (path: string) => {
      try {
        requireLinuxConfinement(path);
      } catch (error) {
        return error;
      }
      return undefined;
    };

    const absent = refusal(join(root, "missing", "bwrap"));
    expect(absent).toBeInstanceOf(ProcessConfinementError);
    expect((absent as ProcessConfinementError).userFixable).toBe("linux-bubblewrap-missing");

    const unusable = refusal(notExecutable);
    expect(unusable).toBeInstanceOf(ProcessConfinementError);
    expect((unusable as ProcessConfinementError).userFixable).toBeUndefined();
  });

  it("uses a private tmpfs for /tmp instead of binding the host directory", () => {
    const { boundRoot, bwrapPath } = fixture();
    const launch = buildBubblewrapLaunch(
      {
        executable: "/bin/true",
        args: [],
        boundRoot,
        temporaryDirectory: "/tmp",
        networkEgress: "none",
      },
      { bwrapPath },
    );

    expect(launch.command).toBe(bwrapPath);
    expect(launch.args).toContain("--unshare-all");
    expect(tmpfsTargets(launch.args)).toContain("/tmp");
    expect(boundPairs(launch.args, "--bind")).not.toContainEqual(["/tmp", "/tmp"]);
    expect(hasFlagValue(launch.args, "--remount-ro", "/tmp")).toBe(false);
    expect(hasFlagValue(launch.args, "--remount-ro", "/")).toBe(true);
  });

  it("still binds a dedicated temporary directory after hiding host /tmp", () => {
    const { boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const launch = buildBubblewrapLaunch(
      {
        executable: "/bin/true",
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
      },
      { bwrapPath },
    );

    expect(tmpfsTargets(launch.args)).toContain("/tmp");
    expect(boundPairs(launch.args, "--bind")).toContainEqual([
      temporaryDirectory,
      temporaryDirectory,
    ]);
    expect(hasFlagValue(launch.args, "--remount-ro", "/tmp")).toBe(false);
  });

  it("applies a read denial that only overlaps a read-only mount", () => {
    const { boundRoot, temporaryDirectory, bwrapPath, root } = fixture();
    const readRoot = join(root, "readable");
    const denied = join(readRoot, "secret");
    mkdirSync(denied, { recursive: true });
    const launch = buildBubblewrapLaunch(
      {
        executable: "/bin/true",
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        readRoots: [readRoot],
        additionalDenyReadPaths: [denied],
      },
      { bwrapPath },
    );

    expect(boundPairs(launch.args, "--ro-bind")).toContainEqual([readRoot, readRoot]);
    expect(tmpfsTargets(launch.args)).toContain(denied);
    expect(hasFlagValue(launch.args, "--remount-ro", denied)).toBe(true);
  });

  it("keeps Plan from writing the bound root or spawning host processes", () => {
    const { boundRoot, temporaryDirectory, bwrapPath, root } = fixture();
    const executable = join(root, "true");
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const launch = buildBubblewrapLaunch(
      {
        executable,
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        writeBoundRoot: false,
        allowProcessExec: false,
        allowProcessFork: false,
      },
      { bwrapPath },
    );

    expect(boundPairs(launch.args, "--bind")).not.toContainEqual([boundRoot, boundRoot]);
    expect(boundPairs(launch.args, "--ro-bind")).toContainEqual([boundRoot, boundRoot]);
    expect(boundPairs(launch.args, "--bind")).toContainEqual([
      temporaryDirectory,
      temporaryDirectory,
    ]);
    expect(tmpfsTargets(launch.args)).toContain("/bin");
    expect(boundPairs(launch.args, "--ro-bind")).toContainEqual([executable, executable]);
    expect(launch.command).toBe("/bin/sh");
    expect(launch.args[0]).toBe("-c");
    expect(launch.args[1]).toContain("--seccomp 3");
    const seccompPath = launch.args[4] ?? "";
    expect(seccompPath.endsWith(".bpf")).toBe(true);
    expect(seccompPath).toMatch(/[/\\]octant-seccomp-[^/\\]+[/\\]process-deny/);
    expect(existsSync(seccompPath)).toBe(true);
  });

  it("keeps a Plan script's interpreter through the mask over the host executable directories", () => {
    const { boundRoot, temporaryDirectory, bwrapPath, root } = fixture();
    const executable = join(root, "tool");
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const launch = buildBubblewrapLaunch(
      {
        executable,
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        writeBoundRoot: false,
        allowProcessExec: false,
        allowProcessFork: false,
      },
      { bwrapPath },
    );

    // `/bin` is replaced by an empty overlay in this posture, so a script whose
    // interpreter is not bound back cannot start at all.
    expect(tmpfsTargets(launch.args)).toContain("/bin");
    expect(boundPairs(launch.args, "--ro-bind")).toContainEqual([
      realpathSync("/bin/sh"),
      "/bin/sh",
    ]);
  });

  it("writes the seccomp filter into a private directory instead of a predictable path", () => {
    const { boundRoot, temporaryDirectory, bwrapPath, root } = fixture();
    const predictablePath = join(temporaryDirectory, "octant-linux-process-deny-fork-exec.bpf");
    const trapFile = join(root, "seccomp-trap");
    writeFileSync(trapFile, "untouched", { mode: 0o600 });
    symlinkSync(trapFile, predictablePath);
    const launch = buildBubblewrapLaunch(
      {
        executable: "/bin/true",
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        writeBoundRoot: false,
        allowProcessExec: false,
        allowProcessFork: false,
      },
      { bwrapPath },
    );

    const seccompPath = launch.args[4] ?? "";
    expect(seccompPath).not.toBe(predictablePath);
    expect(readFileSync(trapFile, "utf8")).toBe("untouched");
    expect(seccompPath).toMatch(/[/\\]octant-seccomp-[^/\\]+[/\\]process-deny/);
  });

  it("refuses a temporary directory whose path contains a symlink component", () => {
    const { boundRoot, bwrapPath, root } = fixture();
    const realTemporaryDirectory = join(root, "real-temp");
    const linkedTemporaryDirectory = join(root, "linked-temp");
    mkdirSync(realTemporaryDirectory);
    symlinkSync(realTemporaryDirectory, linkedTemporaryDirectory);
    expect(() =>
      buildBubblewrapLaunch(
        {
          executable: "/bin/true",
          args: [],
          boundRoot,
          temporaryDirectory: linkedTemporaryDirectory,
          networkEgress: "none",
          allowProcessExec: false,
          allowProcessFork: false,
        },
        { bwrapPath },
      ),
    ).toThrow(ProcessConfinementError);
  });

  it("does not install a process-deny seccomp filter when exec and fork stay allowed", () => {
    const { boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const launch = buildBubblewrapLaunch(
      {
        executable: "/bin/true",
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
      },
      { bwrapPath },
    );

    expect(launch.command).toBe(bwrapPath);
    expect(launch.args[0]).toBe("--unshare-all");
    expect(launch.args).not.toContain("--seccomp");
  });

  it("fails closed when Plan process denial runs on an unsupported architecture", () => {
    const { boundRoot, temporaryDirectory, bwrapPath } = fixture();
    expect(() =>
      buildBubblewrapLaunch(
        {
          executable: "/bin/true",
          args: [],
          boundRoot,
          temporaryDirectory,
          networkEgress: "none",
          writeBoundRoot: false,
          allowProcessExec: false,
          allowProcessFork: false,
        },
        { bwrapPath, processArch: "ia32" },
      ),
    ).toThrow(ProcessConfinementError);
  });

  it("fails closed when bubblewrap is missing", () => {
    const { boundRoot, temporaryDirectory, root } = fixture();
    expect(() =>
      buildBubblewrapLaunch(
        {
          executable: "/bin/true",
          args: [],
          boundRoot,
          temporaryDirectory,
          networkEgress: "none",
        },
        { bwrapPath: join(root, "missing-bwrap") },
      ),
    ).toThrow(ProcessConfinementError);
  });

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "hides a host /tmp sentinel from a process whose temporary directory is /tmp",
    () => {
      const { boundRoot } = fixture();
      const sentinel = join("/tmp", `octant-host-tmp-${process.pid}`);
      writeFileSync(sentinel, "host-visible", { mode: 0o600 });
      directories.push(sentinel);
      const result = spawnSync(
        DEFAULT_BWRAP_PATH,
        buildBubblewrapLaunch({
          executable: "/bin/sh",
          args: ["-c", 'test ! -r "$1" && printf confined', "sh", sentinel],
          boundRoot,
          temporaryDirectory: "/tmp",
          networkEgress: "none",
        }).args,
        { encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("confined");
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "still launches a Plan command after installing the process-deny filter",
    () => {
      const { boundRoot, temporaryDirectory } = fixture();
      const launch = buildBubblewrapLaunch({
        executable: "/bin/true",
        args: [],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        writeBoundRoot: false,
        allowProcessExec: false,
        allowProcessFork: false,
      });
      const result = spawnSync(launch.command, [...launch.args], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "blocks a Plan subshell from forking after the command has started",
    () => {
      const { boundRoot, temporaryDirectory } = fixture();
      const launch = buildBubblewrapLaunch({
        executable: "/bin/sh",
        args: ["-c", "printf parent; (printf nested)"],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        writeBoundRoot: false,
        allowProcessExec: false,
        allowProcessFork: false,
      });
      const result = spawnSync(launch.command, [...launch.args], { encoding: "utf8" });
      expect(result.stdout).toContain("parent");
      expect(result.stdout).not.toContain("nested");
      expect(result.status).not.toBe(0);
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "leaves a confined process no capability to remount, unmount, or write through a read-only bind",
    () => {
      const { boundRoot, temporaryDirectory } = fixture();
      const sentinel = join(boundRoot, "sentinel");
      const secret = join(boundRoot, "secret");
      writeFileSync(sentinel, "host");
      writeFileSync(secret, "hidden");
      // Measured on bwrap 0.9.0 as uid 0 before capabilities were dropped: the
      // capsule kept every capability, so the remount below made the
      // read-only bind writable and the write reached the host file.
      const launch = buildBubblewrapLaunch({
        executable: "/bin/sh",
        args: [
          "-c",
          [
            "cd /",
            'while read -r key value; do [ "$key" = CapEff: ] && echo "effective=$value"; done < /proc/self/status',
            'mount -o remount,bind,rw "$1" 2>/dev/null && echo remounted',
            'printf escaped 2>/dev/null > "$1/sentinel" && echo wrote',
            'umount "$1/secret" 2>/dev/null && echo unmounted',
            'grep -q hidden "$1/secret" 2>/dev/null && echo revealed',
            "exit 0",
          ].join("\n"),
          "sh",
          boundRoot,
        ],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        writeBoundRoot: false,
        additionalDenyReadPaths: [secret],
      });
      const result = spawnSync(launch.command, [...launch.args], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["effective=0000000000000000"]);
      expect(readFileSync(sentinel, "utf8")).toBe("host");
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "keeps the host kernel's settings read-only while a confined process can still read them",
    () => {
      const { boundRoot, temporaryDirectory } = fixture();
      // `kernel.core_pattern` names a program the host runs as root when any
      // process dumps core, so a writable one is a way out of the capsule.
      const launch = buildBubblewrapLaunch({
        executable: "/bin/sh",
        args: [
          "-c",
          [
            "for key in kernel/core_pattern vm/swappiness; do",
            '  test -w "/proc/sys/$key" && echo "writable $key"',
            "done",
            "test -r /proc/sys/kernel/pid_max && echo readable",
            "exit 0",
          ].join("\n"),
        ],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
      });
      const result = spawnSync(launch.command, [...launch.args], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["readable"]);
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "hides the host's password hashes and private keys while the rest of /etc stays readable",
    () => {
      const { boundRoot, temporaryDirectory } = fixture();
      const launch = buildBubblewrapLaunch({
        executable: "/bin/sh",
        args: [
          "-c",
          [
            "for path in /etc/shadow /etc/gshadow /etc/ssh/ssh_host_*_key /etc/ssl/private/*; do",
            '  [ -s "$path" ] && echo "exposed $path"',
            "done",
            "test -r /etc/passwd && echo passwd",
            "exit 0",
          ].join("\n"),
        ],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
      });
      const result = spawnSync(launch.command, [...launch.args], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["passwd"]);
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "still hides a denied file after a temp cleaner removes the empty file that covered it",
    () => {
      const { boundRoot, temporaryDirectory } = fixture();
      const secret = join(boundRoot, "secret");
      writeFileSync(secret, "hidden");
      const launchReadingSecret = () =>
        buildBubblewrapLaunch({
          executable: "/bin/sh",
          args: ["-c", 'cat "$1" 2>/dev/null; echo end', "sh", secret],
          boundRoot,
          temporaryDirectory,
          networkEgress: "none",
          additionalDenyReadPaths: [secret],
        });
      const first = launchReadingSecret();
      const cover = boundPairs(first.args, "--ro-bind").find(([, target]) => target === secret);
      if (cover === undefined) throw new Error("The denied file was not covered.");
      // systemd-tmpfiles ages out the host /tmp while the server keeps running.
      rmSync(dirname(cover[0]), { recursive: true, force: true });

      const result = spawnSync(DEFAULT_BWRAP_PATH, [...launchReadingSecret().args], {
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("end\n");
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "denies a linked path at its target, and skips one whose target the capsule cannot reach",
    () => {
      const { root, boundRoot, temporaryDirectory } = fixture();
      const shared = join(root, "shared");
      const sharedSecret = join(shared, "token");
      const unbound = join(root, "unbound");
      mkdirSync(shared);
      mkdirSync(unbound);
      writeFileSync(sharedSecret, "hidden");
      writeFileSync(join(unbound, "SKILL.md"), "hidden");
      // Absolute links, as a person makes them: Bubblewrap followed each one
      // from outside the new root and refused the launch with "Can't create
      // file at" before the command started.
      const linkedFile = join(boundRoot, "token");
      const linkedFolder = join(boundRoot, "skills");
      symlinkSync(sharedSecret, linkedFile);
      symlinkSync(unbound, linkedFolder);
      const result = spawnSync(
        DEFAULT_BWRAP_PATH,
        [
          ...buildBubblewrapLaunch({
            executable: "/bin/sh",
            args: [
              "-c",
              'for path in "$@"; do cat "$path" 2>/dev/null; done; echo end',
              "sh",
              linkedFile,
              sharedSecret,
              join(linkedFolder, "SKILL.md"),
            ],
            boundRoot,
            temporaryDirectory,
            networkEgress: "none",
            readRoots: [shared],
            additionalDenyReadPaths: [linkedFile, linkedFolder],
          }).args,
        ],
        { encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("end\n");
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "still hides a denied file under a bound root the launch names through a link",
    () => {
      const { root, temporaryDirectory } = fixture();
      const project = join(root, "real-project");
      const linkedProject = join(root, "linked-project");
      mkdirSync(project);
      writeFileSync(join(project, ".env"), "hidden");
      symlinkSync(project, linkedProject);
      // The bound root keeps the path the launch names, so the denial must
      // land there too, not at the resolved folder the capsule never sees.
      const secret = join(linkedProject, ".env");
      const result = spawnSync(
        DEFAULT_BWRAP_PATH,
        [
          ...buildBubblewrapLaunch({
            executable: "/bin/sh",
            args: ["-c", 'cat "$1" 2>/dev/null; echo end', "sh", secret],
            boundRoot: linkedProject,
            temporaryDirectory,
            networkEgress: "none",
            additionalDenyReadPaths: [secret],
          }).args,
        ],
        { encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("end\n");
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "hides a relative link that climbs out of a root named through a link where the capsule follows it",
    () => {
      const { root, temporaryDirectory } = fixture();
      // On the host `../shared` climbs out of the resolved project folder; in
      // the capsule it climbs out of the root's linked name and reaches a
      // different, bound folder.
      const elsewhere = join(root, "elsewhere");
      const project = join(elsewhere, "real-project");
      mkdirSync(join(elsewhere, "shared"), { recursive: true });
      mkdirSync(project);
      writeFileSync(join(elsewhere, "shared", "token"), "decoy");
      const shared = join(root, "shared");
      mkdirSync(shared);
      writeFileSync(join(shared, "token"), "hidden");
      const linkedProject = join(root, "linked-project");
      symlinkSync(project, linkedProject);
      symlinkSync("../shared/token", join(project, "token"));
      const denied = join(linkedProject, "token");
      const result = spawnSync(
        DEFAULT_BWRAP_PATH,
        [
          ...buildBubblewrapLaunch({
            executable: "/bin/sh",
            args: ["-c", 'cat "$1" 2>/dev/null; echo end', "sh", denied],
            boundRoot: linkedProject,
            temporaryDirectory,
            networkEgress: "none",
            readRoots: [shared],
            additionalDenyReadPaths: [denied],
          }).args,
        ],
        { encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("end\n");
    },
  );

  it.runIf(process.platform === "linux" && canRunHostBwrap())(
    "keeps a write-denied link to a missing file from being written through",
    () => {
      const { boundRoot, temporaryDirectory } = fixture();
      mkdirSync(join(boundRoot, "shared"));
      const denied = join(boundRoot, ".mcp.json");
      symlinkSync("shared/mcp.json", denied);
      const result = spawnSync(
        DEFAULT_BWRAP_PATH,
        [
          ...buildBubblewrapLaunch({
            executable: "/bin/sh",
            args: [
              "-c",
              '{ echo planted > "$1"; } 2>/dev/null && echo written; echo end',
              "sh",
              denied,
            ],
            boundRoot,
            temporaryDirectory,
            networkEgress: "none",
            additionalDenyWritePaths: [denied],
          }).args,
        ],
        { encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("end\n");
    },
  );

  it("makes a new cover for a denied file when other users could change the old one", () => {
    const { boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const secret = join(boundRoot, "secret");
    writeFileSync(secret, "hidden");
    const coverOf = () =>
      boundPairs(
        buildBubblewrapLaunch(
          {
            executable: "/bin/sh",
            args: [],
            boundRoot,
            temporaryDirectory,
            networkEgress: "none",
            additionalDenyReadPaths: [secret],
          },
          { bwrapPath },
        ).args,
        "--ro-bind",
      ).find(([, target]) => target === secret)?.[0];
    const first = coverOf();
    if (first === undefined) throw new Error("The denied file was not covered.");
    // A cleaner can remove the folder, and another user can then make one of
    // the same name, open to them, in the shared temp directory.
    chmodSync(dirname(first), 0o777);

    const second = coverOf();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("keeps a proxied launch in its private network and starts it behind the forwarder", () => {
    const { root, boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const sockets = join(root, "egress-launch");
    mkdirSync(sockets, { mode: 0o700 });
    const socket = join(sockets, "proxy.sock");
    const runtimeDirectory = join(root, "runtime");
    mkdirSync(runtimeDirectory);
    const runtime = join(runtimeDirectory, "node");

    const launch = buildBubblewrapLaunch(
      {
        executable: "/bin/sh",
        args: ["/scripts/command.sh"],
        boundRoot,
        temporaryDirectory,
        networkEgress: { kind: "proxied", endpoint: { kind: "unix-socket", path: socket } },
      },
      { bwrapPath, forwarderRuntime: runtime },
    );

    expect(launch.args).toContain("--unshare-all");
    expect(launch.args).not.toContain("--share-net");
    expect(boundPairs(launch.args, "--ro-bind")).not.toContainEqual([
      "/run/systemd/resolve",
      "/run/systemd/resolve",
    ]);
    expect(boundPairs(launch.args, "--ro-bind")).toContainEqual([sockets, sockets]);
    expect(boundPairs(launch.args, "--bind")).not.toContainEqual([sockets, sockets]);
    const forwarder = join(sockets, "forwarder.cjs");
    expect(launch.args.slice(launch.args.indexOf("--") + 1)).toEqual([
      runtime,
      "--no-warnings",
      forwarder,
      socket,
      String(LINUX_EGRESS_FORWARDER_PORT),
      "/bin/sh",
      "/scripts/command.sh",
    ]);
    expect(readFileSync(forwarder, "utf8")).toBe(LINUX_EGRESS_FORWARDER_SOURCE);
  });

  it("refuses a proxied launch without its socket, or one that may not start a process", () => {
    const { root, boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const socket = join(root, "proxy.sock");
    for (const input of [
      { networkEgress: { kind: "proxied", endpoint: { kind: "loopback", port: 3128 } } },
      { networkEgress: { kind: "proxied", endpoint: { kind: "unix-socket", path: "proxy.sock" } } },
      {
        networkEgress: { kind: "proxied", endpoint: { kind: "unix-socket", path: socket } },
        allowProcessFork: false,
      },
    ] as const) {
      expect(() =>
        buildBubblewrapLaunch(
          { executable: "/bin/true", args: [], boundRoot, temporaryDirectory, ...input },
          { bwrapPath },
        ),
      ).toThrow(ProcessConfinementError);
    }
  });

  it("starts an interactive shell on Linux without any Seatbelt rules", () => {
    const { root, boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const shellStateDirectory = join(root, "shell-state");
    mkdirSync(shellStateDirectory);
    const launch = buildBubblewrapLaunch(
      {
        executable: "/bin/bash",
        args: ["-l"],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
        terminal: { shellStateDirectory },
      },
      { bwrapPath },
    );

    expect(launch.command).toBe(bwrapPath);
    // Measured on bwrap 0.6.1: `--new-session` setsid()s the shell off its
    // pty, so job control dies ("no job control in this shell", `fg` refuses).
    expect(launch.args).not.toContain("--new-session");
    expect(launch.args).toContain("--dev");

    const nonTerminal = buildBubblewrapLaunch(
      {
        executable: "/bin/bash",
        args: ["-l"],
        boundRoot,
        temporaryDirectory,
        networkEgress: "none",
      },
      { bwrapPath },
    );
    expect(nonTerminal.args).toContain("--new-session");
  });

  it("still refuses raw Seatbelt rules on Linux even for a terminal", () => {
    const { root, boundRoot, temporaryDirectory, bwrapPath } = fixture();
    const shellStateDirectory = join(root, "shell-state");
    mkdirSync(shellStateDirectory);
    expect(() =>
      buildBubblewrapLaunch(
        {
          executable: "/bin/bash",
          args: ["-l"],
          boundRoot,
          temporaryDirectory,
          networkEgress: "none",
          terminal: { shellStateDirectory },
          extraRules: ["(allow pseudo-tty)"],
        },
        { bwrapPath },
      ),
    ).toThrow(ProcessConfinementError);
  });
});

function hasFlagValue(args: ReadonlyArray<string>, flag: string, value: string): boolean {
  for (const [index, arg] of args.entries()) {
    if (arg === flag && args[index + 1] === value) return true;
  }
  return false;
}

function tmpfsTargets(args: ReadonlyArray<string>): string[] {
  const targets: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg === "--tmpfs") {
      const target = args[index + 1];
      if (target !== undefined) targets.push(target);
    }
  }
  return targets;
}

function boundPairs(
  args: ReadonlyArray<string>,
  flag: "--bind" | "--ro-bind",
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [index, arg] of args.entries()) {
    if (arg !== flag) continue;
    const source = args[index + 1];
    const target = args[index + 2];
    if (source !== undefined && target !== undefined) pairs.push([source, target]);
  }
  return pairs;
}
