import { describe, expect, it } from "vitest";
import { decodeHostId } from "@octant/contracts/host";
import { assertHostRoutable, HostNotRoutableError, listHosts, selectHost } from "./hostPolicy";

const LOCAL = decodeHostId("local");
const UNKNOWN = decodeHostId("remote-server-42");

describe("selectHost", () => {
  it("selects the single implicit local host when no host is requested", () => {
    const result = selectHost({});
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.host.hostId).toBe(LOCAL);
      expect(result.host.displayName).toBe("This computer");
      expect(result.host.health).toBe("healthy");
      expect(result.host.capabilities).toEqual(["chat", "work", "code"]);
    }
  });

  it("selects the local host when explicitly requested", () => {
    const result = selectHost({ requestedHostId: LOCAL });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.host.hostId).toBe(LOCAL);
    }
  });

  it("fails closed for an unknown host", () => {
    const result = selectHost({ requestedHostId: UNKNOWN });
    expect(result).toEqual({ kind: "rejected", reason: "unknown-host" });
  });

  it("selects the local host when a project fixes it", () => {
    const result = selectHost({ projectHostId: LOCAL });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.host.hostId).toBe(LOCAL);
    }
  });

  it("rejects when requested host mismatches the project-fixed host", () => {
    const result = selectHost({ requestedHostId: UNKNOWN, projectHostId: LOCAL });
    expect(result).toEqual({ kind: "rejected", reason: "unknown-host" });
  });

  it("fails closed when project fixes an unknown host", () => {
    const result = selectHost({ projectHostId: UNKNOWN });
    expect(result).toEqual({ kind: "rejected", reason: "unknown-host" });
  });
});

describe("listHosts", () => {
  it("returns exactly one healthy host in v1", () => {
    const hosts = listHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.hostId).toBe(LOCAL);
    expect(hosts[0]?.health).toBe("healthy");
    expect(hosts[0]?.displayName).toBe("This computer");
  });
});

describe("assertHostRoutable", () => {
  it("returns the host identity for the local host", () => {
    const host = assertHostRoutable(LOCAL);
    expect(host.hostId).toBe(LOCAL);
    expect(host.health).toBe("healthy");
  });

  it("throws HostNotRoutableError for an unknown host", () => {
    expect(() => assertHostRoutable(UNKNOWN)).toThrow(HostNotRoutableError);
    try {
      assertHostRoutable(UNKNOWN);
    } catch (error) {
      expect(error).toBeInstanceOf(HostNotRoutableError);
      expect((error as HostNotRoutableError).reason).toBe("unknown-host");
      expect((error as HostNotRoutableError).hostId).toBe(UNKNOWN);
    }
  });
});
