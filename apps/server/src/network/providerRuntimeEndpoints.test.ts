import { decideProviderRuntimeEgress } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { acpProviderProfiles } from "../providers/acpProfiles";
import { providerRuntimeDomains } from "./providerRuntimeEndpoints";

function reaches(providerDomains: ReadonlyArray<string>, host: string): boolean {
  return (
    decideProviderRuntimeEgress({
      destination: { host, port: 443 },
      providerDomains,
      places: [],
      projectRules: [],
      launchLoopbackPorts: [],
      reviewerAllowed: [],
      now: "2026-11-22T12:00:00.000Z",
    }).kind === "allow"
  );
}

describe("Google Antigravity's Agent Platform endpoints", () => {
  it("an Agent Platform instance's regional host comes from its provider profile, and the network start input carries no vendor field", () => {
    const runtimeHosts = acpProviderProfiles.antigravity.runtimeHosts;
    expect(
      runtimeHosts?.({ googleCloud: { project: "octant-example-1", location: "us-central1" } }),
    ).toEqual(["us-central1-aiplatform.googleapis.com"]);
    for (const location of ["global", "us_central1", "UP-CENTRAL1"] as const) {
      expect(runtimeHosts?.({ googleCloud: { project: "octant-example-1", location } })).toEqual(
        [],
      );
    }
    expect(runtimeHosts?.({})).toEqual([]);

    const domains = providerRuntimeDomains({
      runtime: "acp",
      profileId: "antigravity",
      profileHosts: runtimeHosts?.({
        googleCloud: { project: "octant-example-1", location: "us-central1" },
      }),
    });
    expect(reaches(domains, "us-central1-aiplatform.googleapis.com")).toBe(true);
    expect(reaches(domains, "aiplatform.googleapis.com")).toBe(true);
    expect(reaches(domains, "europe-west4-aiplatform.googleapis.com")).toBe(false);
  });

  it("adds no regional host without a profile-derived host", () => {
    const domains = providerRuntimeDomains({ runtime: "acp", profileId: "antigravity" });
    expect(reaches(domains, "us-central1-aiplatform.googleapis.com")).toBe(false);
    expect(
      providerRuntimeDomains({
        runtime: "acp",
        profileId: "antigravity",
        profileHosts: [],
      }).some((domain) => domain.includes("global-")),
    ).toBe(false);
  });
});
