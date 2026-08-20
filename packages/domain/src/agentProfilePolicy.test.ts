import { describe, expect, it } from "vitest";
import type {
  AgentProfile,
  AgentProfileScope,
  ExecutionResolutionReceipt,
} from "@octant/contracts/agent-profile";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import type {
  ProviderCatalogSnapshot,
  ProviderInstance,
  ProviderModel,
} from "@octant/contracts/providers";
import type { OctantMode } from "@octant/contracts/modes";
import {
  AgentProfileRejected,
  applyProfileToThread,
  buildExecutionContextPickerEntries,
  filterExecutionContextPickerEntries,
  isModelAllowedByProfile,
  isProfileModeCompatible,
  profileScopeApplies,
  resolveEffectiveProfile,
  validateCapabilityConstraints,
  validateProfileAuthoritySafety,
  type ResolveEffectiveProfileInput,
} from "./agentProfilePolicy";

const ts = "2026-07-25T10:00:00.000Z";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "00000000-0000-0000-0000-000000000001" as AgentProfile["id"],
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
    ...overrides,
  };
}

function scope(overrides: Partial<AgentProfileScope> = {}): AgentProfileScope {
  return {
    scopeKind: "user",
    scopeRef: "00000000-0000-0000-0000-000000000010",
    ...overrides,
  };
}

function instance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: "00000000-0000-0000-0000-000000000003" as ProviderInstance["id"],
    displayName: "OpenAI",
    enabled: true,
    environmentPolicy: "inherit-host",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.openai.com/v1",
      authentication: "bearer",
      protocol: "chat-completions",
      manualModelIds: [],
    },
    version: 1 as AggregateVersion,
    createdAt: ts as UtcTimestamp,
    updatedAt: ts as UtcTimestamp,
    ...overrides,
  } as ProviderInstance;
}

function model(id: string, overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: id as ProviderModel["id"],
    displayName: id,
    reasoning: "supported",
    inputModalities: ["text"],
    options: [],
    source: "manual",
    verification: "unverified",
    ...overrides,
  } as ProviderModel;
}

function catalog(
  instanceId: string,
  models: ProviderModel[],
  overrides: Partial<ProviderCatalogSnapshot> = {},
): ProviderCatalogSnapshot {
  return {
    instanceId: instanceId as ProviderCatalogSnapshot["instanceId"],
    version: 1 as AggregateVersion,
    models,
    manualModelOrder: [],
    invalidated: false,
    updatedAt: ts as UtcTimestamp,
    ...overrides,
  };
}

