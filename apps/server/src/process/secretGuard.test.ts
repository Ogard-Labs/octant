import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NO_PROTECTED_FILES_CHANGES } from "@octant/domain/secret-guard-policy";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProtectedFilesChoice,
  configureSecretGuardLocations,
  isProtectedSecretPath,
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

  it("answers Shield for a home-relative path, a path the person added, and none for a relative one", () => {
    const home = fakeHome();
    const options = { platform: "darwin" as const, homeDirectory: home };
    expect(isProtectedSecretPath("~/.aws/credentials", options)).toBe(true);
    expect(isProtectedSecretPath("$HOME/.ssh/github_ed25519", options)).toBe(true);
    expect(isProtectedSecretPath("~/.aws/config", options)).toBe(false);
    expect(isProtectedSecretPath(".aws/credentials", options)).toBe(false);
    expect(isProtectedSecretPath(join(home, "project/readme.md"), options)).toBe(false);
    applyProtectedFilesChoice({ added: ["~/project/readme.md"], removed: [] });
    expect(isProtectedSecretPath(join(home, "project/readme.md"), options)).toBe(true);
  });

  it("refuses a search above a protected file and allows one beside it", () => {
    const home = fakeHome();
    const options = { platform: "darwin" as const, homeDirectory: home };
    const mixed = secretGuardSearchRefusal(join(home, ".aws"), options);
    expect(mixed).toContain("This search would read it");
    expect(mixed).toContain(JSON.stringify(join(home, ".aws")));
    expect(mixed).toContain("no search results were returned");
    expect(mixed).toContain("ordinary subfolder");
    expect(mixed).toContain("Cloud command-line credentials");
    expect(secretGuardSearchRefusal(home, options)).toContain("Refused");
    expect(secretGuardSearchRefusal(join(home, "project"), options)).toBeUndefined();
  });

  it("refuses a search rooted inside a browser profile whose stores the list names by pattern", () => {
    const home = fakeHome();
    const profile = join(home, ".config/google-chrome/Default");
    mkdirSync(join(profile, "Network"), { recursive: true });
    writeFileSync(join(profile, "Network/Cookies"), "fake");
    writeFileSync(join(profile, "Preferences"), "{}");
    const options = { platform: "linux" as const, homeDirectory: home };
    expect(secretGuardSearchRefusal(profile, options)).toContain(
      "Browser cookies and saved logins",
    );
    expect(secretGuardSearchRefusal(join(home, ".config/nvim"), options)).toBeUndefined();
  });

  it("refuses a search when checking it for pattern-named stores could not finish", () => {
    const home = fakeHome();
    const crowded = join(home, ".config/crowded");
    mkdirSync(crowded, { recursive: true });
    for (let index = 0; index < 5_000; index += 1) writeFileSync(join(crowded, `f${index}`), "");
    const refusal = secretGuardSearchRefusal(crowded, { platform: "linux", homeDirectory: home });
    expect(refusal).toContain("could not finish");
  });
});

describe("secret guard on a Windows host", () => {
  const options = { platform: "win32" as const, homeDirectory: "C:\\Users\\Person" };

  it("refuses Windows credential stores and home secrets named by drive-absolute paths", () => {
    expect(
      secretGuardRefusal(
        "C:\\Users\\Person\\AppData\\Roaming\\Microsoft\\Credentials\\A1",
        options,
      ),
    ).toContain("Keychains and password vaults");
    expect(secretGuardRefusal("C:\\Users\\Person\\.aws\\credentials", options)).toContain(
      "~/.aws/credentials",
    );
    expect(secretGuardRefusal("c:/users/person/.ssh/ID_RSA.", options)).toContain(
      "SSH private keys",
    );
    expect(secretGuardRefusal("C:\\Users\\Person\\project\\README.md", options)).toBeUndefined();
    expect(isProtectedSecretPath("~/.aws/credentials", options)).toBe(true);
  });

  it("refuses a share, device, drive-relative, or driveless rooted path instead of letting it through", () => {
    for (const path of [
      "\\\\localhost\\c$\\Users\\Person\\.aws\\credentials",
      "\\\\?\\C:\\Users\\Person\\.aws\\credentials",
      "C:.aws\\credentials",
      "\\Users\\Person\\.aws\\credentials",
    ]) {
      expect(secretGuardRefusal(path, options), path).toContain("drive-absolute");
    }
    expect(secretGuardRefusal("project\\README.md", options)).toBeUndefined();
  });

  it("refuses every path when the home folder cannot be placed", () => {
    expect(
      secretGuardRefusal("C:\\work\\README.md", {
        platform: "win32",
        homeDirectory: "\\\\server\\profiles\\Person",
      }),
    ).toContain("home folder");
  });

  it("refuses a search rooted at or above a protected location even before the file exists", () => {
    expect(secretGuardSearchRefusal("C:\\Users\\Person", options)).toContain(
      "This search would read it",
    );
    expect(secretGuardSearchRefusal("C:\\Users\\Person\\AppData", options)).toContain("Refused");
    expect(secretGuardSearchRefusal("C:\\Users\\Person\\project", options)).toBeUndefined();
  });

  it("refuses a search rooted inside a folder whose stores the list names by pattern", () => {
    for (const root of [
      "C:\\Users\\Person\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abc.default",
      "C:\\Users\\Person\\AppData\\Local\\Google\\Chrome\\User Data\\Default",
    ]) {
      expect(secretGuardSearchRefusal(root, options), root).toContain(
        "Browser cookies and saved logins",
      );
    }
  });

  it("shows Windows locations in Settings instead of the Linux ones", () => {
    const shown = secretGuardEntries(options).map((entry) =>
      entry.kind === "path" ? entry.path : entry.directory,
    );
    expect(shown).toContain("/c:/users/person/appdata/roaming/microsoft/credentials");
    expect(shown).not.toContain("/c:/users/person/.local/share/keyrings");
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
