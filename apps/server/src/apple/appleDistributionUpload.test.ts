import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAppleDeviceRequest,
  type AppleDeviceRequest,
  type AppleUploadBuild,
  type AppleUploadEvidence,
} from "@octant/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppStoreConnectKeyFiles } from "../providers/credentialBrokerClient";
import type { AppleDeviceExecutionContext } from "./appleDeviceService";
import {
  AppleDistributionUpload,
  altoolAnswer,
  type AppleDistributionUploadOptions,
} from "./appleDistributionUpload";
import type { AppleProcessResult } from "./appleToolchainService";

const TEAM = "A1B2C3D4E5";
const CERTIFICATE = new TextEncoder().encode("fixture distribution certificate");
// The certificate fingerprint Apple names a signing identity by (SHA-1 of CERTIFICATE).
const FINGERPRINT = "4494EDBA13F047076952B9A2A3D99F9F054367CB";
const PROFILE_UUID = "7b1e0f9a-3c2d-4e5f-8a9b-0c1d2e3f4a5b";
const DELIVERY = "5d1b6c2e-8f3a-4b7c-9d0e-1f2a3b4c5d6e";
const KEY_TEXT = "-----BEGIN PRIVATE KEY-----\nNOT-A-REAL-KEY\n-----END PRIVATE KEY-----\n";

