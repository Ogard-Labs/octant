import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NO_PROTECTED_FILES_CHANGES } from "@octant/domain/secret-guard-policy";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProtectedFilesChoice,
  configureSecretGuardLocations,
  secretGuardEntries,
  secretGuardLinuxPaths,
  secretGuardRefusal,
  secretGuardSearchRefusal,
} from "./secretGuard";
import { buildDenyDefaultSeatbeltProfile, makeProcessConfinementLive } from "./seatbeltProfile";

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

describe("secret guard on the launch builders", () => {
  it("adds the person's own paths and drops a removed group", () => {
    const home = fakeHome();
    applyProtectedFilesChoice({ added: ["~/project/notes"], removed: ["ssh-private-keys"] });
    const profile = buildDenyDefaultSeatbeltProfile({
      boundRoot: join(home, "project"),
      temporaryDirectory: join(home, "project"),
      networkEgress: "none",
      homeDirectory: home,
      usersDirectory: dirname(home),
      privateHomeAllowPaths: [],
    });
    expect(profile).toContain(`(subpath "${join(home, "project/notes")}")`);
    expect(profile).not.toContain(join(home, ".ssh/id_"));
  });

  it("offers no minimal Full access launch: Full access is not wrapped", () => {
    expect(makeProcessConfinementLive()).not.toHaveProperty("guardSecrets");
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

describe("secret guard refusals for host file tools", () => {
  it("refuses a protected file named through the target of a linked folder", () => {
    const home = fakeHome();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "octant-secret-elsewhere-")));
    directories.push(elsewhere);
    mkdirSync(join(elsewhere, "aws"));
    writeFileSync(join(elsewhere, "aws", "credentials"), "fake");
    rmSync(join(home, ".aws"), { recursive: true, force: true });
    symlinkSync(join(elsewhere, "aws"), join(home, ".aws"));
    for (const path of [join(home, ".aws/credentials"), join(elsewhere, "aws/credentials")]) {
      expect(secretGuardRefusal(path, { platform: "darwin", homeDirectory: home }), path).toContain(
        "Cloud command-line credentials",
      );
    }
    expect(
      secretGuardSearchRefusal(join(elsewhere, "aws"), { platform: "darwin", homeDirectory: home }),
    ).toContain("Cloud command-line credentials");
  });

  it("refuses a search above a protected file and allows one beside it", () => {
    const home = fakeHome();
    const options = { platform: "darwin" as const, homeDirectory: home };
    expect(secretGuardSearchRefusal(join(home, ".aws"), options)).toContain(
      "This search would read it",
    );
    expect(secretGuardSearchRefusal(home, options)).toContain("Refused");
    expect(secretGuardSearchRefusal(join(home, "project"), options)).toBeUndefined();
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
