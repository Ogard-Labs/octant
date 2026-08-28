import { describe, expect, it } from "vitest";
import { decodeHostDataMap, MAX_HOST_DATA_MAP_PROJECTS } from "./hostDataMap";

const populated = {
  host: {
    hostId: "host-a",
    displayName: "This computer",
    kind: "desktop",
    serviceMode: "desktop",
    journal: {
      kind: "known",
      path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
    },
    projections: {
      kind: "known",
      path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
    },
    artifacts: [
      {
        name: "Apple toolchain artifacts",
        location: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/artifacts",
        },
      },
    ],
    caches: [
      {
        name: "Chat scratch",
        location: { kind: "known", path: "/Users/ada/Library/Application Support/Octant/scratch" },
      },
    ],
    credentials: {
      kind: "known",
      backend: "keychain",
      entries: [{ service: "app.octant.provider-credentials" }],
    },
    outbound: [
      {
        kind: "known",
        category: "provider-calls",
        leavesMachine: true,
        purpose: "Requests you send to a configured provider.",
      },
    ],
  },
  projects: {
    kind: "known",
    projects: [
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        name: "Notes",
        type: "chat",
        journal: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
        },
        projections: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
        },
        artifacts: [],
        caches: [],
        credentials: { kind: "unknown" },
      },
    ],
  },
  related: [
    { kind: "thread-retention", settings: { section: "host", setting: "thread-retention" } },
    {
      kind: "thread-export",
      guidance: "Export a thread from that thread's menu. This map does not export or purge.",
    },
  ],
};

describe("HostDataMap", () => {
  it("decodes a populated host and Project map", () => {
    const decoded = decodeHostDataMap(populated);
    expect(decoded.host.kind).toBe("desktop");
    expect(decoded.host.credentials.kind).toBe("known");
    expect(decoded.projects.kind).toBe("known");
    if (decoded.projects.kind === "known") {
      expect(decoded.projects.projects[0]?.name).toBe("Notes");
    }
  });

  it("decodes unknown locations, credentials, and Project lists without guessing", () => {
    const decoded = decodeHostDataMap({
      host: {
        hostId: "host-a",
        displayName: "This computer",
        kind: "headless",
        serviceMode: "service",
        journal: { kind: "unknown" },
        projections: { kind: "unknown" },
        artifacts: [{ name: "Apple toolchain artifacts", location: { kind: "unknown" } }],
        caches: [],
        credentials: { kind: "unknown" },
        outbound: [{ kind: "unknown", category: "update-checks" }],
      },
      projects: { kind: "unknown" },
      related: [],
    });
    expect(decoded.host.journal).toEqual({ kind: "unknown" });
    expect(decoded.host.credentials).toEqual({ kind: "unknown" });
    expect(decoded.projects).toEqual({ kind: "unknown" });
  });

  it("rejects a credential payload that carries a value", () => {
    expect(() =>
      decodeHostDataMap({
        ...populated,
        host: {
          ...populated.host,
          credentials: {
            kind: "known",
            backend: "keychain",
            entries: [{ service: "app.octant.provider-credentials", value: "sk-secret" }],
          },
        },
      }),
    ).toThrow();
  });

  it("rejects a relative path instead of inventing an absolute one", () => {
    expect(() =>
      decodeHostDataMap({
        ...populated,
        host: {
          ...populated.host,
          journal: { kind: "known", path: "octant.sqlite3" },
        },
      }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() => decodeHostDataMap({ ...populated, telemetry: false })).toThrow();
  });

  it("caps the Project list", () => {
    expect(MAX_HOST_DATA_MAP_PROJECTS).toBe(4_096);
  });
});
