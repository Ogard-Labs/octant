import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createArchiveArgv,
  createCodesignArgv,
  createNotarizeArgv,
  createStapleArgv,
  createVerifyArgv,
  ENTITLEMENTS_PATH,
  requireSigned,
  resolveSigningCredentials,
  signAndNotarizeDesktop,
  SIGNING_ORDER,
} from "./sign-desktop";
import { signPackagedDesktop } from "./package-desktop";

const credentials = {
  OCTANT_SIGNING_IDENTITY: "Developer ID Application: Example (TEAMID1234)",
  OCTANT_NOTARY_PROFILE: "octant-notary",
  OCTANT_SIGNING_TEAM_ID: "TEAMID1234",
};

describe("resolveSigningCredentials", () => {
  it("reads the identity, notary profile, and team from the environment", () => {
    const resolution = resolveSigningCredentials(credentials);

    expect(resolution.kind).toBe("available");
    expect(resolution.kind === "available" ? resolution.credentials.teamId : undefined).toBe(
      "TEAMID1234",
    );
  });

  it("names exactly what is missing rather than failing vaguely", () => {
    const resolution = resolveSigningCredentials({
      OCTANT_SIGNING_IDENTITY: credentials.OCTANT_SIGNING_IDENTITY,
    });

    expect(resolution).toEqual({
      kind: "absent",
      missing: ["OCTANT_NOTARY_PROFILE", "OCTANT_SIGNING_TEAM_ID"],
    });
  });

  it("treats a blank secret as absent, not as a value", () => {
    // A secret that failed to load arrives as an empty string, and signing with
    // an empty identity would fail far later and less clearly.
    expect(resolveSigningCredentials({ ...credentials, OCTANT_NOTARY_PROFILE: "   " })).toEqual({
      kind: "absent",
      missing: ["OCTANT_NOTARY_PROFILE"],
    });
  });
});

describe("requireSigned", () => {
  it("is a declaration, never inferred from credentials being present", () => {
    // Otherwise a release would quietly become unsigned the day a secret failed
    // to load, which is the failure the flag exists to make loud.
    expect(requireSigned(credentials)).toBe(false);
    expect(requireSigned({ OCTANT_RELEASE_BUILD: "1" })).toBe(true);
    expect(requireSigned({ OCTANT_RELEASE_BUILD: "0" })).toBe(false);
  });
});

describe("signPackagedDesktop", () => {
  it("packages unsigned without credentials, and says which are missing", async () => {
    const run = async () => {
      throw new Error("nothing should be run without credentials");
    };

    const outcome = await signPackagedDesktop({
      repositoryRoot: "/repo",
      appPath: "/repo/out/Octant.app",
      environment: {},
      run,
    });

    expect(outcome).toEqual({
      kind: "unsigned",
      missing: ["OCTANT_SIGNING_IDENTITY", "OCTANT_NOTARY_PROFILE", "OCTANT_SIGNING_TEAM_ID"],
    });
  });

  it("refuses to finish a declared release build that cannot be signed", async () => {
    // An updater needs something to check a replacement against, so an unsigned
    // release is not a lesser release; it is one that cannot be updated.
    await expect(
      signPackagedDesktop({
        repositoryRoot: "/repo",
        appPath: "/repo/out/Octant.app",
        environment: { OCTANT_RELEASE_BUILD: "1" },
        run: async () => undefined,
      }),
    ).rejects.toThrow(/must be signed/);
  });

  it("signs, verifies, notarizes, and staples when credentials are present", async () => {
    const argv: string[][] = [];

    const outcome = await signPackagedDesktop({
      repositoryRoot: "/repo",
      appPath: "/repo/out/Octant.app",
      environment: { ...credentials, OCTANT_RELEASE_BUILD: "1" },
      run: async (command) => void argv.push([...command]),
    });

    expect(outcome.kind).toBe("signed");
    const commands = argv.map((entry) => `${entry[0]} ${entry[1] ?? ""}`.trim());
    expect(commands).toContain("/usr/bin/xcrun notarytool");
    expect(commands).toContain("/usr/bin/xcrun stapler");
    expect(commands).toContain("/usr/bin/ditto -c");
  });
});

