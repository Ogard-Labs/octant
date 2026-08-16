import { describe, expect, it } from "vitest";
import { decodeHostId, LOCAL_HOST_ID, type HostIdentity } from "@octant/contracts/host";
import {
  hostCreateDisableReason,
  listCreateHostOptions,
  preselectCreateHost,
  selectCreateHost,
} from "./hostCreateSelectionPolicy";

const LOCAL = LOCAL_HOST_ID;
const STUDIO = decodeHostId("11111111-1111-4111-8111-111111111111");
const LAPTOP = decodeHostId("22222222-2222-4222-8222-222222222222");

function host(
  hostId: HostIdentity["hostId"],
  health: HostIdentity["health"],
  displayName: string,
  capabilities: ReadonlyArray<string> = ["chat", "work", "code"],
): HostIdentity {
  return { hostId, displayName, health, capabilities };
}

const healthyLocal = host(LOCAL, "healthy", "This Mac");
const healthyStudio = host(STUDIO, "healthy", "Studio");
const staleLaptop = host(LAPTOP, "stale", "Laptop");
const incompatibleStudio = host(STUDIO, "incompatible", "Studio");
const unauthorizedLaptop = host(LAPTOP, "unauthorized", "Laptop");
const chatOnlyStudio = host(STUDIO, "healthy", "Studio", ["chat"]);

describe("listCreateHostOptions", () => {
  it("marks healthy hosts selectable and unhealthy hosts disabled with a concrete reason", () => {
    const options = listCreateHostOptions([healthyLocal, staleLaptop, incompatibleStudio]);
    expect(options).toEqual([
      { host: healthyLocal, selectable: true },
      {
        host: staleLaptop,
        selectable: false,
        disabledReason: "Stale connection",
      },
      {
        host: incompatibleStudio,
        selectable: false,
        disabledReason: "Incompatible host",
      },
    ]);
  });

  it("disables hosts missing the required capability", () => {
    const options = listCreateHostOptions([healthyLocal, chatOnlyStudio], {
      requiredCapability: "code",
    });
    expect(options[1]).toEqual({
      host: chatOnlyStudio,
      selectable: false,
      disabledReason: "Does not support code",
    });
  });

  it("marks a project-fixed host as fixed even when unhealthy", () => {
    const options = listCreateHostOptions([unauthorizedLaptop], {
      projectHostId: LAPTOP,
    });
    expect(options).toEqual([
      {
        host: unauthorizedLaptop,
        selectable: false,
        disabledReason: "Unauthorized",
        fixed: true,
      },
    ]);
  });
});

describe("preselectCreateHost", () => {
  it("preselects the most recently selected healthy host in All Hosts scope", () => {
    const result = preselectCreateHost({
      hosts: [healthyLocal, healthyStudio, staleLaptop],
      viewScope: { kind: "all-hosts" },
      lastSelectedHealthyHostId: STUDIO,
    });
    expect(result).toEqual({ kind: "selected", host: healthyStudio });
  });

  it("falls back to the first healthy host when the last selection is unhealthy or missing", () => {
    const result = preselectCreateHost({
      hosts: [staleLaptop, healthyLocal, healthyStudio],
      viewScope: { kind: "all-hosts" },
      lastSelectedHealthyHostId: LAPTOP,
    });
    expect(result).toEqual({ kind: "selected", host: healthyLocal });
  });

  it("preselects the filtered host in a host-filtered view", () => {
    const result = preselectCreateHost({
      hosts: [healthyLocal, healthyStudio],
      viewScope: { kind: "host-filter", hostId: STUDIO },
      lastSelectedHealthyHostId: LOCAL,
    });
    expect(result).toEqual({ kind: "selected", host: healthyStudio });
  });

  it("fixes selection to the Project host and ignores view scope or last selection", () => {
    const result = preselectCreateHost({
      hosts: [healthyLocal, healthyStudio],
      viewScope: { kind: "host-filter", hostId: LOCAL },
      lastSelectedHealthyHostId: LOCAL,
      projectHostId: STUDIO,
    });
    expect(result).toEqual({ kind: "selected", host: healthyStudio });
  });

  it("rejects when no routable host is available", () => {
    const result = preselectCreateHost({
      hosts: [staleLaptop, unauthorizedLaptop],
      viewScope: { kind: "all-hosts" },
    });
    expect(result.kind).toBe("rejected");
  });

  it("still accepts multi-host input while collapsing to the single healthy host", () => {
    const result = preselectCreateHost({
      hosts: [healthyLocal],
      viewScope: { kind: "all-hosts" },
      lastSelectedHealthyHostId: STUDIO,
    });
    expect(result).toEqual({ kind: "selected", host: healthyLocal });
  });
});

describe("selectCreateHost", () => {
  it("accepts an explicit healthy selection until create", () => {
    const result = selectCreateHost({
      hosts: [healthyLocal, healthyStudio],
      requestedHostId: STUDIO,
    });
    expect(result).toEqual({ kind: "selected", host: healthyStudio });
  });

  it("rejects changing away from a Project-fixed host", () => {
    const result = selectCreateHost({
      hosts: [healthyLocal, healthyStudio],
      requestedHostId: LOCAL,
      projectHostId: STUDIO,
    });
    expect(result).toEqual({ kind: "rejected", reason: "project-host-mismatch" });
  });

  it("rejects unhealthy hosts with a health-derived reason", () => {
    expect(
      selectCreateHost({
        hosts: [staleLaptop],
        requestedHostId: LAPTOP,
      }),
    ).toEqual({ kind: "rejected", reason: "host-unavailable" });
    expect(
      selectCreateHost({
        hosts: [incompatibleStudio],
        requestedHostId: STUDIO,
      }),
    ).toEqual({ kind: "rejected", reason: "host-incompatible" });
  });
});

describe("hostCreateDisableReason", () => {
  it("maps every non-healthy state to a concrete user-facing reason", () => {
    expect(hostCreateDisableReason(host(LOCAL, "connecting", "This Mac"))).toBe("Connecting");
    expect(hostCreateDisableReason(host(LOCAL, "stale", "This Mac"))).toBe("Stale connection");
    expect(hostCreateDisableReason(host(LOCAL, "incompatible", "This Mac"))).toBe(
      "Incompatible host",
    );
    expect(hostCreateDisableReason(host(LOCAL, "unauthorized", "This Mac"))).toBe("Unauthorized");
    expect(hostCreateDisableReason(host(LOCAL, "unavailable", "This Mac"))).toBe(
      "Host unavailable",
    );
    expect(hostCreateDisableReason(healthyLocal)).toBeUndefined();
  });
});
