import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildLinuxConfinementLaunch, DEFAULT_BWRAP_PATH } from "./linuxConfinement";
import { SeatbeltConfinementError } from "./seatbeltProfile";

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

describe("Linux Bubblewrap confinement", () => {
  it("uses a private tmpfs for /tmp instead of binding the host directory", () => {
    const { boundRoot, bwrapPath } = fixture();
    const launch = buildLinuxConfinementLaunch(
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
    const launch = buildLinuxConfinementLaunch(
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
    const launch = buildLinuxConfinementLaunch(
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
    const launch = buildLinuxConfinementLaunch(
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
  });

  it("fails closed when bubblewrap is missing", () => {
    const { boundRoot, temporaryDirectory, root } = fixture();
    expect(() =>
      buildLinuxConfinementLaunch(
        {
          executable: "/bin/true",
          args: [],
          boundRoot,
          temporaryDirectory,
          networkEgress: "none",
        },
        { bwrapPath: join(root, "missing-bwrap") },
      ),
    ).toThrow(SeatbeltConfinementError);
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
        buildLinuxConfinementLaunch({
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
