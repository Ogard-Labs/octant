import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_LANGUAGE_SERVER_SIGNING_PATH,
  createArchiveArgv,
  createCodesignArgv,
  createNotarizationLogArgv,
  createNotarizeArgv,
  createStapleArgv,
  createVerifyArgv,
  ENTITLEMENTS_PATH,
  findMachOFiles,
  MANAGED_TOOLS_PATH,
  parseNotarizationSubmission,
  requireSigned,
  resolveSigningCredentials,
  signAndNotarizeDesktop,
  SIGNING_ORDER,
} from "./sign-desktop";
import { PACKAGED_EXECUTABLE_FILES, signPackagedDesktop } from "./package-desktop";

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
      runForOutput: async () => {
        throw new Error("nothing should be run without credentials");
      },
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
        runForOutput: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
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
      runForOutput: async (command) => {
        argv.push([...command]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "submission-id", status: "Accepted" }),
          stderr: "",
        };
      },
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
      runForOutput: async (command) => {
        argv.push([...command]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "submission-id", status: "Accepted" }),
          stderr: "",
        };
      },
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
      "Contents/Resources/native/octant-device-helper",
      "Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
    ]) {
      expect(signed).toContain(`/repo/out/Octant.app/${payload}`);
    }
  });

  it("signs the bundled language server with the hardened runtime and no entitlements before sealing the app", async () => {
    // Notarization refuses an executable in the bundle that lacks a Developer
    // ID signature, the hardened runtime, or a timestamp.
    const argv = await record();
    const signed = argv.filter(
      (command) => command[0] === "/usr/bin/codesign" && command.includes("--sign"),
    );
    const targets = signed.map((command) => command[command.length - 1]);
    const languageServer = `/repo/out/Octant.app/${BUNDLED_LANGUAGE_SERVER_SIGNING_PATH}`;
    const index = targets.indexOf(languageServer);

    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(targets.indexOf("/repo/out/Octant.app"));
    expect(signed[index]).toEqual(
      expect.arrayContaining(["--sign", "Developer ID", "--options", "runtime", "--timestamp"]),
    );
    expect(signed[index]).not.toContain("--entitlements");
    // The path signed is the one packaging ships and checks as executable.
    expect(PACKAGED_EXECUTABLE_FILES.map((path) => `Contents/Resources/${path}`)).toContain(
      BUNDLED_LANGUAGE_SERVER_SIGNING_PATH,
    );
  });

  it("signs the crash reporter before sealing its framework", async () => {
    const argv = await record();
    const framework = "/repo/out/Octant.app/Contents/Frameworks/Electron Framework.framework";
    const crashpad = `${framework}/Versions/A/Helpers/chrome_crashpad_handler`;
    const index = argv.findIndex(
      (command) => command.includes("--sign") && command.includes(crashpad),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(argv[index]).toEqual(
      expect.arrayContaining(["--sign", "Developer ID", "--timestamp", "--options", "runtime"]),
    );
    expect(index).toBeLessThan(
      argv.findIndex((command) => command.includes("--sign") && command.includes(framework)),
    );
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

  it("re-creates the published archive after the ticket is stapled", async () => {
    // The ticket lives inside the bundle, so an archive created before the
    // staple ships an app that has to reach Apple before it can launch.
    const argv = await record();
    const stapleIndex = argv.findIndex((command) => command.includes("stapler"));
    const archiveIndexes = argv
      .map((command, index) => ({ command, index }))
      .filter((entry) => entry.command[0] === "/usr/bin/ditto")
      .map((entry) => entry.index);

    expect(stapleIndex).toBeGreaterThanOrEqual(0);
    expect(archiveIndexes).toHaveLength(2);
    expect(archiveIndexes[archiveIndexes.length - 1]).toBeGreaterThan(stapleIndex);
  });

  it("prints Apple's issue log and refuses to staple a rejected submission", async () => {
    const argv: string[][] = [];

    await expect(
      signAndNotarizeDesktop({
        repositoryRoot: "/repo",
        appPath: "/repo/out/Octant.app",
        archivePath: "/repo/out/Octant-0.1.0-arm64.zip",
        credentials: { identity: "Developer ID", notaryProfile: "profile", teamId: "TEAM" },
        run: async (command) => void argv.push([...command]),
        runForOutput: async (command) => {
          argv.push([...command]);
          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "rejected-submission", status: "Invalid" }),
            stderr: "",
          };
        },
      }),
    ).rejects.toThrow(/notarization.*Invalid/i);

    expect(argv).toContainEqual(
      createNotarizationLogArgv({
        submissionId: "rejected-submission",
        notaryProfile: "profile",
      }),
    );
    expect(argv.some((command) => command.includes("stapler"))).toBe(false);
  });
});