describe("agentProfilePolicy", () => {
  describe("isProfileModeCompatible", () => {
    it("returns true when mode is in compatibleModes", () => {
      expect(isProfileModeCompatible(profile({ compatibleModes: ["code"] }), "code")).toBe(true);
    });

    it("returns false when mode is not in compatibleModes", () => {
      expect(isProfileModeCompatible(profile({ compatibleModes: ["code"] }), "chat")).toBe(false);
    });
  });

  describe("isModelAllowedByProfile", () => {
    it("allows all models when constraints are empty", () => {
      expect(isModelAllowedByProfile(profile({ modelConstraints: [] }), "gpt-4o" as never)).toBe(
        true,
      );
    });

    it("allows models in the constraint list", () => {
      expect(
        isModelAllowedByProfile(
          profile({ modelConstraints: ["gpt-4o" as never, "o3" as never] }),
          "gpt-4o" as never,
        ),
      ).toBe(true);
    });

    it("rejects models not in the constraint list", () => {
      expect(
        isModelAllowedByProfile(profile({ modelConstraints: ["gpt-4o" as never] }), "o3" as never),
      ).toBe(false);
    });
  });

  describe("validateProfileAuthoritySafety", () => {
    it("passes when profile policy does not exceed project policy", () => {
      expect(() =>
        validateProfileAuthoritySafety({
          profile: profile({ defaultExecutionPolicy: "plan" }),
          projectExecutionPolicy: "approval-gated",
        }),
      ).not.toThrow();
    });

    it("throws when profile policy exceeds project policy", () => {
      expect(() =>
        validateProfileAuthoritySafety({
          profile: profile({ defaultExecutionPolicy: "full-access" }),
          projectExecutionPolicy: "plan",
        }),
      ).toThrow(AgentProfileRejected);
    });
  });

  describe("buildExecutionContextPickerEntries", () => {
    it("builds entries for ready providers and compatible profiles", () => {
      const entries = buildExecutionContextPickerEntries({
        providers: [
          {
            instanceId: instance().id,
            displayName: "OpenAI",
            models: [model("gpt-4o")],
            readiness: "ready",
          },
        ],
        profiles: [profile({ compatibleModes: ["code"], modelConstraints: [] })],
        hostId: "local",
        hostLabel: "This Mac",
        mode: "code",
        projectExecutionPolicy: "approval-gated",
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.some((e) => e.modelId === "gpt-4o")).toBe(true);
    });

    it("skips unavailable providers", () => {
      const entries = buildExecutionContextPickerEntries({
        providers: [
          {
            instanceId: instance().id,
            displayName: "OpenAI",
            models: [model("gpt-4o")],
            readiness: "unavailable",
          },
        ],
        profiles: [],
        hostId: "local",
        hostLabel: "This Mac",
        mode: "code",
        projectExecutionPolicy: "approval-gated",
      });
      expect(entries).toEqual([]);
    });
  });

  describe("filterExecutionContextPickerEntries", () => {
    it("filters by query text", () => {
      const entries = buildExecutionContextPickerEntries({
        providers: [
          {
            instanceId: instance().id,
            displayName: "OpenAI",
            models: [model("gpt-4o"), model("o3")],
            readiness: "ready",
          },
        ],
        profiles: [],
        hostId: "local",
        hostLabel: "This Mac",
        mode: "code",
        projectExecutionPolicy: "approval-gated",
      });
      const filtered = filterExecutionContextPickerEntries(entries, "o3");
      expect(filtered.every((e) => e.modelId === "o3")).toBe(true);
    });
  });

  describe("validateCapabilityConstraints", () => {
    it("passes when model is in catalog and tool constraints are met", () => {
      const result = validateCapabilityConstraints({
        modelId: "gpt-4o" as never,
        catalog: catalog(instance().id, [model("gpt-4o")]),
        toolConstraints: [],
      });
      expect(result.ok).toBe(true);
    });

    it("fails when model is not in catalog", () => {
      const result = validateCapabilityConstraints({
        modelId: "unknown-model" as never,
        catalog: catalog(instance().id, [model("gpt-4o")]),
        toolConstraints: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("not in");
    });

    it("fails when model is unavailable (catalog invalidated)", () => {
      const result = validateCapabilityConstraints({
        modelId: "gpt-4o" as never,
        catalog: catalog(instance().id, [model("gpt-4o")], { invalidated: true }),
        toolConstraints: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("unavailable");
    });
  });

  describe("resolveEffectiveProfile", () => {
    const baseInput = (
      overrides: Partial<ResolveEffectiveProfileInput> = {},
    ): ResolveEffectiveProfileInput => ({
      mode: "code" as OctantMode,
      hostId: "local" as never,
      projectExecutionPolicy: "approval-gated",
      providers: [instance().id],
      catalogs: [catalog(instance().id, [model("gpt-4o")])],
      profiles: [],
      ...overrides,
    });

    it("resolves one-off thread override first", () => {
      const oneOff = profile({
        id: "00000000-0000-0000-0000-000000000099" as AgentProfile["id"],
        defaultExecutionPolicy: "plan",
        compatibleModes: ["code"],
      });
      const userDefault = profile({
        id: "00000000-0000-0000-0000-000000000010" as AgentProfile["id"],
        defaultExecutionPolicy: "full-access",
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          oneOffOverride: {
            profile: oneOff,
            providerInstanceId: instance().id,
            modelId: "gpt-4o" as never,
          },
          profiles: [{ profile: userDefault, scope: scope({ scopeKind: "user" }) }],
        }),
      );
      expect(receipt.source).toBe("one-off-override");
      expect(receipt.profileId).toBe(oneOff.id);
      expect(receipt.executionPolicy).toBe("plan");
    });

    it("resolves project default when no one-off override", () => {
      const projectProfile = profile({
        id: "00000000-0000-0000-0000-000000000020" as AgentProfile["id"],
        defaultExecutionPolicy: "approval-gated",
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          projectDefault: {
            profile: projectProfile,
            providerInstanceId: instance().id,
            modelId: "gpt-4o" as never,
          },
          profiles: [],
        }),
      );
      expect(receipt.source).toBe("project-default");
      expect(receipt.profileId).toBe(projectProfile.id);
    });

    it("resolves mode default when no project default or one-off", () => {
      const modeProfile = profile({
        id: "00000000-0000-0000-0000-000000000030" as AgentProfile["id"],
        defaultExecutionPolicy: "plan",
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          modeDefault: {
            profile: modeProfile,
            providerInstanceId: instance().id,
            modelId: "gpt-4o" as never,
          },
          profiles: [],
        }),
      );
      expect(receipt.source).toBe("mode-default");
      expect(receipt.profileId).toBe(modeProfile.id);
    });

    it("resolves user default when no more specific profile", () => {
      const userProfile = profile({
        id: "00000000-0000-0000-0000-000000000040" as AgentProfile["id"],
        defaultExecutionPolicy: "approval-gated",
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          profiles: [{ profile: userProfile, scope: scope({ scopeKind: "user" }) }],
        }),
      );
      expect(receipt.source).toBe("user-default");
      expect(receipt.profileId).toBe(userProfile.id);
    });

    it("resolves to none with no implicit privileged fallback", () => {
      const receipt = resolveEffectiveProfile(baseInput({ profiles: [] }));
      expect(receipt.source).toBe("none");
      expect(receipt.profileId).toBeUndefined();
      expect(receipt.executionPolicy).toBe("approval-gated");
    });

    it("downgrades one-off override when provider is unavailable and falls to project default", () => {
      const unavailableProvider = "00000000-0000-0000-0000-000000000004" as ProviderInstance["id"];
      const oneOff = profile({
        id: "00000000-0000-0000-0000-000000000099" as AgentProfile["id"],
        compatibleModes: ["code"],
      });
      const projectProfile = profile({
        id: "00000000-0000-0000-0000-000000000020" as AgentProfile["id"],
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          oneOffOverride: {
            profile: oneOff,
            providerInstanceId: unavailableProvider,
            modelId: "gpt-4o" as never,
          },
          projectDefault: {
            profile: projectProfile,
            providerInstanceId: instance().id,
            modelId: "gpt-4o" as never,
          },
          profiles: [],
        }),
      );
      expect(receipt.source).toBe("project-default");
      expect(receipt.downgradeReasons.some((r) => r.step === "one-off-override")).toBe(true);
    });

    it("downgrades when model is not in catalog and records reason", () => {
      const projectProfile = profile({
        id: "00000000-0000-0000-0000-000000000020" as AgentProfile["id"],
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          catalogs: [catalog(instance().id, [model("gpt-4o")])],
          projectDefault: {
            profile: projectProfile,
            providerInstanceId: instance().id,
            modelId: "unknown-model" as never,
          },
          profiles: [],
        }),
      );
      expect(receipt.source).not.toBe("project-default");
      expect(receipt.downgradeReasons.some((r) => r.step === "project-default")).toBe(true);
    });

    it("fails closed without changing authority when all sources unavailable", () => {
      const receipt = resolveEffectiveProfile(
        baseInput({
          providers: [],
          catalogs: [],
          profiles: [],
        }),
      );
      expect(receipt.source).toBe("none");
      expect(receipt.executionPolicy).toBe("approval-gated");
      expect(receipt.downgradeReasons.length).toBeGreaterThanOrEqual(0);
    });

    it("preserves explicit thread override even when provider is available", () => {
      const oneOff = profile({
        id: "00000000-0000-0000-0000-000000000099" as AgentProfile["id"],
        defaultExecutionPolicy: "plan",
        compatibleModes: ["code"],
      });
      const userDefault = profile({
        id: "00000000-0000-0000-0000-000000000010" as AgentProfile["id"],
        defaultExecutionPolicy: "full-access",
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          oneOffOverride: {
            profile: oneOff,
            providerInstanceId: instance().id,
            modelId: "gpt-4o" as never,
          },
          profiles: [{ profile: userDefault, scope: scope({ scopeKind: "user" }) }],
        }),
      );
      expect(receipt.source).toBe("one-off-override");
      expect(receipt.executionPolicy).toBe("plan");
    });

    it("rejects profile that would escalate authority beyond project policy", () => {
      const userProfile = profile({
        id: "00000000-0000-0000-0000-000000000040" as AgentProfile["id"],
        defaultExecutionPolicy: "full-access",
        compatibleModes: ["code"],
      });
      const receipt = resolveEffectiveProfile(
        baseInput({
          projectExecutionPolicy: "plan",
          profiles: [{ profile: userProfile, scope: scope({ scopeKind: "user" }) }],
        }),
      );
      expect(receipt.source).toBe("none");
      expect(receipt.downgradeReasons.some((r) => r.step === "user-default")).toBe(true);
    });

    it("produces a deterministic fallback chain in priority order", () => {
      const receipt = resolveEffectiveProfile(
        baseInput({
          providers: [],
          catalogs: [],
          profiles: [],
        }),
      );
      expect(receipt.fallbackChain).toEqual([
        "one-off-override",
        "project-default",
        "mode-default",
        "user-default",
      ]);
    });
  });
});

