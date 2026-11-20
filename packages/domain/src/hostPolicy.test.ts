import { describe, expect, it } from "vitest";
import { decodeHostId } from "@octant/contracts/host";
import { listHosts } from "./hostPolicy";

const LOCAL = decodeHostId("local");

describe("listHosts", () => {
  it("returns exactly one healthy host in v1", () => {
    const hosts = listHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.hostId).toBe(LOCAL);
    expect(hosts[0]?.health).toBe("healthy");
    expect(hosts[0]?.displayName).toBe("This computer");
  });
});
