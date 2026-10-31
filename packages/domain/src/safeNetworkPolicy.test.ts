import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AggregateId, ToolEgressRuleId, type SafeNetworkPlace } from "@octant/contracts";
import {
  canonicalSafeNetworkPlace,
  decideProviderRuntimeEgress,
  runtimeEgressPrivateAddressAllowed,
  safeNetworkHoldsAddress,
  type RuntimeEgressRequest,
} from "./safeNetworkPolicy";

const projectId = Schema.decodeUnknownSync(AggregateId)("8a3f6d4e-1c2b-4a5d-9e8f-7a6b5c4d3e2f");
const ruleId = Schema.decodeUnknownSync(ToolEgressRuleId)("1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e");
const now = "2026-10-31T12:00:00.000Z";

function request(
  host: string,
  port: number,
  overrides: Partial<RuntimeEgressRequest> = {},
): RuntimeEgressRequest {
  return {
    destination: { host, port },
    providerDomains: ["anthropic.com"],
    launchLoopbackPorts: [],
    places: [],
    projectRules: [],
    reviewerAllowed: [],
    now,
    ...overrides,
  };
}

describe("safe network places", () => {
  it("stores a typed host, domain, and range in canonical form", () => {
    expect(canonicalSafeNetworkPlace({ kind: "host", host: " NAS.Example.com. " })).toEqual({
      kind: "place",
      place: { kind: "host", host: "nas.example.com" },
    });
    expect(
      canonicalSafeNetworkPlace({ kind: "domain", domain: "*.Corp.example", port: 8443 }),
    ).toEqual({ kind: "place", place: { kind: "domain", domain: "corp.example", port: 8443 } });
    expect(canonicalSafeNetworkPlace({ kind: "range", range: "192.168.1.77/24" })).toEqual({
      kind: "place",
      place: { kind: "range", range: "192.168.1.0/24" },
    });
    expect(canonicalSafeNetworkPlace({ kind: "range", range: "FD00::1/8" })).toEqual({
      kind: "place",
      place: { kind: "range", range: "fd00::/8" },
    });
    expect(canonicalSafeNetworkPlace({ kind: "range", range: "10.0.0.5" })).toEqual({
      kind: "place",
      place: { kind: "range", range: "10.0.0.5/32" },
    });
  });

  it("refuses a place that is not a name or a range, and any range that reaches link-local addresses", () => {
    for (const place of [
      { kind: "host", host: "localhost" },
      { kind: "host", host: "printer" },
      { kind: "host", host: "10.0.0.1" },
      { kind: "domain", domain: "*.com.x/y" },
      { kind: "range", range: "192.168.1.0/33" },
      { kind: "range", range: "not-a-range" },
    ] satisfies ReadonlyArray<SafeNetworkPlace>) {
      expect(canonicalSafeNetworkPlace(place)).toEqual({
        kind: "refused",
        reason: "invalid-place",
      });
    }
    for (const range of ["169.254.169.254", "169.0.0.0/8", "0.0.0.0/0", "fe80::/64", "::/0"]) {
      expect(canonicalSafeNetworkPlace({ kind: "range", range })).toEqual({
        kind: "refused",
        reason: "covers-link-local",
      });
    }
  });

  it("holds an address in a trusted tag or range and never a link-local one", () => {
    const places: ReadonlyArray<SafeNetworkPlace> = [
      { kind: "private-network", tag: "local-network" },
      { kind: "private-network", tag: "this-mac", port: 5173 },
      { kind: "range", range: "100.100.0.0/16" },
    ];
    expect(safeNetworkHoldsAddress(places, "192.168.4.9", 22)).toBe(true);
    expect(safeNetworkHoldsAddress(places, "::ffff:10.1.2.3", 443)).toBe(true);
    expect(safeNetworkHoldsAddress(places, "fd12::4", 443)).toBe(true);
    expect(safeNetworkHoldsAddress(places, "127.0.0.1", 5173)).toBe(true);
    expect(safeNetworkHoldsAddress(places, "127.0.0.1", 5174)).toBe(false);
    expect(safeNetworkHoldsAddress(places, "100.100.3.4", 443)).toBe(true);
    expect(safeNetworkHoldsAddress(places, "100.64.0.1", 443)).toBe(false);
    expect(safeNetworkHoldsAddress(places, "169.254.169.254", 80)).toBe(false);
    expect(safeNetworkHoldsAddress(places, "8.8.8.8", 443)).toBe(false);
  });
});

