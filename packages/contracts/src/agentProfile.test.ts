import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_EVENT_NAMES,
  decodeAgentProfile,
  decodeAgentProfileCommand,
  decodeAgentProfileCommandResult,
  decodeAgentProfileCreated,
  decodeAgentProfileRemoved,
  decodeAgentProfileScope,
  decodeAgentProfileUpdated,
  decodeExecutionContext,
  decodeExecutionContextPickerEntry,
  decodeExecutionResolutionReceipt,
  decodeProfileScopeKind,
} from "./agentProfile";

const ts = "2026-07-25T10:00:00.000Z";

describe("agentProfile contracts", () => {
  it("decodes a valid agent profile", () => {
    const profile = decodeAgentProfile({
      id: "00000000-0000-0000-0000-000000000001",
      displayName: "Code Reviewer",
      instructions: "You are a code reviewer.",
      approvedSkillIds: ["code-reviewer"],
      toolConstraints: ["read-file", "search"],
      modelConstraints: ["gpt-4o"],
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      compatibleModes: ["code"],
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    });
    expect(profile.displayName).toBe("Code Reviewer");
    expect(profile.compatibleModes).toEqual(["code"]);
  });

  it("decodes a profile without optional fields", () => {
    const profile = decodeAgentProfile({
      id: "00000000-0000-0000-0000-000000000001",
      displayName: "Minimal",
      approvedSkillIds: [],
      toolConstraints: [],
      modelConstraints: [],
      defaultExecutionPolicy: "plan",
      defaultPermissionPersistence: "current-session",
      compatibleModes: ["chat", "work", "code"],
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    });
    expect(profile.instructions).toBeUndefined();
    expect(profile.description).toBeUndefined();
  });

  it("decodes execution context", () => {
    const ctx = decodeExecutionContext({
      providerInstanceId: "00000000-0000-0000-0000-000000000003",
      modelId: "gpt-4o",
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
    });
    expect(ctx.effectivePermissions.filesystem).toBe(true);
    expect(ctx.profileId).toBeUndefined();
  });

  it("decodes execution context with profile", () => {
    const ctx = decodeExecutionContext({
      providerInstanceId: "00000000-0000-0000-0000-000000000003",
      modelId: "gpt-4o",
      profileId: "00000000-0000-0000-0000-000000000001",
      hostId: "local",
      executionPolicy: "plan",
      permissionPersistence: "current-session",
      effectivePermissions: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: false,
        subagents: false,
      },
    });
    expect(ctx.profileId).toBeDefined();
  });

  it("decodes execution context picker entry", () => {
    const entry = decodeExecutionContextPickerEntry({
      providerInstanceId: "00000000-0000-0000-0000-000000000003",
      providerDisplayName: "OpenAI",
      modelId: "gpt-4o",
      modelDisplayName: "GPT-4o",
      hostId: "local",
      hostLabel: "This Mac",
      executionPolicy: "approval-gated",
      effectivePermissions: {
        filesystem: true,
        shell: true,
        git: true,
        network: false,
        tools: true,
        subagents: false,
      },
    });
    expect(entry.providerDisplayName).toBe("OpenAI");
  });

  it("decodes create profile command", () => {
    const cmd = decodeAgentProfileCommand({
      kind: "create-agent-profile",
      profileId: "00000000-0000-0000-0000-000000000001",
      scope: {
        scopeKind: "user",
        scopeRef: "00000000-0000-0000-0000-000000000010",
      },
      displayName: "Reviewer",
      approvedSkillIds: [],
      toolConstraints: [],
      modelConstraints: [],
      defaultExecutionPolicy: "plan",
      defaultPermissionPersistence: "current-session",
      compatibleModes: ["code"],
    });
    expect(cmd.kind).toBe("create-agent-profile");
  });

  it("decodes profile command result", () => {
    const result = decodeAgentProfileCommandResult({
      kind: "profile-command-failed",
      reason: "stale-version",
      message: "Profile was modified by another session.",
    });
    expect(result.kind).toBe("profile-command-failed");
  });

  it("exposes AGENT_PROFILE_EVENT_NAMES with created/updated/removed", () => {
    expect(AGENT_PROFILE_EVENT_NAMES).toEqual([
      "agent.profile-created@1",
      "agent.profile-updated@1",
      "agent.profile-removed@1",
    ]);
  });

  it("decodes agent.profile-created event payload", () => {
    const event = decodeAgentProfileCreated({
      profile: {
        id: "00000000-0000-0000-0000-000000000001",
        displayName: "Reviewer",
        approvedSkillIds: [],
        toolConstraints: [],
        modelConstraints: [],
        defaultExecutionPolicy: "plan",
        defaultPermissionPersistence: "current-session",
        compatibleModes: ["code"],
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      },
      scope: {
        scopeKind: "user",
        scopeRef: "00000000-0000-0000-0000-000000000010",
      },
    });
    expect(event.profile.displayName).toBe("Reviewer");
    expect(event.scope.scopeKind).toBe("user");
  });

  it("decodes agent.profile-updated event payload", () => {
    const event = decodeAgentProfileUpdated({
      profile: {
        id: "00000000-0000-0000-0000-000000000001",
        displayName: "Reviewer v2",
        approvedSkillIds: [],
        toolConstraints: [],
        modelConstraints: [],
        defaultExecutionPolicy: "plan",
        defaultPermissionPersistence: "current-session",
        compatibleModes: ["code"],
        version: 2,
        createdAt: ts,
        updatedAt: ts,
      },
      scope: {
        scopeKind: "project",
        scopeRef: "00000000-0000-0000-0000-000000000020",
      },
    });
    expect(event.profile.version).toBe(2);
    expect(event.scope.scopeKind).toBe("project");
  });

  it("decodes agent.profile-removed event payload", () => {
    const event = decodeAgentProfileRemoved({
      profileId: "00000000-0000-0000-0000-000000000001",
      version: 3,
    });
    expect(event.profileId).toBeDefined();
    expect(event.version).toBe(3);
  });

  it("decodes profile scope kind literals", () => {
    expect(decodeProfileScopeKind("user")).toBe("user");
    expect(decodeProfileScopeKind("mode")).toBe("mode");
    expect(decodeProfileScopeKind("project")).toBe("project");
    expect(decodeProfileScopeKind("one-off")).toBe("one-off");
  });

  it("decodes agent profile scope", () => {
    const scope = decodeAgentProfileScope({
      scopeKind: "mode",
      scopeRef: "code",
    });
    expect(scope.scopeKind).toBe("mode");
    expect(scope.scopeRef).toBe("code");
  });

  it("decodes execution resolution receipt with full chain", () => {
    const receipt = decodeExecutionResolutionReceipt({
      providerInstanceId: "00000000-0000-0000-0000-000000000003",
      modelId: "gpt-4o",
      profileId: "00000000-0000-0000-0000-000000000001",
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
      source: "project-default",
      fallbackChain: ["project-default", "user-default"],
      downgradeReasons: [],
    });
    expect(receipt.source).toBe("project-default");
    expect(receipt.fallbackChain).toEqual(["project-default", "user-default"]);
    expect(receipt.downgradeReasons).toEqual([]);
  });

  it("decodes execution resolution receipt with downgrade reasons", () => {
    const receipt = decodeExecutionResolutionReceipt({
      providerInstanceId: "00000000-0000-0000-0000-000000000003",
      modelId: "gpt-4o",
      hostId: "local",
      executionPolicy: "plan",
      permissionPersistence: "current-session",
      effectivePermissions: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: false,
        subagents: false,
      },
      source: "none",
      fallbackChain: ["one-off-override", "project-default", "user-default"],
      downgradeReasons: [
        {
          step: "one-off-override",
          reason: "Provider instance is unavailable.",
        },
        {
          step: "project-default",
          reason: "Model is not in provider catalog.",
        },
      ],
    });
    expect(receipt.source).toBe("none");
    expect(receipt.downgradeReasons).toHaveLength(2);
    expect(receipt.downgradeReasons[0]?.step).toBe("one-off-override");
  });
});
