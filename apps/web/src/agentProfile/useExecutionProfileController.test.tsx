import type { AgentProfile, ExecutionResolutionReceipt } from "@octant/contracts/agent-profile";
import type { PickerGroup } from "@octant/domain";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useExecutionProfileController } from "./useExecutionProfileController";

const providerId = "00000000-0000-4000-8000-000000000001" as never;
const profileId = "00000000-0000-4000-8000-000000000002" as never;
const hostId = "local" as never;

const profile: AgentProfile = {
  id: profileId,
  displayName: "Code reviewer",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "plan",
  defaultPermissionPersistence: "current-session",
  compatibleModes: ["code"],
  version: 1 as never,
  createdAt: "2026-07-28T12:00:00.000Z" as never,
  updatedAt: "2026-07-28T12:00:00.000Z" as never,
};

const receipt = (modelId: string): ExecutionResolutionReceipt => ({
  providerInstanceId: providerId,
  modelId: modelId as never,
  profileId,
  hostId,
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
  source: "one-off-override",
  fallbackChain: ["one-off-override", "project-default", "mode-default", "user-default"],
  downgradeReasons: [],
});

function groups(
  modelId = "gpt-5",
  readiness: "ready" | "unavailable" = "ready",
): ReadonlyArray<PickerGroup> {
  return [
    {
      instance: { id: providerId, displayName: "OpenAI" },
      readiness,
      driverLabel: "OpenAI",
      endpointHost: undefined,
      executionHost: "This Mac",
      sections: [
        {
          id: "all-models",
          label: "Models",
          models: [
            {
              model: { id: modelId, displayName: modelId.toUpperCase() },
              badges: [],
              toolCapable: true,
            },
          ],
        },
      ],
    } as never,
  ];
}

