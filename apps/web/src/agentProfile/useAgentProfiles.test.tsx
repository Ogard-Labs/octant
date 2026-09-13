import type { AgentProfileClient } from "@octant/client-runtime";
import { decodeAgentProfile } from "@octant/contracts/agent-profile";
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAgentProfiles } from "./useAgentProfiles";

it("loads saved records without resolving a remembered draft profile or changing it", async () => {
  const profile = decodeAgentProfile({
    id: "00000000-0000-4000-8000-000000000002",
    displayName: "Code reviewer",
    approvedSkillIds: [],
    toolConstraints: [],
    modelConstraints: [],
    defaultExecutionPolicy: "plan",
    defaultPermissionPersistence: "current-session",
    compatibleModes: ["code"],
    version: 1,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  });
  const storageKey = "octant.execution-profile.code.unfiled";
  window.localStorage.setItem(storageKey, String(profile.id));
  const client: AgentProfileClient = {
    list: vi.fn(async () => [profile]),
    read: vi.fn(),
    execute: vi.fn(),
    resolveEffectiveProfile: vi.fn(),
  };
  const { result } = renderHook(() => useAgentProfiles(client));
  await waitFor(() => expect(result.current).toEqual([profile]));
  expect(client.resolveEffectiveProfile).not.toHaveBeenCalled();
  expect(client.execute).not.toHaveBeenCalled();
  window.localStorage.removeItem(storageKey);
});

it("offers no saved records when the host cannot load them", async () => {
  const client: AgentProfileClient = {
    list: vi.fn().mockRejectedValue(new Error("Host unavailable")),
    read: vi.fn(),
    execute: vi.fn(),
    resolveEffectiveProfile: vi.fn(),
  };
  const { result } = renderHook(() => useAgentProfiles(client));
  await waitFor(() => expect(client.list).toHaveBeenCalledOnce());
  expect(result.current).toEqual([]);
});
