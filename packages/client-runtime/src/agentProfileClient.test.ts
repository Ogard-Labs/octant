import { decodeAgentProfileId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { AgentProfileClientFailure, createAgentProfileClient } from "./agentProfileClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const profileId = decodeAgentProfileId("00000000-0000-0000-0000-000000000001");
const ts = "2026-07-25T10:00:00.000Z";

function sampleProfile() {
  return {
    id: profileId,
    displayName: "Code Reviewer",
    approvedSkillIds: [],
    toolConstraints: [],
    modelConstraints: [],
    defaultExecutionPolicy: "approval-gated" as const,
    defaultPermissionPersistence: "current-session" as const,
    compatibleModes: ["code" as const],
    version: 1,
    createdAt: ts,
    updatedAt: ts,
  };
}

function receipt() {
  return {
    providerInstanceId: "00000000-0000-0000-0000-000000000030",
    modelId: "gpt-4",
    hostId: "local",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    effectivePermissions: {
      filesystem: true,
      shell: true,
      git: true,
      network: false,
      tools: true,
      subagents: false,
    },
    source: "user-default",
    fallbackChain: ["one-off-override", "project-default", "mode-default", "user-default"],
    downgradeReasons: [],
  };
}

describe("AgentProfileClient", () => {
  it("lists profiles with capability header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([sampleProfile()]));
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const profiles = await client.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.displayName).toBe("Code Reviewer");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-octant-window-capability": capability,
    });
  });

  it("reads a single profile by id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(sampleProfile()));
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const profile = await client.read(profileId);
    expect(profile?.id).toBe(profileId);
  });

  it("returns undefined for 404 on read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ category: "not-found", message: "Not found" }, { status: 404 }),
    );
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const profile = await client.read(profileId);
    expect(profile).toBeUndefined();
  });

  it("returns an empty profile list when an older host has no profile route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ category: "not-found", message: "Not found" }, { status: 404 }),
    );
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.list()).resolves.toEqual([]);
  });

  it("executes commands and returns typed results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ kind: "profile-created", profile: sampleProfile() }),
    );
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const result = await client.execute({
      kind: "create-agent-profile",
      displayName: "Reviewer",
      approvedSkillIds: [],
      toolConstraints: [],
      modelConstraints: [],
      defaultExecutionPolicy: "plan",
      defaultPermissionPersistence: "current-session",
      compatibleModes: ["code"],
      scope: { scopeKind: "user", scopeRef: "00000000-0000-0000-0000-000000000010" },
    });
    expect(result.kind).toBe("profile-created");
  });

  it("resolves effective profile and returns receipt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(receipt()));
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    const result = await client.resolveEffectiveProfile({
      mode: "code",
      hostId: "local",
      projectExecutionPolicy: "approval-gated",
      scope: { scopeKind: "user", scopeRef: "00000000-0000-0000-0000-000000000010" },
    });
    expect(result.source).toBe("user-default");
    expect(result.fallbackChain).toEqual([
      "one-off-override",
      "project-default",
      "mode-default",
      "user-default",
    ]);
  });

  it("maps stale-version service error to conflict category", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ reason: "stale-version", message: "Profile was modified." }, { status: 409 }),
    );
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.execute({ kind: "create-agent-profile" })).rejects.toMatchObject({
      category: "conflict",
      name: "AgentProfileClientFailure",
    });
  });

  it("maps unauthorized to correct category", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ category: "unauthorized", message: "Unauthorized." }, { status: 401 }),
    );
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.list()).rejects.toMatchObject({
      category: "unauthorized",
      name: "AgentProfileClientFailure",
    });
  });

  it("throws unavailable on network failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("network");
    });
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.list()).rejects.toMatchObject({
      category: "unavailable",
      name: "AgentProfileClientFailure",
    });
  });

  it("throws protocol on malformed response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ invalid: true }));
    const client = createAgentProfileClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.list()).rejects.toMatchObject({
      category: "protocol",
      name: "AgentProfileClientFailure",
    });
  });
});
