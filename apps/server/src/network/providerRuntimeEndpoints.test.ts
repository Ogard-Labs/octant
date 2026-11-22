import { decideProviderRuntimeEgress } from "@octant/domain";
import { describe, expect, it } from "vitest";
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
  it("reaches the regional Agent Platform host of the instance's own location, and no other region", () => {
    const domains = providerRuntimeDomains({
      runtime: "acp",
      profileId: "antigravity",
      googleCloudLocation: "us-central1",
    });
    expect(reaches(domains, "us-central1-aiplatform.googleapis.com")).toBe(true);
    expect(reaches(domains, "aiplatform.googleapis.com")).toBe(true);
    expect(reaches(domains, "europe-west4-aiplatform.googleapis.com")).toBe(false);
  });

  it("adds no regional host without an Agent Platform location", () => {
    const domains = providerRuntimeDomains({ runtime: "acp", profileId: "antigravity" });
    expect(reaches(domains, "us-central1-aiplatform.googleapis.com")).toBe(false);
    expect(
      providerRuntimeDomains({
        runtime: "acp",
        profileId: "antigravity",
        googleCloudLocation: "global",
      }).some((domain) => domain.includes("global-")),
    ).toBe(false);
  });
});
