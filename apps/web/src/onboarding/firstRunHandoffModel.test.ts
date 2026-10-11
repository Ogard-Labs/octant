import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderModel,
  ProviderModelId,
} from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import type { PickerGroup } from "@octant/domain";
import { describe, expect, it } from "vitest";
import {
  firstSelectableModel,
  resolveFirstRunHandoff,
  type FirstRunHandoffInput,
  type FirstRunHandoffProject,
} from "./firstRunHandoffModel";

const instanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const modelId = "llama-test" as ProviderModelId;
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProjectId;

function group(
  overrides: {
    readonly unavailable?: boolean;
    readonly models?: ReadonlyArray<{ readonly id: string; readonly unavailable?: boolean }>;
  } = {},
): PickerGroup {
  const models = (overrides.models ?? [{ id: String(modelId) }]).map((entry) => ({
    model: {
      id: entry.id as ProviderModelId,
      displayName: entry.id === String(modelId) ? "Llama Test" : entry.id,
    } as ProviderModel,
    badges: [],
    toolCapable: true,
    ...(entry.unavailable === true ? { unavailableReason: "Chat-only" } : {}),
  }));
  return {
    instance: {
      id: instanceId,
      displayName: "Ollama",
    } as ProviderInstance,
    runtime: "octant-harness",
    readiness: "ready",
    driverLabel: "Ollama",
    endpointHost: undefined,
    executionHost: "Local host",
    sections: [{ id: "all-models", label: "All models", models }],
  };
}

function project(overrides: Partial<FirstRunHandoffProject> = {}): FirstRunHandoffProject {
  return {
    id: projectId,
    name: "Ada's notes",
    type: "code",
    lifecycle: "active",
    ...overrides,
  };
}

function resolve(overrides: Partial<FirstRunHandoffInput> = {}) {
  return resolveFirstRunHandoff({
    mode: "code",
    providerOverall: "none-configured",
    providerHeadline: "No provider is configured",
    projects: [],
    groups: [],
    ...overrides,
  });
}

describe("first-run handoff readiness", () => {
  it("reports provider, Project, and model as separate missing facts on a clean host", () => {
    const handoff = resolve();

    expect(handoff.facts.map((fact) => [fact.id, fact.ready])).toEqual([
      ["provider", false],
      ["project", false],
      ["model", false],
    ]);
    expect(handoff.facts[0]?.detail).toBe("No provider is configured");
    expect(handoff.facts[1]?.detail).toContain("No Code folder yet");
    expect(handoff.facts[2]?.detail).toContain("No model this host can use in Code");
    expect(handoff.ready).toBe(false);
    expect(handoff.primary).toEqual({
      kind: "setup",
      target: "providers",
      label: "Set up a provider",
    });
  });

  it("opens Project setup once a provider can answer, rather than claiming the host is ready", () => {
    const handoff = resolve({
      providerOverall: "ready",
      providerHeadline: "1 provider is ready",
      groups: [group()],
    });

    expect(handoff.facts[0]?.ready).toBe(true);
    expect(handoff.facts[0]?.detail).toBe("1 provider is ready");
    expect(handoff.facts[1]?.ready).toBe(false);
    expect(handoff.facts[2]?.ready).toBe(true);
    expect(handoff.ready).toBe(false);
    expect(handoff.primary).toEqual({
      kind: "setup",
      target: "project",
      label: "Choose a folder…",
    });
  });

  it("starts a real thread only when provider, Project, and a mode-valid model are all present", () => {
    const handoff = resolve({
      providerOverall: "ready",
      providerHeadline: "1 provider is ready",
      groups: [group()],
      projects: [project()],
      preferredDefault: { providerInstanceId: instanceId, modelId },
    });

    expect(handoff.ready).toBe(true);
    expect(handoff.facts.map((fact) => [fact.id, fact.detail])).toEqual([
      ["provider", "1 provider is ready"],
      ["project", "Ada's notes"],
      ["model", "Llama Test on Ollama"],
    ]);
    expect(handoff.primary).toEqual({
      kind: "start-thread",
      label: "Start a task",
      projectId,
    });
  });

  it("does not treat an archived or other-mode Project as the selected mode's container", () => {
    expect(
      resolve({
        providerOverall: "ready",
        groups: [group()],
        projects: [project({ lifecycle: "archived" })],
      }).facts[1]?.ready,
    ).toBe(false);
    expect(
      resolve({
        mode: "work",
        providerOverall: "ready",
        groups: [group()],
        projects: [project(), project({ type: "chat", name: "Chat notes" })],
      }).primary,
    ).toEqual({
      kind: "setup",
      target: "project",
      label: "Choose a folder…",
    });
  });

  it("starts in the Project the user picked rather than the first one listed", () => {
    const pickedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as ProjectId;
    const projects = [project(), project({ id: pickedId, name: "octant" })];
    const ready = {
      providerOverall: "ready",
      groups: [group()],
      projects,
    } as const;

    expect(resolve(ready).project?.name).toBe("Ada's notes");
    expect(resolve({ ...ready, preferredProjectId: pickedId }).primary).toEqual({
      kind: "start-thread",
      label: "Start a task",
      projectId: pickedId,
    });
  });

  it("ignores a remembered model the selected mode cannot use, and does not offer unusable models", () => {
    const chatOnly = group({ models: [{ id: String(modelId), unavailable: true }] });
    const handoff = resolve({
      mode: "code",
      providerOverall: "ready",
      providerHeadline: "1 provider is ready",
      groups: [chatOnly],
      projects: [project({ type: "code", name: "octant" })],
      preferredDefault: { providerInstanceId: instanceId, modelId },
    });

    expect(firstSelectableModel([chatOnly])).toBeUndefined();
    expect(handoff.facts[0]?.ready).toBe(true);
    expect(handoff.facts[2]?.ready).toBe(false);
    expect(handoff.ready).toBe(false);
    expect(handoff.primary).toEqual({
      kind: "setup",
      target: "providers",
      label: "Set up a provider",
    });
  });

  it("names an unknown or still-checking provider instead of converting it into 'none configured'", () => {
    expect(
      resolve({ providerOverall: "checking", providerHeadline: "Checking provider readiness" })
        .facts[0]?.detail,
    ).toContain("still checking");
    expect(
      resolve({
        providerOverall: "authority-unavailable",
        providerHeadline: "Provider readiness is unavailable",
      }).facts[0]?.detail,
    ).toContain("cannot reach its own provider registry");
  });
});
