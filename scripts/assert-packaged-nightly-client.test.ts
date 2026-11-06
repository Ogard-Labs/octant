import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { desktopIdentity } from "@octant/host-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPackagedNightlyClient,
  NIGHTLY_COMMAND_FILES,
  NIGHTLY_PEER_STATUS_ADDON,
  parseAssertCommand,
  type NightlyBundleReader,
} from "./assert-packaged-nightly-client";
import { NIGHTLY_CLIENT_HARNESS_MARKER } from "./package-desktop";

const identity = desktopIdentity("nightly");

const nightlyPlist = {
  CFBundleIdentifier: identity.bundleId,
  CFBundleName: identity.productName,
  CFBundleExecutable: identity.productName,
  OctantDesktopEntryPolicy: "sealed-main-v1",
  CFBundleURLTypes: [{ CFBundleURLSchemes: ["octant-nightly"] }],
};

const developerIdSignature = [
  "Executable=/Applications/Octant Nightly.app/Contents/MacOS/Octant Nightly",
  "Authority=Developer ID Application: Example (TEAM123456)",
  "Authority=Developer ID Certification Authority",
  "TeamIdentifier=TEAM123456",
].join("\n");

let bundle: string;

beforeEach(async () => {
  bundle = join(await mkdtemp(join(tmpdir(), "octant-nightly-assert-")), "Octant Nightly.app");
  for (const path of [NIGHTLY_PEER_STATUS_ADDON, ...NIGHTLY_COMMAND_FILES]) {
    await mkdir(dirname(join(bundle, path)), { recursive: true });
    await writeFile(join(bundle, path), "x");
  }
});

afterEach(async () => {
  await rm(dirname(bundle), { recursive: true, force: true });
});

function reader(overrides: Partial<NightlyBundleReader> = {}): NightlyBundleReader {
  return {
    infoPlist: () => nightlyPlist,
    signature: () => developerIdSignature,
    signatureVerifies: () => true,
    fuses: async () => undefined,
    entries: async () => [{ path: "apps/desktop/dist/main.mjs", content: "export {}" }],
    ...overrides,
  };
}

const developerId = { kind: "developer-id", teamId: "TEAM123456" } as const;

describe("the packaged Nightly client check", () => {
  it("passes a signed Nightly with its fuses, addon, link scheme and command", async () => {
    expect(
      await checkPackagedNightlyClient({ bundle, signature: developerId, reader: reader() }),
    ).toEqual({ status: "passed" });
  });

  it("refuses an ad-hoc or other team's signature when a Developer ID is required", async () => {
    const adHoc = await checkPackagedNightlyClient({
      bundle,
      signature: developerId,
      reader: reader({ signature: () => "Signature=adhoc\nTeamIdentifier=not set" }),
    });
    expect(adHoc).toEqual({
      status: "refused",
      reasons: [
        "The bundle is not signed with a Developer ID Application certificate.",
        "The signature's team is not set, not TEAM123456.",
      ],
    });
    const unsigned = await checkPackagedNightlyClient({
      bundle,
      signature: { kind: "any" },
      reader: reader({ signature: () => undefined }),
    });
    expect(unsigned).toEqual({
      status: "refused",
      reasons: ["The bundle carries no code signature."],
    });
  });

  it("refuses a bundle whose fuses, link scheme, addon or command are missing", async () => {
    await rm(join(bundle, NIGHTLY_PEER_STATUS_ADDON));
    await rm(join(bundle, NIGHTLY_COMMAND_FILES[1]));
    const result = await checkPackagedNightlyClient({
      bundle,
      signature: { kind: "any" },
      reader: reader({
        infoPlist: () => ({ ...nightlyPlist, CFBundleURLTypes: [] }),
        fuses: async () => {
          throw new Error("Desktop runtime does not enforce RunAsNode.");
        },
      }),
    });
    expect(result).toEqual({
      status: "refused",
      reasons: [
        "Packaged app bundle does not declare its octant-nightly:// Code links.",
        "Desktop runtime does not enforce RunAsNode.",
        `The bundle is missing ${NIGHTLY_PEER_STATUS_ADDON}.`,
        `The bundle is missing ${NIGHTLY_COMMAND_FILES[1]}.`,
      ],
    });
  });

  it("refuses a bundle carrying the client smoke harness by name or inlined", async () => {
    const result = await checkPackagedNightlyClient({
      bundle,
      signature: { kind: "any" },
      reader: reader({
        entries: async () => [
          { path: "apps/desktop/dist/nightly-client-harness-nightly.mjs" },
          { path: "apps/desktop/dist/main.mjs", content: `"${NIGHTLY_CLIENT_HARNESS_MARKER}"` },
        ],
      }),
    });
    expect(result).toEqual({
      status: "refused",
      reasons: [
        "The bundle contains the Nightly client smoke harness in apps/desktop/dist/nightly-client-harness-nightly.mjs.",
        "The bundle contains the Nightly client smoke harness in apps/desktop/dist/main.mjs.",
      ],
    });
  });

  it("refuses a bundle that is not there", async () => {
    expect(
      await checkPackagedNightlyClient({
        bundle: join(bundle, "missing.app"),
        signature: { kind: "any" },
        reader: reader(),
      }),
    ).toMatchObject({ status: "refused" });
  });

  it("requires the release team only when the release names one", () => {
    expect(parseAssertCommand(["--require-developer-id"], {}, "/repo")).toEqual({
      bundle: "/repo/out/Octant Nightly.app",
      signature: { kind: "developer-id" },
    });
    expect(
      parseAssertCommand(
        ["--bundle", "/x/N.app", "--require-developer-id"],
        {
          OCTANT_SIGNING_TEAM_ID: "TEAM123456",
        },
        "/repo",
      ),
    ).toEqual({ bundle: "/x/N.app", signature: { kind: "developer-id", teamId: "TEAM123456" } });
    expect(() => parseAssertCommand(["--sign"], {}, "/repo")).toThrow("Unknown argument");
  });
});