describe("provider runtime egress", () => {
  it("lets the provider's own endpoints through on 443 and nothing else on its domain", () => {
    expect(decideProviderRuntimeEgress(request("api.anthropic.com", 443))).toEqual({
      kind: "allow",
      host: "api.anthropic.com",
      port: 443,
      by: "provider",
    });
    expect(decideProviderRuntimeEgress(request("API.Anthropic.com.", 443))).toMatchObject({
      kind: "allow",
      by: "provider",
    });
    expect(decideProviderRuntimeEgress(request("api.anthropic.com", 80))).toEqual({
      kind: "refuse",
      reason: "no-rule",
      host: "api.anthropic.com",
      port: 80,
    });
    expect(decideProviderRuntimeEgress(request("anthropic.com.evil.example", 443))).toMatchObject({
      kind: "refuse",
      reason: "no-rule",
    });
  });

  it("refuses an unlisted host with the host named, so a person can see what was asked", () => {
    expect(decideProviderRuntimeEgress(request("registry.npmjs.org", 443))).toEqual({
      kind: "refuse",
      reason: "no-rule",
      host: "registry.npmjs.org",
      port: 443,
    });
  });

  it("lets a trusted host or domain through at its port only", () => {
    const places: ReadonlyArray<SafeNetworkPlace> = [
      { kind: "host", host: "git.example.com" },
      { kind: "domain", domain: "corp.example", port: 8443 },
    ];
    expect(decideProviderRuntimeEgress(request("git.example.com", 22, { places }))).toMatchObject({
      kind: "allow",
      by: "place",
    });
    expect(
      decideProviderRuntimeEgress(request("wiki.corp.example", 8443, { places })),
    ).toMatchObject({ kind: "allow", by: "place" });
    expect(decideProviderRuntimeEgress(request("corp.example", 8443, { places }))).toMatchObject({
      kind: "allow",
    });
    expect(
      decideProviderRuntimeEgress(request("wiki.corp.example", 443, { places })),
    ).toMatchObject({
      kind: "refuse",
      reason: "no-rule",
    });
    expect(
      decideProviderRuntimeEgress(request("other.example.com", 443, { places })),
    ).toMatchObject({
      kind: "refuse",
    });
  });

  it("lets an address or localhost through only inside a trusted range or tag, or at the launch's own loopback ports", () => {
    const places: ReadonlyArray<SafeNetworkPlace> = [
      { kind: "private-network", tag: "this-mac", port: 8080 },
      { kind: "range", range: "192.168.1.0/24" },
    ];
    expect(decideProviderRuntimeEgress(request("127.0.0.1", 8080, { places }))).toMatchObject({
      kind: "allow",
      by: "place",
    });
    expect(decideProviderRuntimeEgress(request("localhost", 8080, { places }))).toMatchObject({
      kind: "allow",
      host: "localhost",
    });
    expect(decideProviderRuntimeEgress(request("127.0.0.1", 8081, { places }))).toEqual({
      kind: "refuse",
      reason: "ip-literal",
    });
    expect(decideProviderRuntimeEgress(request("192.168.1.20", 22, { places }))).toMatchObject({
      kind: "allow",
    });
    expect(
      decideProviderRuntimeEgress(request("[::1]", 4100, { launchLoopbackPorts: [4100] })),
    ).toEqual({ kind: "allow", host: "::1", port: 4100, by: "launch" });
    expect(decideProviderRuntimeEgress(request("169.254.169.254", 80, { places }))).toEqual({
      kind: "refuse",
      reason: "ip-literal",
    });
  });

  it("applies the Project's live egress rules and reports an expired one", () => {
    const projectRules = [
      {
        id: ruleId,
        projectId,
        host: "*.npmjs.org",
        port: 443,
        expiresAt: "2026-11-01T00:00:00.000Z",
      },
    ];
    expect(
      decideProviderRuntimeEgress(request("registry.npmjs.org", 443, { projectRules })),
    ).toEqual({
      kind: "allow",
      host: "registry.npmjs.org",
      port: 443,
      by: "project-rule",
      ruleId,
    });
    expect(
      decideProviderRuntimeEgress(
        request("registry.npmjs.org", 443, { projectRules, now: "2026-11-02T00:00:00.000Z" }),
      ),
    ).toMatchObject({ kind: "refuse", reason: "expired" });
  });

  it("lets a host a reviewer allowed for this launch through, and only that host", () => {
    const reviewerAllowed = [{ host: "pypi.org", port: 443 }];
    expect(
      decideProviderRuntimeEgress(request("pypi.org", 443, { reviewerAllowed })),
    ).toMatchObject({ kind: "allow", by: "reviewer" });
    expect(
      decideProviderRuntimeEgress(request("files.pythonhosted.org", 443, { reviewerAllowed })),
    ).toMatchObject({ kind: "refuse", reason: "no-rule" });
  });

  it("refuses a bad port and a name that is not a DNS name before anything else", () => {
    expect(decideProviderRuntimeEgress(request("api.anthropic.com", 0))).toEqual({
      kind: "refuse",
      reason: "invalid-port",
    });
    expect(decideProviderRuntimeEgress(request("metadata", 80))).toEqual({
      kind: "refuse",
      reason: "invalid-name",
    });
  });

  it("connects to a private answer only for a trusted name, a trusted range, or the launch's own port, and never to link-local", () => {
    const places: ReadonlyArray<SafeNetworkPlace> = [
      { kind: "private-network", tag: "local-network" },
    ];
    const check = (address: string, by: "provider" | "place" | "project-rule" | "launch") =>
      runtimeEgressPrivateAddressAllowed({
        address,
        port: 443,
        by,
        places,
        launchLoopbackPorts: [443],
      });
    expect(check("10.0.0.8", "place")).toBe(true);
    expect(check("10.0.0.8", "provider")).toBe(true);
    expect(check("127.0.0.1", "provider")).toBe(false);
    expect(check("127.0.0.1", "launch")).toBe(true);
    expect(check("10.0.0.8", "launch")).toBe(false);
    expect(check("169.254.169.254", "place")).toBe(false);
    expect(
      runtimeEgressPrivateAddressAllowed({
        address: "10.0.0.8",
        port: 443,
        by: "project-rule",
        places: [],
        launchLoopbackPorts: [],
      }),
    ).toBe(false);
  });
});