describe("profileScopeApplies", () => {
  it("lets a user-wide profile start any thread", () => {
    expect(
      profileScopeApplies({
        scope: scope({ scopeKind: "user", scopeRef: "local-user" }),
        mode: "code",
        projectId: "project-a",
        threadId: "thread-a",
      }),
    ).toBe(true);
  });

  it("refuses a profile another Project owns", () => {
    expect(
      profileScopeApplies({
        scope: scope({ scopeKind: "project", scopeRef: "project-b" }),
        mode: "code",
        projectId: "project-a",
        threadId: "thread-a",
      }),
    ).toBe(false);
  });

  it("refuses a profile written for a different mode", () => {
    expect(
      profileScopeApplies({
        scope: scope({ scopeKind: "mode", scopeRef: "chat" }),
        mode: "code",
        projectId: "project-a",
        threadId: "thread-a",
      }),
    ).toBe(false);
  });

  it("refuses a one-off profile that belongs to another thread", () => {
    expect(
      profileScopeApplies({
        scope: scope({ scopeKind: "one-off", scopeRef: "thread-b" }),
        mode: "code",
        projectId: "project-a",
        threadId: "thread-a",
      }),
    ).toBe(false);
  });

  it("lets a one-off profile start the thread it was made for", () => {
    expect(
      profileScopeApplies({
        scope: scope({ scopeKind: "one-off", scopeRef: "thread-a" }),
        mode: "code",
        projectId: "project-a",
        threadId: "thread-a",
      }),
    ).toBe(true);
  });
});