describe("vendored managed-tool binaries", () => {
  async function appWithManagedTool(): Promise<string> {
    const app = join(await mkdtemp(join(tmpdir(), "octant-sign-")), "Octant.app");
    const tool = join(app, MANAGED_TOOLS_PATH, "serve-sim/dist");
    await mkdir(join(tool, "simcam"), { recursive: true });
    // A Mach-O header is all the scan reads; the rest of the file is irrelevant.
    await writeFile(
      join(tool, "simcam/serve-sim-camera-helper"),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]),
    );
    await writeFile(
      join(tool, "simcam/libSimCameraInjector.dylib"),
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0]),
    );
    await mkdir(join(tool, "native"), { recursive: true });
    await writeFile(join(tool, "native/fat64.node"), Buffer.from([0xca, 0xfe, 0xba, 0xbf, 0]));
    await writeFile(join(tool, "serve-sim.js"), "console.log('not a binary');\n");
    return app;
  }

  it("finds the binaries by content and leaves scripts alone", async () => {
    const app = await appWithManagedTool();
    try {
      const found = await findMachOFiles(join(app, MANAGED_TOOLS_PATH));
      expect(found.map((path) => path.slice(app.length + 1)).sort()).toEqual([
        `${MANAGED_TOOLS_PATH}/serve-sim/dist/native/fat64.node`,
        `${MANAGED_TOOLS_PATH}/serve-sim/dist/simcam/libSimCameraInjector.dylib`,
        `${MANAGED_TOOLS_PATH}/serve-sim/dist/simcam/serve-sim-camera-helper`,
      ]);
      expect(await findMachOFiles(join(app, "missing"))).toEqual([]);
    } finally {
      await rm(join(app, ".."), { recursive: true, force: true });
    }
  });

  it("signs a vendored helper with the hardened runtime and no entitlements before sealing the app", async () => {
    // Notarization rejected the preview build because these kept their
    // upstream ad-hoc signatures: no Developer ID, runtime, or timestamp.
    const app = await appWithManagedTool();
    try {
      const signed: string[][] = [];
      await signAndNotarizeDesktop({
        repositoryRoot: "/repo",
        appPath: app,
        archivePath: `${app}.zip`,
        credentials: { identity: "Developer ID", notaryProfile: "profile", teamId: "TEAM" },
        run: async (command) => {
          if (command.includes("--sign")) signed.push([...command]);
        },
        runForOutput: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ id: "submission-id", status: "Accepted" }),
          stderr: "",
        }),
      });
      const targets = signed.map((command) => command[command.length - 1]);
      const helper = join(app, MANAGED_TOOLS_PATH, "serve-sim/dist/simcam/serve-sim-camera-helper");
      expect(targets.indexOf(helper)).toBeGreaterThanOrEqual(0);
      expect(targets.indexOf(helper)).toBeLessThan(targets.indexOf(app));
      expect(signed[targets.indexOf(helper)]).toEqual(
        expect.arrayContaining(["runtime", "--timestamp"]),
      );
      // No JIT, unsigned-memory, or audio exceptions for a vendored helper.
      expect(signed[targets.indexOf(helper)]).not.toContain("--entitlements");
      expect(signed[targets.indexOf(app)]).toContain("--entitlements");
    } finally {
      await rm(join(app, ".."), { recursive: true, force: true });
    }
  });
});

describe("parseNotarizationSubmission", () => {
  it("requires a submission id and a terminal Apple status", () => {
    expect(
      parseNotarizationSubmission(JSON.stringify({ id: "submission-id", status: "Accepted" })),
    ).toEqual({ id: "submission-id", status: "Accepted" });
    expect(() => parseNotarizationSubmission('{"status":"Invalid"}')).toThrow(/submission id/i);
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
    expect(createNotarizeArgv({ archivePath: "/a/Octant.zip", notaryProfile: "p" })).toContain(
      "json",
    );
  });
});
