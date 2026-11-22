import { describe, expect, it } from "vitest";
import type { ResolvedProtectedEntry } from "@octant/domain/secret-guard-policy";
import { codexWindowsStrictProfile, guardNameGlobs } from "./codexWindowsStrictSandbox";

const entry = (
  fields: Partial<ResolvedProtectedEntry> & Pick<ResolvedProtectedEntry, "kind">,
): ResolvedProtectedEntry =>
  ({
    ruleId: "added",
    label: "Test store",
    channel: "none",
    ownAccountExempt: false,
    foldCase: true,
    ...fields,
  }) as ResolvedProtectedEntry;

describe("Windows Strict profile for Codex's own sandbox", () => {
  it("names each guard file pattern as the globs Codex's Windows sandbox matches", () => {
    expect(guardNameGlobs("identity")).toEqual(["identity"]);
    expect(guardNameGlobs("[^/]*\\.secret")).toEqual(["*.secret"]);
    expect(guardNameGlobs("(cookies\\.sqlite|key[34]\\.db)(-wal)?")).toEqual([
      "cookies.sqlite",
      "cookies.sqlite-wal",
      "key[34].db",
      "key[34].db-wal",
    ]);
    // The browser store pattern the guard ships, with a space in one name.
    expect(
      guardNameGlobs(
        "(Cookies|Login Data|Login Data For Account|Web Data|Safe Browsing Cookies)(-journal|-wal|-shm)?",
      ),
    ).toHaveLength(20);
  });

  it("refuses a pattern its globs cannot carry rather than dropping it", () => {
    for (const pattern of ["a+", "a{2}", "[^x]", "x*", "a,b", "\\d", "(a"]) {
      expect(guardNameGlobs(pattern)).toBeUndefined();
    }
  });

  it("denies every store, one glob per depth, and the account's own sign-in", () => {
    const prepared = codexWindowsStrictProfile({
      writableRoots: ["C:\\Work\\repo"],
      protectedEntries: [
        entry({ kind: "path", path: "/c:/users/ada/.aws/credentials" }),
        entry({
          kind: "names",
          directory: "/c:/users/ada/appdata/local",
          name: "Cookies",
          depth: 2,
        }),
        entry({
          kind: "names",
          directory: "/c:/users/ada/.ssh",
          name: "id_[^/]*",
          depth: 2,
          except: "[^/]*\\.pub",
        }),
      ],
      codexHome: "C:\\Users\\Ada\\.codex",
      networkOpen: true,
    });
    expect(prepared).toEqual({
      status: "ready",
      profile: {
        extends: ":workspace",
        filesystem: {
          "C:\\Work\\repo": "write",
          "C:\\users\\ada\\.aws\\credentials": "deny",
          "C:\\users\\ada\\appdata\\local\\Cookies": "deny",
          "C:\\users\\ada\\appdata\\local\\*\\Cookies": "deny",
          "C:\\users\\ada\\.ssh": "deny",
          "C:\\users\\ada\\.codex\\auth.json": "deny",
        },
        network: { enabled: true },
      },
    });
  });

  it("denies the siblings of a Codex home that lives inside a protected folder, not the home itself", () => {
    const listings: Record<string, ReadonlyArray<string>> = {
      "C:\\users\\ada\\appdata\\roaming\\octant\\providers": ["codex-work", "claude-work"],
    };
    const prepared = codexWindowsStrictProfile({
      writableRoots: [],
      protectedEntries: [
        entry({ kind: "path", path: "/c:/users/ada/appdata/roaming/octant/providers" }),
      ],
      codexHome: "C:\\Users\\Ada\\AppData\\Roaming\\Octant\\providers\\codex-work",
      networkOpen: false,
      listDirectory: (path) => listings[path] ?? [],
    });
    expect(prepared).toMatchObject({
      status: "ready",
      profile: {
        filesystem: {
          "C:\\users\\ada\\appdata\\roaming\\octant\\providers\\claude-work": "deny",
          "C:\\users\\ada\\appdata\\roaming\\octant\\providers\\codex-work\\auth.json": "deny",
        },
      },
    });
    if (prepared.status === "ready") {
      expect(prepared.profile.filesystem).not.toHaveProperty(
        "C:\\users\\ada\\appdata\\roaming\\octant\\providers",
      );
      expect(prepared.profile).not.toHaveProperty("network");
    }
  });

  it("refuses when a protected folder around the Codex home cannot be listed", () => {
    expect(
      codexWindowsStrictProfile({
        writableRoots: [],
        protectedEntries: [entry({ kind: "path", path: "/c:/users/ada/providers" })],
        codexHome: "C:\\Users\\Ada\\providers\\codex",
        networkOpen: false,
        listDirectory: () => {
          throw new Error("EACCES");
        },
      }),
    ).toMatchObject({ status: "refused" });
  });
});
