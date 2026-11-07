import { NIGHTLY_HOST_FEATURES } from "@octant/contracts/nightly-browser";
import { describe, expect, it } from "vitest";
import {
  checkChannelTable,
  checkPublishedCompatibility,
  newestOctantRelease,
  parsePreflightCommand,
  refusalVerified,
  type PublishedRelease,
} from "./nightly-preflight";

describe("the Nightly channel table rule", () => {
  it("passes the table Nightly ships", () => {
    expect(checkChannelTable()).toMatchObject({ status: "passed" });
  });

  it("refuses a core channel that is still brokered, Octant-only or unclassified", () => {
    const channels = { pick: "a", key: "b", admin: "c", missing: "d" };
    const table = { pick: "brokered", key: "octant-only", admin: "octant-only" };
    const result = checkChannelTable(channels, table, {
      pickers: ["pick"],
      credentials: ["key"],
      links: ["missing"],
    });
    expect(result).toEqual({
      status: "failed",
      reasons: [
        "missing has no class in Nightly's table.",
        "Core pickers channel pick is brokered; Nightly must answer it.",
        "Core credentials channel key is octant-only; Nightly must answer it.",
        "Core links channel missing is unclassified; Nightly must answer it.",
      ],
    });
  });

  it("refuses a stale classification and a core name that is no channel", () => {
    const result = checkChannelTable(
      { menu: "a" },
      { menu: "local", gone: "local" },
      {
        menus: ["menu", "renamed"],
      },
    );
    expect(result).toEqual({
      status: "failed",
      reasons: [
        "gone is classified but is not a desktop channel.",
        "Core menus channel renamed is not a desktop channel.",
      ],
    });
  });
});

const features = (version: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  octantVersion: version,
  nativeClientProtocol: 1,
  hostFeatures: [...NIGHTLY_HOST_FEATURES],
  ...overrides,
});

function release(tag: string, publishedAt: string, assetId?: number): PublishedRelease {
  return {
    tag_name: tag,
    draft: false,
    published_at: publishedAt,
    assets: [
      { id: 1, name: "Octant-x-darwin-arm64.zip", size: 100 },
      ...(assetId === undefined
        ? []
        : [{ id: assetId, name: "octant-host-features.json", size: 400 }]),
    ],
  };
}

describe("compatibility with the published Octant", () => {
  const candidate = "0.1.0-candidate.20261106.81";

  it("reads the newest Octant release, never a Nightly, feed or draft release", () => {
    const releases: PublishedRelease[] = [
      release("v0.1.0-preview.20261107.82", "2026-11-07T00:10:00Z", 9),
      release("feed-candidate", "2026-11-07T00:09:00Z"),
      { ...release("v0.1.1", "2026-11-07T00:08:00Z", 8), draft: true },
      release(`v${candidate}`, "2026-11-06T12:00:00Z", 7),
      release("v0.1.0", "2026-11-01T12:00:00Z", 6),
    ];
    expect(newestOctantRelease(releases)?.tag_name).toBe(`v${candidate}`);
  });

  it("passes when the newest Octant speaks the protocol and offers every feature", async () => {
    const result = await checkPublishedCompatibility({
      releases: [release(`v${candidate}`, "2026-11-06T12:00:00Z", 7)],
      download: async (id) => (id === 7 ? features(candidate) : undefined),
    });
    expect(result).toMatchObject({ status: "passed" });
  });

  it("asks for an Octant candidate when the newest release has no host feature list", async () => {
    const result = await checkPublishedCompatibility({
      releases: [
        release(`v${candidate}`, "2026-11-06T12:00:00Z"),
        release("v0.1.0-candidate.20261030.66", "2026-10-30T12:00:00Z", 6),
      ],
      download: async () => features("0.1.0-candidate.20261030.66"),
    });
    expect(result).toEqual({
      status: "failed",
      reasons: [
        `Publish an Octant candidate with these host features first: ${NIGHTLY_HOST_FEATURES.join(", ")}. Octant ${candidate} has no octant-host-features.json.`,
      ],
    });
  });

  it("asks for an Octant candidate when no Octant release exists", async () => {
    const result = await checkPublishedCompatibility({ releases: [], download: async () => ({}) });
    expect(result.status === "failed" && result.reasons[0]).toContain(
      "No Octant release is published.",
    );
  });

  it("refuses an Octant that speaks another native client protocol", async () => {
    const result = await checkPublishedCompatibility({
      releases: [release(`v${candidate}`, "2026-11-06T12:00:00Z", 7)],
      download: async () => features(candidate, { nativeClientProtocol: 2 }),
    });
    expect(result.status === "failed" && result.reasons[0]).toContain(
      `Octant ${candidate} speaks native client protocol 2; this Nightly speaks 1.`,
    );
  });

  it("names only the features the published Octant lacks", async () => {
    const result = await checkPublishedCompatibility({
      releases: [release(`v${candidate}`, "2026-11-06T12:00:00Z", 7)],
      download: async () =>
        features(candidate, {
          hostFeatures: NIGHTLY_HOST_FEATURES.filter((feature) => feature !== "provider-api-keys"),
        }),
    });
    expect(result).toEqual({
      status: "failed",
      reasons: [
        `Publish an Octant candidate with these host features first: provider-api-keys. Octant ${candidate} does not offer them.`,
      ],
    });
  });

  it("refuses a document that is unreadable, unreachable or describes another release", async () => {
    const releases = [release(`v${candidate}`, "2026-11-06T12:00:00Z", 7)];
    const unreadable = await checkPublishedCompatibility({
      releases,
      download: async () => ({ schemaVersion: 9 }),
    });
    const unreachable = await checkPublishedCompatibility({
      releases,
      download: async () => {
        throw new Error("HTTP 404");
      },
    });
    const copied = await checkPublishedCompatibility({
      releases,
      download: async () => features("0.1.0-candidate.20261030.66"),
    });
    expect(unreadable.status === "failed" && unreadable.reasons[0]).toContain("is unreadable.");
    expect(unreachable.status === "failed" && unreachable.reasons[0]).toContain("HTTP 404");
    expect(copied.status === "failed" && copied.reasons[0]).toContain(
      "describes Octant 0.1.0-candidate.20261030.66.",
    );
  });
});

describe("the preflight command", () => {
  it("runs every check by default", () => {
    expect(parsePreflightCommand([], { CI: "true" }).checks).toEqual([
      "channels",
      "client-smoke",
      "packaged",
      "compatibility",
    ]);
  });

  it("allows a partial or fixture run only outside CI", () => {
    expect(parsePreflightCommand(["--only", "channels,compatibility"], {})).toEqual({
      checks: ["channels", "compatibility"],
    });
    expect(() => parsePreflightCommand(["--only", "channels"], { GITHUB_ACTIONS: "true" })).toThrow(
      "for local runs",
    );
    expect(() =>
      parsePreflightCommand(["--releases-fixture", "releases.json"], { CI: "true" }),
    ).toThrow("for local runs");
    expect(() => parsePreflightCommand(["--only", "everything"], {})).toThrow("Unknown check");
  });
});

describe("the packaged smoke's refusal check", () => {
  it("is reported unverified when the smoke could not read the alert", () => {
    expect(
      refusalVerified(
        "pass       1. Bundle\nunverified 2. An ordinary launch refuses as an unsigned development build\n",
      ),
    ).toBe(false);
    expect(
      refusalVerified(
        "pass       2. An ordinary launch refuses as an unsigned development build\n",
      ),
    ).toBe(true);
  });
});