describe("signAndNotarizeDesktop", () => {
  async function record() {
    const argv: string[][] = [];
    await signAndNotarizeDesktop({
      repositoryRoot: "/repo",
      appPath: "/repo/out/Octant.app",
      archivePath: "/repo/out/Octant-0.1.0-arm64.zip",
      credentials: { identity: "Developer ID", notaryProfile: "profile", teamId: "TEAM" },
      run: async (command) => void argv.push([...command]),
    });
    return argv;
  }

  it("signs every nested payload before the bundle that contains them", async () => {
    // `codesign` seals a bundle including what is inside it, so a nested binary
    // signed afterwards would invalidate the outer seal.
    const argv = await record();
    const signed = argv
      .filter((command) => command[0] === "/usr/bin/codesign" && command.includes("--sign"))
      .map((command) => command[command.length - 1]);

    expect(signed[signed.length - 1]).toBe("/repo/out/Octant.app");
    for (const nested of SIGNING_ORDER) {
      expect(signed.indexOf(`/repo/out/Octant.app/${nested}`)).toBeLessThan(signed.length - 1);
    }
  });

  it("signs the helpers and native modules, not only the bundle", async () => {
    const argv = await record();
    const signed = argv.map((command) => command[command.length - 1] ?? "");

    for (const payload of [
      "Contents/Resources/native/octant-keychain-helper",
      "Contents/Resources/native/octant-code-file-helper",
      "Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
    ]) {
      expect(signed).toContain(`/repo/out/Octant.app/${payload}`);
    }
  });

  it("verifies the finished bundle rather than trusting exit codes", async () => {
    const argv = await record();

    expect(argv.some((command) => command.includes("--verify"))).toBe(true);
  });

  it("waits for notarization instead of stapling a ticket that may not exist", async () => {
    const argv = await record();
    const notarize = argv.find((command) => command.includes("notarytool"));

    expect(notarize).toContain("--wait");
    const notarizeIndex = argv.findIndex((command) => command.includes("notarytool"));
    const stapleIndex = argv.findIndex((command) => command.includes("stapler"));
    expect(stapleIndex).toBeGreaterThan(notarizeIndex);
  });
});

describe("hardened runtime entitlements", () => {
  it("grants only what Octant cannot run without", async () => {
    const plist = await readFile(new URL(`../${ENTITLEMENTS_PATH}`, import.meta.url), "utf8");

    expect(plist).toContain("com.apple.security.cs.allow-jit");
    expect(plist).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    // An entitlement is a permanent widening of what the notarized build may
    // do; these two are the usual reflexive additions and neither is needed.
    expect(plist).not.toMatch(/<key>com\.apple\.security\.cs\.disable-library-validation<\/key>/);
    expect(plist).not.toMatch(
      /<key>com\.apple\.security\.cs\.allow-dyld-environment-variables<\/key>/,
    );
  });

  it("signs with the hardened runtime and a trusted timestamp", async () => {
    const argv = createCodesignArgv({
      identity: "Developer ID",
      target: "/repo/out/Octant.app",
      entitlements: "/repo/entitlements.plist",
    });

    // Notarization requires both; without the timestamp the signature stops
    // validating when the certificate expires.
    expect(argv).toContain("runtime");
    expect(argv).toContain("--timestamp");
  });

  it("archives with ditto so symlinks and metadata survive", () => {
    expect(createArchiveArgv({ appPath: "/a/Octant.app", archivePath: "/a/Octant.zip" })).toEqual([
      "/usr/bin/ditto",
      "-c",
      "-k",
      "--keepParent",
      "--sequesterRsrc",
      "/a/Octant.app",
      "/a/Octant.zip",
    ]);
    expect(createVerifyArgv("/a/Octant.app")).toContain("--strict");
    expect(createStapleArgv("/a/Octant.app")).toContain("staple");
    expect(createNotarizeArgv({ archivePath: "/a/Octant.zip", notaryProfile: "p" })).toContain(
      "--keychain-profile",
    );
  });
});
