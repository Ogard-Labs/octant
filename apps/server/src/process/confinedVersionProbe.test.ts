import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareConfinedVersionProbe } from "./confinedVersionProbe";
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

  it("takes the scratch directory away when the caller releases the launch", () => {
    const target = host();
    const launch = prepared(target);
    expect(existsSync(launch.workingDirectory)).toBe(true);

    launch.release();

    expect(existsSync(launch.workingDirectory)).toBe(false);
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
});
