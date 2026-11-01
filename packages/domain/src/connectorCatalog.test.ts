import { describe, expect, it } from "vitest";
import { connectorCatalog, searchConnectorCatalog } from "./connectorCatalog";

describe("the connectors catalog", () => {
  it("names each connector once, at an https address, with a key page for every key entry", () => {
    const entries = connectorCatalog();
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      expect(new URL(entry.url).protocol).toBe("https:");
      expect(entry.description.length).toBeLessThanOrEqual(120);
      if (entry.auth.kind === "key") {
        expect(new URL(entry.auth.keyPage).protocol).toBe("https:");
        expect(entry.auth.header.length).toBeGreaterThan(0);
      }
    }
  });

  it("searches by name or description and lists everything for an empty query", () => {
    expect(searchConnectorCatalog("  ").length).toBe(connectorCatalog().length);
    expect(searchConnectorCatalog("postgres").map((entry) => entry.id)).toEqual([
      "supabase",
      "neon",
      "prisma",
    ]);
    expect(searchConnectorCatalog("LINEAR").map((entry) => entry.id)).toEqual(["linear"]);
  });

  it("lists Doop as a sign-in connector at its own address", () => {
    const doop = connectorCatalog().find((entry) => entry.id === "doop");
    expect(doop).toMatchObject({
      displayName: "Doop",
      url: "https://doop.design/mcp",
      auth: { kind: "sign-in" },
    });
    expect(searchConnectorCatalog("doop").map((entry) => entry.id)).toEqual(["doop"]);
  });
});
