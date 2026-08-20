import {
  decodeAgentProfileId,
  type AgentProfile,
  type AgentProfileScope,
  type ExecutionResolutionReceipt,
} from "@octant/contracts";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyConflict } from "./persistence/journalErrors";
import type { PersistenceService } from "./persistence/persistenceService";
import { ProjectionApplicationFailed } from "./persistence/projection";
import { AgentProfileService, AgentProfileServiceError } from "./agentProfileService";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

const ts = "2026-07-25T10:00:00.000Z";
const profileId = decodeAgentProfileId("00000000-0000-0000-0000-000000000001");
const userScope: AgentProfileScope = {
  scopeKind: "user",
  scopeRef: "00000000-0000-0000-0000-000000000010",
};

describe("AgentProfileService", () => {
  it("lists profiles from persistence", async () => {
    const fixture = fixtureService({ profiles: [sampleProfile()] });
    const result = await fixture.service.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("Code Reviewer");
  });

  it("reads a single profile by id", async () => {
    const fixture = fixtureService({ profiles: [sampleProfile()] });
    const result = await fixture.service.read(profileId);
    expect(result?.id).toBe(profileId);
  });

  it("creates a profile with local-user events and optimistic version", async () => {
    const fixture = fixtureService();
    const result = await fixture.service.execute({
      kind: "create-agent-profile",
      displayName: "Reviewer",
      approvedSkillIds: [],
      toolConstraints: [],
      modelConstraints: [],
      defaultExecutionPolicy: "plan",
      defaultPermissionPersistence: "current-session",
      compatibleModes: ["code"],
      scope: userScope,
    });
    expect(result.kind).toBe("profile-created");
    if (result.kind === "profile-created") {
      expect(result.profile.displayName).toBe("Reviewer");
      expect(result.profile.version).toBe(1);
    }
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      aggregate: { aggregateType: "agent-profile" },
      expectedVersion: 0,
      events: [
        {
          eventName: "agent.profile-created@1",
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        },
      ],
    });
  });

  it("updates a profile with version increment", async () => {
    const fixture = fixtureService({ profiles: [sampleProfile()] });
    const result = await fixture.service.execute({
      kind: "update-agent-profile",
      profileId,
      expectedVersion: 1,
      displayName: "Reviewer v2",
    });
    expect(result.kind).toBe("profile-updated");
    if (result.kind === "profile-updated") {
      expect(result.profile.displayName).toBe("Reviewer v2");
      expect(result.profile.version).toBe(2);
    }
  });

  it("keeps a scoped profile with its owner when it is edited", async () => {
    const scope = { scopeKind: "project", scopeRef: "project-a" };
    const fixture = fixtureService({ profiles: [sampleProfile()], scope });
    await fixture.service.execute({
      kind: "update-agent-profile",
      profileId,
      expectedVersion: 1,
      displayName: "Reviewer v2",
    });

    // A profile relabelled user-wide on every edit is a profile any Project
    // could then bind, which is the partition scopes exist to hold.
    expect(fixture.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        events: [expect.objectContaining({ payload: expect.objectContaining({ scope }) })],
      }),
    );
  });

  it("removes a profile", async () => {
    const fixture = fixtureService({ profiles: [sampleProfile()] });
    const result = await fixture.service.execute({
      kind: "remove-agent-profile",
      profileId,
      expectedVersion: 1,
    });
    expect(result.kind).toBe("profile-removed");
  });

  it("rejects stale version on update", async () => {
    const fixture = fixtureService({ profiles: [sampleProfile()] });
    await expect(
      fixture.service.execute({
        kind: "update-agent-profile",
        profileId,
        expectedVersion: 0,
        displayName: "Stale",
      }),
    ).rejects.toMatchObject({ failure: { reason: "stale-version" } });
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("rejects update of missing profile", async () => {
    const fixture = fixtureService({ profiles: [] });
    await expect(
      fixture.service.execute({
        kind: "update-agent-profile",
        profileId,
        expectedVersion: 1,
        displayName: "Missing",
      }),
    ).rejects.toMatchObject({ failure: { reason: "invalid" } });
  });

  it("rejects duplicate profile id on create", async () => {
    const fixture = fixtureService({ profiles: [sampleProfile()] });
    await expect(
      fixture.service.execute({
        kind: "create-agent-profile",
        profileId,
        displayName: "Duplicate",
        approvedSkillIds: [],
        toolConstraints: [],
        modelConstraints: [],
        defaultExecutionPolicy: "plan",
        defaultPermissionPersistence: "current-session",
        compatibleModes: ["code"],
        scope: userScope,
      }),
    ).rejects.toMatchObject({ failure: { reason: "invalid" } });
  });

  it("maps ConcurrencyConflict to stale-version failure", async () => {
    const fixture = fixtureService({
      profiles: [sampleProfile()],
      appendError: new ConcurrencyConflict({
        aggregateType: "agent-profile",
        aggregateId: profileId,
        expectedVersion: 1,
        actualVersion: 2,
      }),
    });
    await expect(
      fixture.service.execute({
        kind: "update-agent-profile",
        profileId,
        expectedVersion: 1,
        displayName: "Raced",
      }),
    ).rejects.toMatchObject({ failure: { reason: "stale-version" } });
  });

  it("maps JournalWriteFailed to failed result", async () => {
    const { JournalWriteFailed } = await import("./persistence/journalErrors");
    const fixture = fixtureService({
      profiles: [sampleProfile()],
      appendError: new JournalWriteFailed({ operation: "append" }),
    });
    await expect(
      fixture.service.execute({
        kind: "update-agent-profile",
        profileId,
        expectedVersion: 1,
        displayName: "Failed",
      }),
    ).rejects.toMatchObject({ failure: { reason: "invalid" } });
  });

  it("resolves effective profile with receipt", async () => {
    const fixture = fixtureService({ profiles: [sampleProfile()] });
    const receipt = await fixture.service.resolveEffectiveProfile({
      mode: "code",
      hostId: "local",
      projectExecutionPolicy: "approval-gated",
      scope: userScope,
    });
    expect(receipt.source).toBeDefined();
    expect(receipt.fallbackChain).toEqual([
      "one-off-override",
      "project-default",
      "mode-default",
      "user-default",
    ]);
  });
});

