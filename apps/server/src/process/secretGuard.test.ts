import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NO_PROTECTED_FILES_CHANGES } from "@octant/domain/secret-guard-policy";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProtectedFilesChoice,
  buildSecretGuardSeatbeltProfile,
  configureSecretGuardLocations,
  secretGuardEntries,
  secretGuardLinuxPaths,
} from "./secretGuard";
import {
  buildDenyDefaultSeatbeltProfile,
  makeProcessConfinementLive,
  prepareSecretGuardedLaunch,
  secretGuardedCommandConfinement,
} from "./seatbeltProfile";

const directories: string[] = [];

afterEach(() => {
  applyProtectedFilesChoice(NO_PROTECTED_FILES_CHANGES);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A throwaway home folder with fake secret files beside the files that must
 * stay readable. Nothing here is a real credential.
 */
function fakeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "octant-secret-guard-")));
  directories.push(home);
  const files: Record<string, string> = {
    ".ssh/id_test": "fake private key",
    ".ssh/id_test.pub": "ssh-ed25519 AAAA fake",
    ".ssh/config": "Host example\n  HostName example.invalid\n",
    ".ssh/known_hosts": "example.invalid ssh-ed25519 AAAA\n",
    ".ssh/github_ed25519": "fake private key with a name of its own",
    ".ssh/github_ed25519.pub": "ssh-ed25519 AAAA fake",
    ".aws/credentials": "fake",
    ".aws/config": "[default]\nregion = eu-north-1\n",
    ".npmrc": "fake",
    ".codex/auth.json": "fake codex sign-in",
    ".claude/.credentials.json": "fake claude sign-in",
    "Library/Keychains/login.keychain-db": "fake login keychain",
    "Library/Keychains/other.keychain-db": "fake other keychain",
    "project/readme.md": "project file",
  };
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(home, relative)), { recursive: true });
    writeFileSync(join(home, relative), content);
  }
  return home;
}

function runUnder(launch: { command: string; args: ReadonlyArray<string> }, env = {}) {
  return spawnSync(launch.command, [...launch.args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...env },
  });
}

function guarded(
  home: string,
  executable: string,
  args: ReadonlyArray<string>,
  ownAccountPaths: ReadonlyArray<string> = [],
) {
  return prepareSecretGuardedLaunch(
    { executable, args, cwd: home, ownAccountPaths },
    "darwin",
    "/usr/bin/sandbox-exec",
    { homeDirectory: home },
  );
}

