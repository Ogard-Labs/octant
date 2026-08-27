import { describe, expect, it } from "vitest";
import { decodeHostDataMap } from "@octant/contracts/host-data-map";
import { composeHostDataMap, desktopCredentialStore } from "./hostDataMap";

const dataDirectory = "/Users/ada/Library/Application Support/Octant";

describe("composeHostDataMap", () => {
  it("reports verified host and Project locations without secret material", () => {
    const report = composeHostDataMap({
      hostId: "host-under-test",
      serviceMode: "desktop",
      platform: "darwin",
      dataDirectory,
      credentialStore: desktopCredentialStore(),
      projects: [
        { id: "11111111-1111-4111-8111-111111111111", name: "Notes", type: "chat" },
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Studio",
          type: "code",
          boundRoot: "/Users/ada/src/studio",
        },
      ],
    });
    const decoded = decodeHostDataMap(report);
    expect(decoded.host.displayName).toBe("This Mac");
    expect(decoded.host.kind).toBe("desktop");
    expect(decoded.host.journal).toEqual({
      kind: "known",
      path: `${dataDirectory}/octant.sqlite3`,
    });
    expect(decoded.host.projections).toEqual(decoded.host.journal);
    expect(decoded.host.credentials).toEqual({
      kind: "known",
      backend: "keychain",
      entries: [
        { service: "app.octant.provider-credentials" },
        { service: "app.octant.host-identity.v1" },
      ],
    });
    expect(decoded.host.outbound.map((entry) => entry.category)).toEqual([
      "provider-calls",
      "update-checks",
      "marketplace-fetches",
    ]);
    expect(JSON.stringify(decoded)).not.toMatch(/sk-|password|secret|token/i);
    expect(decoded.projects.kind).toBe("known");
    if (decoded.projects.kind !== "known") return;
    expect(decoded.projects.projects).toHaveLength(2);
    expect(decoded.projects.projects[1]?.boundRoot).toEqual({
      kind: "known",
      path: "/Users/ada/src/studio",
    });
    expect(decoded.projects.projects[0]?.boundRoot).toBeUndefined();
  });

  it("fails closed to unknown when the host cannot verify a category", () => {
    const report = composeHostDataMap({
      hostId: "host-under-test",
      serviceMode: "service",
      platform: "linux",
    });
    const decoded = decodeHostDataMap(report);
    expect(decoded.host.kind).toBe("headless");
    expect(decoded.host.displayName).toBe("This host");
    expect(decoded.host.journal).toEqual({ kind: "unknown" });
    expect(decoded.host.credentials).toEqual({ kind: "unknown" });
    expect(decoded.projects).toEqual({ kind: "unknown" });
    expect(decoded.host.caches.every((entry) => entry.location.kind === "unknown")).toBe(true);
  });

  it("reports that a headless host does not run desktop update checks", () => {
    const report = composeHostDataMap({
      hostId: "host-under-test",
      serviceMode: "web",
      platform: "darwin",
      dataDirectory: "/var/lib/octant",
    });
    const decoded = decodeHostDataMap(report);
    expect(decoded.host.kind).toBe("headless");
    const updates = decoded.host.outbound.find((entry) => entry.category === "update-checks");
    expect(updates).toEqual({
      kind: "known",
      category: "update-checks",
      leavesMachine: false,
      purpose: "This headless host does not check for desktop app updates.",
    });
  });

  it("drops a Project whose id is not a project id rather than inventing one", () => {
    const report = composeHostDataMap({
      hostId: "host-under-test",
      serviceMode: "desktop",
      platform: "darwin",
      dataDirectory,
      projects: [{ id: "not-a-project", name: "Broken", type: "chat" }],
    });
    expect(report.projects).toEqual({ kind: "known", projects: [] });
  });

  it("treats a relative bound root as unknown", () => {
    const report = composeHostDataMap({
      hostId: "host-under-test",
      serviceMode: "desktop",
      platform: "darwin",
      dataDirectory,
      projects: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Studio",
          type: "work",
          boundRoot: "relative/root",
        },
      ],
    });
    const decoded = decodeHostDataMap(report);
    if (decoded.projects.kind !== "known") throw new Error("expected known projects");
    expect(decoded.projects.projects[0]?.boundRoot).toEqual({ kind: "unknown" });
  });
});