describe("applyProfileToThread", () => {
  it("keeps the stricter of the thread's posture and the profile's", () => {
    const applied = applyProfileToThread({
      profile: profile({ defaultExecutionPolicy: "approval-gated" }),
      mode: "code",
      modelId: "gpt-5.6-luna" as ProviderModel["id"],
      requestedExecutionPolicy: "full-access",
      requestedPermissionPersistence: "current-session",
      projectExecutionPolicy: "full-access",
    });

    expect(applied).toEqual({
      status: "applied",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    });
  });

  it("leaves a thread that already asks for less than the profile allows alone", () => {
    const applied = applyProfileToThread({
      profile: profile({ defaultExecutionPolicy: "full-access" }),
      mode: "code",
      modelId: "gpt-5.6-luna" as ProviderModel["id"],
      requestedExecutionPolicy: "plan",
      requestedPermissionPersistence: "current-session",
      projectExecutionPolicy: "full-access",
    });

    expect(applied).toEqual({
      status: "applied",
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    });
  });

  it("refuses a profile whose posture reaches past the Project's", () => {
    const applied = applyProfileToThread({
      profile: profile({ defaultExecutionPolicy: "full-access" }),
      mode: "code",
      modelId: "gpt-5.6-luna" as ProviderModel["id"],
      requestedExecutionPolicy: "approval-gated",
      requestedPermissionPersistence: "current-session",
      projectExecutionPolicy: "approval-gated",
    });

    expect(applied.status).toBe("refused");
    expect(applied.status === "refused" ? applied.code : undefined).toBe("authority-escalation");
  });

  it("keeps the shorter of the thread's permission duration and the profile's", () => {
    const applied = applyProfileToThread({
      profile: profile({
        defaultExecutionPolicy: "full-access",
        defaultPermissionPersistence: "current-session",
      }),
      mode: "code",
      modelId: "gpt-5.6-luna" as ProviderModel["id"],
      requestedExecutionPolicy: "full-access",
      requestedPermissionPersistence: "project-default",
      projectExecutionPolicy: "full-access",
    });

    expect(applied).toEqual({
      status: "applied",
      executionPolicy: "full-access",
      permissionPersistence: "current-session",
    });
  });

  it("leaves a thread that already asks for the shorter duration alone", () => {
    const applied = applyProfileToThread({
      profile: profile({ defaultPermissionPersistence: "project-default" }),
      mode: "code",
      modelId: "gpt-5.6-luna" as ProviderModel["id"],
      requestedExecutionPolicy: "approval-gated",
      requestedPermissionPersistence: "current-session",
      projectExecutionPolicy: "approval-gated",
    });

    expect(applied).toMatchObject({ permissionPersistence: "current-session" });
  });

  it("refuses a profile that was not written for this mode", () => {
    const applied = applyProfileToThread({
      profile: profile({ compatibleModes: ["chat"] }),
      mode: "code",
      modelId: "gpt-5.6-luna" as ProviderModel["id"],
      requestedExecutionPolicy: "approval-gated",
      requestedPermissionPersistence: "current-session",
      projectExecutionPolicy: "approval-gated",
    });

    expect(applied.status).toBe("refused");
    expect(applied.status === "refused" ? applied.code : undefined).toBe("mode-incompatible");
  });

  it("refuses a model the profile does not list", () => {
    const applied = applyProfileToThread({
      profile: profile({ modelConstraints: ["gpt-5.6-sol" as ProviderModel["id"]] }),
      mode: "code",
      modelId: "gpt-5.6-luna" as ProviderModel["id"],
      requestedExecutionPolicy: "approval-gated",
      requestedPermissionPersistence: "current-session",
      projectExecutionPolicy: "approval-gated",
    });

    expect(applied.status).toBe("refused");
    expect(applied.status === "refused" ? applied.code : undefined).toBe("model-not-allowed");
  });
});