const authority = {
  hostId: "60000000-0000-4000-8000-000000000001",
  mode: "code",
  projectId: "60000000-0000-4000-8000-000000000002",
  providerInstanceId: "60000000-0000-4000-8000-000000000003",
  extension: { kind: "core" },
} as const;
const person = { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000010" } as const;

const ok = (stdout = ""): AppleProcessResult => ({
  termination: "exited",
  exitCode: 0,
  stdout: new TextEncoder().encode(stdout),
  stderr: new Uint8Array(),
  parserFailed: false,
  cleanupUncertain: false,
});
const failed = (stdout = ""): AppleProcessResult => ({ ...ok(stdout), exitCode: 1 });

/** An App Store profile as Xcode installs it: a CMS envelope around an XML property list. */
function appStoreProfile(extra = ""): Uint8Array {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>DeveloperCertificates</key>
  <array><data>${Buffer.from(CERTIFICATE).toString("base64")}</data></array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>${TEAM}.sh.octant.Fixture</string>
    <key>get-task-allow</key><false/>
  </dict>
  <key>ExpirationDate</key><date>2027-10-28T12:00:00Z</date>
  <key>Platform</key><array><string>iOS</string></array>
  <key>TeamIdentifier</key><array><string>${TEAM}</string></array>
  <key>UUID</key><string>${PROFILE_UUID.toUpperCase()}</string>
  ${extra}
</dict>
</plist>`;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from(plist, "utf8"), Buffer.from([0xa0])]),
  );
}

function archiveInfo(version: string, build: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ApplicationProperties</key>
  <dict>
    <key>CFBundleIdentifier</key><string>sh.octant.Fixture</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
    <key>CFBundleVersion</key><string>${build}</string>
  </dict>
</dict>
</plist>`;
}

interface Host {
  readonly launches: Array<ReadonlyArray<string>>;
  readonly isolated: Array<ReadonlyArray<string>>;
  settings: { version: string; build: string };
  archived: { version: string; build: string };
  altool: () => AppleProcessResult;
  keyPresentDuringUpload?: boolean;
  keyModeDuringUpload?: number;
  exportOptions?: string;
}

describe("AppleDistributionUpload", () => {
  let root: string;
  let checkout: string;
  let host: Host;
  let keyWrites: number;
  let keyRemovals: number;
  let recorded: AppleUploadEvidence[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "octant-asc-upload-")));
    checkout = join(root, "checkout");
    await mkdir(join(checkout, "Fixture.xcodeproj"), { recursive: true });
    await mkdir(join(root, "profiles"));
    await writeFile(join(root, "profiles", "store.mobileprovision"), appStoreProfile());
    keyWrites = 0;
    keyRemovals = 0;
    recorded = [];
    host = {
      launches: [],
      isolated: [],
      settings: { version: "1.2.0", build: "42" },
      archived: { version: "1.2.0", build: "42" },
      altool: () =>
        ok(JSON.stringify({ "success-message": "ok", details: { "delivery-uuid": DELIVERY } })),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The broker's part, played by the test: a 0600 key file in the upload's key folder. */
  const keyFiles: AppStoreConnectKeyFiles = {
    write: async (directory) => {
      keyWrites += 1;
      const file = join(directory, "AuthKey_ABCDE12345.p8");
      await writeFile(file, KEY_TEXT, { mode: 0o600, flag: "wx" });
      return {
        kind: "written",
        file,
        issuerId: "60000000-0000-4000-8000-0000000000aa",
        keyId: "ABCDE12345",
      };
    },
    remove: async (directory) => {
      keyRemovals += 1;
      await rm(join(directory, "AuthKey_ABCDE12345.p8"), { force: true });
    },
  };

  function service(
    keys: AppStoreConnectKeyFiles | "no-broker" = keyFiles,
    overrides: Partial<AppleDistributionUploadOptions> = {},
  ) {
    const launch = async (input: {
      readonly argv: ReadonlyArray<string>;
      readonly isolatedRoots?: ReadonlyArray<string>;
    }): Promise<AppleProcessResult> => {
      const argv = input.argv;
      host.launches.push(argv);
      host.isolated.push(input.isolatedRoots ?? []);
      if (argv[0] === "security") {
        return ok(`  1) ${FINGERPRINT} "Apple Distribution: Fixture Person (${TEAM})"\n`);
      }
      if (argv[0] === "xcodebuild" && argv.includes("-showBuildSettings")) {
        return ok(
          JSON.stringify([
            {
              buildSettings: {
                WRAPPER_NAME: "Fixture.app",
                PRODUCT_BUNDLE_IDENTIFIER: "sh.octant.Fixture",
                MARKETING_VERSION: host.settings.version,
                CURRENT_PROJECT_VERSION: host.settings.build,
              },
            },
          ]),
        );
      }
      if (argv[0] === "xcodebuild" && argv.at(-1) === "archive") {
        const archive = argv[argv.indexOf("-archivePath") + 1] ?? "";
        await mkdir(archive, { recursive: true });
        await writeFile(
          join(archive, "Info.plist"),
          archiveInfo(host.archived.version, host.archived.build),
        );
        return ok();
      }
      if (argv[0] === "xcodebuild" && argv.includes("-exportArchive")) {
        host.exportOptions = await readFile(
          argv[argv.indexOf("-exportOptionsPlist") + 1] ?? "",
          "utf8",
        );
        const exportPath = argv[argv.indexOf("-exportPath") + 1] ?? "";
        await mkdir(exportPath, { recursive: true });
        await writeFile(join(exportPath, "Fixture.ipa"), "ipa");
        return ok();
      }
      if (argv[0] === "xcrun" && argv[1] === "altool") {
        const keyFile = argv[argv.indexOf("--p8-file-path") + 1] ?? "";
        host.keyPresentDuringUpload = existsSync(keyFile);
        host.keyModeDuringUpload = (await stat(keyFile)).mode & 0o777;
        return host.altool();
      }
      return failed();
    };
    return new AppleDistributionUpload({
      execute: launch,
      executeSigning: launch,
      executeUpload: launch,
      keyFiles: keys === "no-broker" ? undefined : keys,
      uploadRoot: join(root, "uploads"),
      keyRoot: join(root, "keys"),
      isolatedRoots: [join(root, "devicectl")],
      provisioningProfileDirectories: [join(root, "profiles")],
      realpath,
      recordEvidence: (evidence) => recorded.push(evidence),
      now: () => "2026-10-28T12:00:00.000Z",
      ...overrides,
    });
  }

  const context = (): AppleDeviceExecutionContext => ({
    authority: authority as never,
    threadId: "60000000-0000-4000-8000-000000000020" as never,
    checkoutId: "60000000-0000-4000-8000-000000000021" as never,
    checkoutRoot: checkout,
    executionPolicy: "approval-gated",
    approvalValid: true,
    approvedBy: person as never,
  });

  async function prepared(upload = service()): Promise<AppleUploadBuild> {
    const answer = await upload.prepare(
      { projectPath: "Fixture.xcodeproj", teamId: TEAM as never },
      context(),
    );
    if (answer.kind !== "prepared") throw new Error(answer.message);
    return answer.upload;
  }

  const uploadRequest = (
    build: AppleUploadBuild,
    actionId = "60000000-0000-4000-8000-000000000030",
  ): AppleDeviceRequest =>
    decodeAppleDeviceRequest({
      actionId,
      correlationId: "60000000-0000-4000-8000-000000000031",
      authority,
      threadId: "60000000-0000-4000-8000-000000000020",
      checkoutId: "60000000-0000-4000-8000-000000000021",
      kind: "upload",
      requestedBy: person,
      projectPath: "Fixture.xcodeproj",
      teamId: TEAM,
      upload: build,
      timeoutMs: 60 * 60_000,
      approval: { kind: "approved", approvalId: "60000000-0000-4000-8000-000000000040" },
    });

  it("reads the exact build and App Store signature an upload would send, before anything runs", async () => {
    expect(await prepared()).toEqual({
      bundleIdentifier: "sh.octant.Fixture",
      version: "1.2.0",
      buildNumber: "42",
      signing: { teamId: TEAM, identity: FINGERPRINT },
      profileId: PROFILE_UUID,
    });
    // Only reads: build settings and the keychain's identities.
    expect(host.launches.map((argv) => argv[0])).toEqual(["xcodebuild", "security"]);
    expect(keyWrites).toBe(0);
  });

  it("reads the keychain on a Mac that has never uploaded, whose upload folder does not exist yet", async () => {
    // A real process start, which fails when its working directory is missing.
    const spawned = (input: { readonly cwd: string }): Promise<AppleProcessResult> =>
      new Promise((resolve) => {
        const child = spawn(
          "/bin/sh",
          ["-c", `printf '  1) ${FINGERPRINT} "Apple Distribution: Fixture"\\n'`],
          { cwd: input.cwd },
        );
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", () =>
          resolve({ ...failed(), termination: "unavailable", exitCode: null }),
        );
        child.on("close", (code) =>
          resolve({ ...ok(Buffer.concat(chunks).toString("utf8")), exitCode: code }),
        );
      });
    const upload = service(keyFiles, {
      executeSigning: spawned,
      uploadRoot: join(root, "never-created", "uploads"),
    });
    await expect(
      upload.prepare({ projectPath: "Fixture.xcodeproj", teamId: TEAM as never }, context()),
    ).resolves.toMatchObject({ kind: "prepared", upload: { signing: { identity: FINGERPRINT } } });
    expect((await stat(join(root, "never-created", "uploads"))).mode & 0o777).toBe(0o700);
  });

  it("archives unsigned, signs with exactly the confirmed identity and profile, and uploads with a key file it never reads", async () => {
    const upload = service();
    const build = await prepared(upload);
    host.launches.length = 0;
    const answer = await upload.upload(uploadRequest(build), context());

    expect(answer).toMatchObject({
      kind: "apple-upload-evidence",
      evidence: { outcome: "succeeded", deliveryId: DELIVERY, upload: build, requestedBy: person },
    });
    const commands = host.launches.map((argv) => argv.slice(0, 2).join(" "));
    expect(commands).toEqual([
      expect.stringMatching(/^xcodebuild -project$/),
      "security find-identity",
      expect.stringMatching(/^xcodebuild -project$/),
      "xcodebuild -exportArchive",
      "xcrun altool",
    ]);
    const archive = host.launches[2] ?? [];
    expect(archive).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(archive.at(-1)).toBe("archive");
    for (const argv of host.launches) {
      expect(argv.join(" ")).not.toContain("allowProvisioningUpdates");
    }
    // Manual App Store signing with the confirmed pair, written to disk; the
    // export never uploads and never manages the build number.
    expect(host.exportOptions).toContain("<key>method</key><string>app-store-connect</string>");
    expect(host.exportOptions).toContain("<key>destination</key><string>export</string>");
    expect(host.exportOptions).toContain("<key>signingStyle</key><string>manual</string>");
    expect(host.exportOptions).toContain(
      `<key>signingCertificate</key><string>${FINGERPRINT}</string>`,
    );
    expect(host.exportOptions).toContain(
      `<key>sh.octant.Fixture</key><string>${PROFILE_UUID}</string>`,
    );
    expect(host.exportOptions).toContain("<key>manageAppVersionAndBuildNumber</key><false/>");

    const altool = host.launches[4] ?? [];
    expect(altool.slice(0, 3)).toEqual(["xcrun", "altool", "--upload-package"]);
    expect(altool[altool.indexOf("--p8-file-path") + 1]).toMatch(
      new RegExp(`^${join(root, "keys")}/upload-60000000-0000-4000-8000-000000000030/`),
    );
    expect(host.keyPresentDuringUpload).toBe(true);
    expect(host.keyModeDuringUpload).toBe(0o600);
    // Every launch before the upload is denied the key folders.
    for (const roots of host.isolated.slice(0, 4)) expect(roots).toContain(join(root, "keys"));
    // The key is gone afterwards, and never reached the evidence.
    expect(keyRemovals).toBe(1);
    expect(await readdir(join(root, "keys"))).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain("NOT-A-REAL-KEY");
    expect(JSON.stringify(answer)).not.toContain("NOT-A-REAL-KEY");
  });

  it("refuses an upload whose project no longer builds the confirmed build, before archiving", async () => {
    const upload = service();
    const build = await prepared(upload);
    host.settings = { version: "1.2.0", build: "43" };
    host.launches.length = 0;

    await expect(upload.upload(uploadRequest(build), context())).resolves.toEqual({
      kind: "apple-device-refused",
      reason: "upload-changed",
    });
    expect(host.launches.some((argv) => argv.at(-1) === "archive")).toBe(false);
    expect(keyWrites).toBe(0);
  });

  it("does not export or upload an archive that is not the confirmed version and build", async () => {
    const upload = service();
    const build = await prepared(upload);
    host.archived = { version: "1.2.0", build: "41" };

    const answer = await upload.upload(uploadRequest(build), context());
    expect(answer).toMatchObject({
      kind: "apple-upload-evidence",
      evidence: { outcome: "failed" },
    });
    expect(host.launches.some((argv) => argv.includes("-exportArchive"))).toBe(false);
    expect(keyWrites).toBe(0);
  });

  it("removes the key file when App Store Connect refuses the upload, and records no delivery", async () => {
    const upload = service();
    const build = await prepared(upload);
    host.altool = () =>
      failed(
        JSON.stringify({ "product-errors": [{ message: "The bundle version must be higher." }] }),
      );

    const answer = await upload.upload(uploadRequest(build), context());
    expect(answer).toMatchObject({
      kind: "apple-upload-evidence",
      evidence: { outcome: "failed" },
    });
    if (answer.kind !== "apple-upload-evidence") throw new Error("expected evidence");
    expect(answer.evidence.deliveryId).toBeUndefined();
    expect(answer.evidence.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "The bundle version must be higher.",
    );
    expect(keyRemovals).toBe(1);
    expect(await readdir(join(root, "keys"))).toEqual([]);
  });

  it("does not count an upload whose answer names no delivery", async () => {
    const upload = service();
    const build = await prepared(upload);
    host.altool = () => ok(JSON.stringify({ "success-message": "ok" }));

    const answer = await upload.upload(uploadRequest(build), context());
    expect(answer).toMatchObject({
      kind: "apple-upload-evidence",
      evidence: { outcome: "failed" },
    });
  });

  it("says which Xcode step is missing when no App Store profile covers the app", async () => {
    await writeFile(
      join(root, "profiles", "store.mobileprovision"),
      appStoreProfile("<key>ProvisionedDevices</key><array><string>device</string></array>"),
    );
    const answer = await service().prepare(
      { projectPath: "Fixture.xcodeproj", teamId: TEAM as never },
      context(),
    );
    expect(answer).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("App Store provisioning profile"),
    });
  });

  it("archives nothing on a host with no broker for the key", async () => {
    const upload = service("no-broker");
    const build = await prepared(upload);
    const answer = await upload.upload(uploadRequest(build), context());
    expect(answer).toMatchObject({
      kind: "apple-upload-evidence",
      evidence: { outcome: "unavailable" },
    });
    expect(host.launches.some((argv) => argv.at(-1) === "archive")).toBe(false);
  });

  it("removes key folders an earlier upload left behind", async () => {
    await mkdir(join(root, "keys", "upload-60000000-0000-4000-8000-000000000099"), {
      recursive: true,
    });
    await writeFile(
      join(root, "keys", "upload-60000000-0000-4000-8000-000000000099", "AuthKey_ABCDE12345.p8"),
      KEY_TEXT,
    );
    await service().sweepKeyFolders();
    expect(await readdir(join(root, "keys"))).toEqual([]);
  });
});

describe("altoolAnswer", () => {
  it("takes App Store Connect's delivery identifier wherever altool nests it", () => {
    expect(
      altoolAnswer(JSON.stringify({ details: { "delivery-uuid": DELIVERY.toUpperCase() } })),
    ).toEqual({
      deliveryId: DELIVERY,
      errors: [],
    });
    expect(altoolAnswer("not json")).toEqual({ errors: [] });
    expect(altoolAnswer(JSON.stringify({ details: { "delivery-uuid": "not-a-uuid" } }))).toEqual({
      errors: [],
    });
  });
});