describe("secret guard at Full access", () => {
  it.skipIf(process.platform !== "darwin")(
    "refuses a protected file and leaves SSH config, known_hosts, and public keys readable",
    () => {
      const home = fakeHome();
      const read = (relative: string) =>
        runUnder(guarded(home, "/bin/cat", [join(home, relative)]));
      for (const secret of [
        ".ssh/id_test",
        ".ssh/github_ed25519",
        ".aws/credentials",
        ".npmrc",
        ".codex/auth.json",
        "Library/Keychains/other.keychain-db",
      ]) {
        const result = read(secret);
        expect(result.status, secret).not.toBe(0);
        expect(result.stderr, secret).toContain("Operation not permitted");
      }
      for (const open of [
        ".ssh/config",
        ".ssh/known_hosts",
        ".ssh/id_test.pub",
        ".aws/config",
        "Library/Keychains/login.keychain-db",
        "project/readme.md",
      ]) {
        expect(read(open).status, open).toBe(0);
      }
      const write = runUnder(
        guarded(home, "/bin/sh", ["-c", `printf x > '${join(home, ".ssh/id_new")}'`]),
      );
      expect(write.status).not.toBe(0);
      expect(existsSync(join(home, ".ssh/id_new"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "lets a runtime read its own sign-in and no other runtime's",
    () => {
      const home = fakeHome();
      const own = [join(home, ".codex")];
      expect(
        runUnder(guarded(home, "/bin/cat", [join(home, ".codex/auth.json")], own)).stdout,
      ).toBe("fake codex sign-in");
      expect(
        runUnder(guarded(home, "/bin/cat", [join(home, ".claude/.credentials.json")], own)).status,
      ).not.toBe(0);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps a managed account home readable inside Octant's denied account folder",
    () => {
      const home = fakeHome();
      const data = join(home, "Library/Application Support/Octant");
      for (const account of ["codex/a", "codex/b"]) {
        mkdirSync(join(data, "providers", account), { recursive: true });
        writeFileSync(join(data, "providers", account, "auth.json"), `fake ${account}`);
      }
      configureSecretGuardLocations({ dataDirectory: data });
      const own = [join(data, "providers/codex/a")];
      expect(
        runUnder(guarded(home, "/bin/cat", [join(data, "providers/codex/a/auth.json")], own))
          .stdout,
      ).toBe("fake codex/a");
      expect(
        runUnder(guarded(home, "/bin/cat", [join(data, "providers/codex/b/auth.json")], own))
          .status,
      ).not.toBe(0);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "runs Git, and SSH through the agent socket, with the private key refused",
    async () => {
      const home = fakeHome();
      const key = join(home, ".ssh/id_agent");
      expect(
        spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]).status,
      ).toBe(0);
      const socket = join(home, ".ssh/agent.sock");
      const agent = spawn("/usr/bin/ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
      try {
        for (let attempt = 0; attempt < 50 && !existsSync(socket); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const env = { HOME: home, SSH_AUTH_SOCK: socket };
        expect(spawnSync("/usr/bin/ssh-add", [key], { env, encoding: "utf8" }).status).toBe(0);
        const listed = runUnder(guarded(home, "/usr/bin/ssh-add", ["-l"]), env);
        expect(listed.status).toBe(0);
        expect(listed.stdout).toContain("ED25519");
        expect(runUnder(guarded(home, "/bin/cat", [key]), env).status).not.toBe(0);
        // `ssh` finds its configuration through the account database, not
        // `HOME`, so the fake home's file is named.
        const config = runUnder(
          guarded(home, "/usr/bin/ssh", ["-F", join(home, ".ssh/config"), "-G", "example"]),
          env,
        );
        expect(config.stdout).toContain("hostname example.invalid");
        const repository = join(home, "project");
        const git = runUnder(
          guarded(home, "/bin/sh", [
            "-c",
            `cd '${repository}' && git init -q && git add readme.md && git -c user.name=t -c user.email=t@example.invalid commit -qm one && git log --oneline | wc -l`,
          ]),
          { HOME: home },
        );
        expect(git.stderr).toBe("");
        expect(git.stdout.trim()).toBe("1");
      } finally {
        agent.kill();
      }
    },
  );

  it("gives an Octant Harness Full access command the secret guard and nothing else", () => {
    const home = fakeHome();
    const port = secretGuardedCommandConfinement(
      makeProcessConfinementLive({
        platform: "darwin",
        sandboxPath: "/usr/bin/sandbox-exec",
        homeDirectory: home,
      }),
    );
    const launch = port.prepare({
      executable: "/bin/cat",
      args: [join(home, ".ssh/id_test")],
      boundRoot: join(home, "project"),
      temporaryDirectory: join(home, "project"),
      networkEgress: "none",
    });
    const profile = launch.args[1] ?? "";
    expect(profile).toContain("(allow default)");
    expect(profile).not.toContain("(deny default)");
    expect(profile).not.toContain("network");
    if (process.platform === "darwin") {
      expect(runUnder(launch).status).not.toBe(0);
    }
    expect(() =>
      secretGuardedCommandConfinement({
        prepare: () => ({ command: "/bin/cat", args: [] }),
      }).prepare({
        executable: "/bin/cat",
        args: [],
        boundRoot: home,
        temporaryDirectory: home,
        networkEgress: "allow",
      }),
    ).toThrow("secret guard");
  });

  it("adds the person's own paths and drops a removed group", () => {
    const home = fakeHome();
    applyProtectedFilesChoice({ added: ["~/project/notes"], removed: ["ssh-private-keys"] });
    const entries = secretGuardEntries({ platform: "darwin", homeDirectory: home });
    const profile = buildSecretGuardSeatbeltProfile({ entries, ownAccountPaths: [] });
    expect(profile).toContain(`(subpath "${join(home, "project/notes")}")`);
    expect(profile).not.toContain(".ssh");
  });

  it("launches unwrapped only when the person removed every protected group", () => {
    const home = fakeHome();
    applyProtectedFilesChoice({
      added: [],
      removed: [
        "ssh-private-keys",
        "cloud-credentials",
        "cluster-configuration",
        "container-registry-sign-in",
        "package-registry-tokens",
        "git-credential-files",
        "forge-cli-sign-in",
        "keychains-and-vaults",
        "browser-cookies-and-logins",
        "octant-credentials",
        "provider-sign-ins",
      ],
    });
    expect(guarded(home, "/bin/echo", ["ok"])).toEqual({ command: "/bin/echo", args: ["ok"] });
  });
});

describe("secret guard below Full access", () => {
  it.skipIf(process.platform !== "darwin")(
    "denies a protected file inside a home folder opened as the Project",
    () => {
      const home = fakeHome();
      const profile = buildDenyDefaultSeatbeltProfile({
        boundRoot: home,
        temporaryDirectory: join(home, "project"),
        networkEgress: "none",
        allowFileReadStar: true,
        homeDirectory: home,
        usersDirectory: dirname(home),
        privateHomeAllowPaths: [],
      });
      const read = (relative: string) =>
        spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", join(home, relative)], {
          encoding: "utf8",
          cwd: home,
        });
      expect(read(".ssh/id_test").status).not.toBe(0);
      expect(read(".aws/credentials").status).not.toBe(0);
      expect(read(".ssh/config").status).toBe(0);
      expect(read("Library/Keychains/login.keychain-db").status).toBe(0);
      expect(read("Library/Keychains/other.keychain-db").status).not.toBe(0);
    },
  );

  it("never re-opens the login keychain for a launch that was not granted its folder", () => {
    const home = fakeHome();
    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: join(home, "project"),
      temporaryDirectory: join(home, "project"),
      networkEgress: "none",
      homeDirectory: home,
      usersDirectory: dirname(home),
      privateHomeAllowPaths: [],
    });
    expect(profile).toMatch(/\(deny file-read\* file-write\* \(regex #"[^\n]*Library\/Keychains/u);
    expect(profile).not.toMatch(/\(allow [^\n]*keychain-db/u);
  });
});

describe("secret guard on Linux", () => {
  it("covers the protected files that exist and skips the ones that do not", () => {
    const home = fakeHome();
    const paths = secretGuardLinuxPaths({
      entries: secretGuardEntries({ platform: "linux", homeDirectory: home }),
      ownAccountPaths: [join(home, ".codex")],
    });
    expect(paths).toEqual(
      expect.arrayContaining([
        join(home, ".ssh/id_test"),
        join(home, ".ssh/github_ed25519"),
        join(home, ".aws/credentials"),
        join(home, ".npmrc"),
        join(home, ".claude/.credentials.json"),
      ]),
    );
    expect(paths).not.toContain(join(home, ".ssh/config"));
    expect(paths).not.toContain(join(home, ".ssh/id_test.pub"));
    expect(paths).not.toContain(join(home, ".codex/auth.json"));
    expect(paths).not.toContain(join(home, ".kube/config"));
  });

  it("covers every other account home and keeps the runtime's own one visible", () => {
    const home = fakeHome();
    const data = join(home, ".local/share/octant");
    for (const account of ["codex/a", "codex/b", "claude/c"]) {
      mkdirSync(join(data, "providers", account), { recursive: true });
    }
    configureSecretGuardLocations({ dataDirectory: data });
    const paths = secretGuardLinuxPaths({
      entries: secretGuardEntries({ platform: "linux", homeDirectory: home }),
      ownAccountPaths: [join(data, "providers/codex/a")],
    });
    expect(paths).toEqual(
      expect.arrayContaining([join(data, "providers/codex/b"), join(data, "providers/claude")]),
    );
    expect(paths.some((path) => path.startsWith(join(data, "providers/codex/a")))).toBe(false);
  });
});