function sampleProfile(): AgentProfile {
  return {
    id: profileId,
    displayName: "Code Reviewer",
    approvedSkillIds: [],
    toolConstraints: [],
    modelConstraints: [],
    defaultExecutionPolicy: "approval-gated",
    defaultPermissionPersistence: "current-session",
    compatibleModes: ["code"],
    version: 1 as AggregateVersion,
    createdAt: ts as UtcTimestamp,
    updatedAt: ts as UtcTimestamp,
  };
}

function fixtureService(
  options: {
    profiles?: AgentProfile[];
    appendError?: Error;
    scope?: { scopeKind: string; scopeRef: string };
  } = {},
) {
  const profiles = [...(options.profiles ?? [])];
  const append = vi.fn((request: any) => {
    if (options.appendError !== undefined) throw options.appendError;
    const payload = request.events[0].payload as {
      profile?: AgentProfile;
      profileId?: string;
      version?: number;
    };
    if (payload.profile !== undefined) {
      const index = profiles.findIndex((p) => p.id === payload.profile!.id);
      if (index === -1) profiles.push(payload.profile);
      else profiles[index] = payload.profile;
      return { aggregateVersion: payload.profile.version };
    }
    if (payload.profileId !== undefined) {
      const index = profiles.findIndex((p) => String(p.id) === String(payload.profileId));
      if (index !== -1) profiles.splice(index, 1);
      return { aggregateVersion: payload.version };
    }
    return { aggregateVersion: 0 };
  });
  const persistence = {
    journal: { append },
    readAgentProfile: (id: typeof profileId) => profiles.find((p) => String(p.id) === String(id)),
    readAgentProfileBinding: (id: typeof profileId) => {
      const profile = profiles.find((p) => String(p.id) === String(id));
      return profile === undefined
        ? undefined
        : { profile, scope: options.scope ?? { scopeKind: "user", scopeRef: "local-user" } };
    },
    readAgentProfiles: () => [...profiles],
    readProfilesForScope: (_scopeKind: string, _scopeRef: string) => [...profiles],
    readProviderInstances: () => [{ id: "00000000-0000-0000-0000-000000000030", enabled: true }],
    readProviderCatalogs: () => [
      {
        instanceId: "00000000-0000-0000-0000-000000000030",
        invalidated: false,
        models: [{ id: "gpt-4", displayName: "GPT-4" }],
      },
    ],
    status: () => ({ state: "current", integrity: "ok" }),
  } as unknown as PersistenceService;
  return {
    append,
    service: new AgentProfileService({
      persistence,
      uuid: uuidSequence(),
      clock: () => ts,
    }),
  };
}

function uuidSequence() {
  let value = 800;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}