describe("useExecutionProfileController", () => {
  beforeEach(() => window.localStorage.clear());

  it("restores the selected profile and re-resolves when model facts change", async () => {
    window.localStorage.setItem("octant.test.execution-profile", String(profileId));
    const resolveEffectiveProfile = vi.fn(
      async (input: { modelId?: string; oneOffOverride?: { modelId: string } }) =>
        receipt(String(input.oneOffOverride?.modelId ?? input.modelId)),
    );
    const client = {
      list: vi.fn(async () => [profile]),
      read: vi.fn(),
      execute: vi.fn(),
      resolveEffectiveProfile,
    } as never;
    const onSelectProvider = vi.fn();
    const { result, rerender } = renderHook(
      ({ modelId }) =>
        useExecutionProfileController({
          client,
          hostId,
          hostLabel: "This Mac",
          mode: "code",
          onSelectProvider,
          profileSelectionStorageKey: "octant.test.execution-profile",
          projectExecutionPolicy: "approval-gated",
          providerGroups: groups(modelId),
          selectedModelId: modelId as never,
          selectedProviderInstanceId: providerId,
          scope: { scopeKind: "mode", scopeRef: "code" },
        }),
      { initialProps: { modelId: "gpt-5" } },
    );

    await waitFor(() => expect(result.current.status).toBe("resolved"));
    expect(result.current.selectedProfile?.displayName).toBe("Code reviewer");
    expect(resolveEffectiveProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        oneOffOverride: expect.objectContaining({
          modelId: "gpt-5",
          profileId,
        }),
      }),
    );

    rerender({ modelId: "gpt-5.1" });
    await waitFor(() =>
      expect(resolveEffectiveProfile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          oneOffOverride: expect.objectContaining({
            modelId: "gpt-5.1",
            profileId,
          }),
        }),
      ),
    );
    await waitFor(() => expect(result.current.receipt?.modelId).toBe("gpt-5.1"));
  });

  it("re-resolves when provider readiness changes under the same provider and model ids", async () => {
    window.localStorage.setItem("octant.test.execution-profile", String(profileId));
    const resolveEffectiveProfile = vi.fn(async () => receipt("gpt-5"));
    const client = {
      list: vi.fn(async () => [profile]),
      read: vi.fn(),
      execute: vi.fn(),
      resolveEffectiveProfile,
    } as never;
    const { rerender } = renderHook(
      ({ readiness }) =>
        useExecutionProfileController({
          client,
          hostId,
          hostLabel: "This Mac",
          mode: "code",
          onSelectProvider: vi.fn(),
          profileSelectionStorageKey: "octant.test.execution-profile",
          projectExecutionPolicy: "approval-gated",
          providerGroups: groups("gpt-5", readiness),
          selectedModelId: "gpt-5" as never,
          selectedProviderInstanceId: providerId,
          scope: { scopeKind: "mode", scopeRef: "code" },
        }),
      { initialProps: { readiness: "ready" as "ready" | "unavailable" } },
    );

    await waitFor(() => expect(resolveEffectiveProfile).toHaveBeenCalledTimes(1));
    rerender({ readiness: "unavailable" });
    await waitFor(() => expect(resolveEffectiveProfile).toHaveBeenCalledTimes(2));
  });

  it("fails closed for an unhealthy host and resolves when that host recovers", async () => {
    window.localStorage.setItem("octant.test.execution-profile", String(profileId));
    const resolveEffectiveProfile = vi.fn(async () => receipt("gpt-5"));
    const client = {
      list: vi.fn(async () => [profile]),
      read: vi.fn(),
      execute: vi.fn(),
      resolveEffectiveProfile,
    } as never;
    const { result, rerender } = renderHook(
      ({ hostHealth }) =>
        useExecutionProfileController({
          client,
          hostId,
          hostHealth,
          hostLabel: "This Mac",
          mode: "code",
          onSelectProvider: vi.fn(),
          profileSelectionStorageKey: "octant.test.execution-profile",
          projectExecutionPolicy: "approval-gated",
          providerGroups: groups(),
          selectedModelId: "gpt-5" as never,
          selectedProviderInstanceId: providerId,
          scope: { scopeKind: "mode", scopeRef: "code" },
        }),
      {
        initialProps: {
          hostHealth: "unavailable" as "healthy" | "unavailable",
        },
      },
    );

    await waitFor(() => expect(result.current.status).toBe("unsupported"));
    expect(result.current.message).toContain("This Mac is unavailable");
    expect(resolveEffectiveProfile).not.toHaveBeenCalled();

    rerender({ hostHealth: "healthy" });
    await waitFor(() => expect(result.current.status).toBe("resolved"));
    expect(resolveEffectiveProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed resolution actionable without changing provider selection", async () => {
    window.localStorage.setItem("octant.test.execution-profile", String(profileId));
    const client = {
      list: vi.fn(async () => [profile]),
      read: vi.fn(),
      execute: vi.fn(),
      resolveEffectiveProfile: vi.fn(async () => ({
        ...receipt("gpt-5"),
        profileId: undefined,
        source: "none",
        downgradeReasons: [
          {
            step: "one-off-override",
            reason: "Model is not allowed by the profile's model constraints.",
          },
        ],
      })),
    } as never;
    const onSelectProvider = vi.fn();
    const { result } = renderHook(() =>
      useExecutionProfileController({
        client,
        hostId,
        hostLabel: "This Mac",
        mode: "code",
        onSelectProvider,
        profileSelectionStorageKey: "octant.test.execution-profile",
        projectExecutionPolicy: "approval-gated",
        providerGroups: groups(),
        selectedModelId: "gpt-5" as never,
        selectedProviderInstanceId: providerId,
        scope: { scopeKind: "mode", scopeRef: "code" },
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("unsupported"));
    expect(result.current.message).toContain("Model is not allowed");
    expect(result.current.message).toContain("Choose another provider, model, or profile");
    expect(onSelectProvider).not.toHaveBeenCalled();
  });

  it("creates, edits, selects, and deletes profiles through authenticated commands", async () => {
    const updated = {
      ...profile,
      displayName: "Focused reviewer",
      version: 2 as never,
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ kind: "profile-created", profile })
      .mockResolvedValueOnce({ kind: "profile-updated", profile: updated })
      .mockResolvedValueOnce({ kind: "profile-removed", profileId });
    const client = {
      list: vi.fn(async () => []),
      read: vi.fn(),
      execute,
      resolveEffectiveProfile: vi.fn(async () => receipt("gpt-5")),
    } as never;
    const { result } = renderHook(() =>
      useExecutionProfileController({
        client,
        hostId,
        hostLabel: "This Mac",
        mode: "code",
        onSelectProvider: vi.fn(),
        profileSelectionStorageKey: "octant.test.execution-profile",
        projectExecutionPolicy: "approval-gated",
        providerGroups: groups(),
        selectedModelId: "gpt-5" as never,
        selectedProviderInstanceId: providerId,
        scope: { scopeKind: "mode", scopeRef: "code" },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.createProfile({
        displayName: "Code reviewer",
        approvedSkillIds: [],
        toolConstraints: [],
        modelConstraints: [],
        defaultExecutionPolicy: "plan",
        defaultPermissionPersistence: "current-session",
        compatibleModes: ["code"],
        scope: { scopeKind: "mode", scopeRef: "code" },
      });
    });
    expect(result.current.profiles).toEqual([profile]);

    act(() => result.current.selectProfile(profileId));
    expect(window.localStorage.getItem("octant.test.execution-profile")).toBe(String(profileId));

    await act(async () => {
      await result.current.updateProfile({
        ...profile,
        displayName: "Focused reviewer",
      });
    });
    expect(result.current.profiles[0]?.displayName).toBe("Focused reviewer");

    await act(async () => {
      await result.current.deleteProfile(updated);
    });
    expect(result.current.profiles).toEqual([]);
    expect(window.localStorage.getItem("octant.test.execution-profile")).toBeNull();
  });
});
