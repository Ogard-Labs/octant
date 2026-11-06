import { describe, expect, it } from "vitest";
import { connectorCatalog, featuredConnectors, searchConnectorCatalog } from "./connectorCatalog";

describe("the connectors catalog", () => {
  it("requires owned confidential client setup for HubSpot without inventing fixed scopes", () => {
    expect(connectorCatalog().find((entry) => entry.id === "hubspot")).toMatchObject({
      displayName: "HubSpot",
      url: "https://mcp.hubspot.com/",
      auth: {
        kind: "sign-in",
        clientSetup: "registered",
        permissionNotice: expect.stringContaining("read and write"),
      },
    });
    const entry = connectorCatalog().find((entry) => entry.id === "hubspot");
    expect(entry?.auth).not.toHaveProperty("requestedScopes");
    expect(featuredConnectors().map((entry) => entry.id)).not.toContain("hubspot");
  });

  it("requires separate public-client setup and read-only consent for each Google preview service", () => {
    const google = connectorCatalog().filter((entry) => entry.id.startsWith("google-"));
    expect(google).toHaveLength(3);
    expect(google.every((entry) => entry.displayName.endsWith(" preview"))).toBe(true);
    expect(new Set(google.map((entry) => entry.url)).size).toBe(3);
    for (const entry of google) {
      expect(entry.auth).toMatchObject({
        kind: "sign-in",
        clientSetup: "registered",
        permissionNotice: expect.stringContaining("Cannot"),
      });
    }
    expect(featuredConnectors().some((entry) => entry.id.startsWith("google-"))).toBe(false);
  });
  it("offers repository read/write as a separate explicit GitHub preset without changing PAT or profile-read identities", () => {
    const repository = connectorCatalog().find((entry) => entry.id === "github-repositories");
    expect(repository).toMatchObject({
      displayName: "GitHub repositories",
      url: "https://api.githubcopilot.com/mcp/",
      auth: {
        kind: "sign-in",
        clientSetup: "registered",
        requestedScopes: ["read:user", "repo", "offline_access"],
      },
    });
    if (repository === undefined || repository.auth.kind !== "sign-in")
      throw new Error("Expected explicit repository preset");
    expect(repository.auth.permissionNotice).toMatch(
      /read and write.*public and private repositories/i,
    );
    expect(connectorCatalog().find((entry) => entry.id === "github-oauth")?.auth).toMatchObject({
      requestedScopes: ["read:user", "offline_access"],
    });
    expect(connectorCatalog().find((entry) => entry.id === "github")?.auth.kind).toBe("key");
  });

  it("keeps GitHub PAT separate from the bounded registered OAuth App read profile", () => {
    const pat = connectorCatalog().find((entry) => entry.id === "github");
    const app = connectorCatalog().find((entry) => entry.id === "github-oauth");
    expect(pat?.auth).toMatchObject({ kind: "key", header: "Authorization", prefix: "Bearer" });
    expect(app).toMatchObject({
      displayName: "GitHub OAuth App",
      url: pat?.url,
      auth: {
        kind: "sign-in",
        clientSetup: "registered",
        requestedScopes: ["read:user", "offline_access"],
      },
    });
    expect(featuredConnectors().map((entry) => entry.id)).not.toContain("github-oauth");
  });

  it("requires person-owned app setup for Slack public search at the documented transport", () => {
    expect(connectorCatalog().find((entry) => entry.id === "slack")).toMatchObject({
      displayName: "Slack",
      url: "https://mcp.slack.com/mcp",
      auth: {
        kind: "sign-in",
        clientSetup: "registered",
        setupGuide: "https://docs.slack.dev/ai/slack-mcp-server/",
        requestedScopes: ["search:read.public"],
      },
    });
    expect(featuredConnectors().map((entry) => entry.id)).not.toContain("slack");
  });

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

  it("features a small hand-picked set from the bundled list, Doop among them", () => {
    const featured = featuredConnectors();
    expect(featured.length).toBeGreaterThanOrEqual(4);
    expect(featured.length).toBeLessThanOrEqual(8);
    expect(featured.map((entry) => entry.id)).toContain("doop");
    expect(featured.some((entry) => entry.auth.kind === "none")).toBe(true);
  });
});
