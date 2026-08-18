import { describe, expect, it } from "vitest";
import { buildFirstRunSteps, isWorkspaceConfigured } from "./firstRunStepModel";

const defaults = {
  colorScheme: "system",
  chatEnabled: true,
  workEnabled: true,
  modeSwitcher: "buttons",
} as const;

describe("workspace step completeness", () => {
  it("treats the shipped defaults as a step nobody has answered", () => {
    // Every one of these settings always holds a value, so "has an answer"
    // would be true before the user had even seen the step. Only a change from
    // what Octant ships with distinguishes a decision from an untouched default.
    expect(isWorkspaceConfigured(defaults)).toBe(false);
  });

  it("counts any deliberate change as an answer", () => {
    expect(isWorkspaceConfigured({ ...defaults, colorScheme: "dark" })).toBe(true);
    expect(isWorkspaceConfigured({ ...defaults, chatEnabled: false })).toBe(true);
    expect(isWorkspaceConfigured({ ...defaults, workEnabled: false })).toBe(true);
    expect(isWorkspaceConfigured({ ...defaults, modeSwitcher: "dropdown" })).toBe(true);
  });

  it("does not turn a still-loading appearance into an answer", () => {
    expect(isWorkspaceConfigured({ ...defaults, colorScheme: undefined })).toBe(false);
  });
});

describe("first-run steps", () => {
  it("orders providers before the choices that are made from what it found", () => {
    const steps = buildFirstRunSteps({
      current: "profile",
      profileConfigured: false,
      workspaceConfigured: false,
      providersReady: false,
      chatDefaultConfigured: false,
      navigatorConfigured: false,
    });

    expect(steps.map((step) => step.id)).toEqual([
      "profile",
      "workspace",
      "providers",
      "default-model",
      "navigator",
    ]);
    expect(steps.filter((step) => step.current).map((step) => step.id)).toEqual(["profile"]);
    expect(steps.every((step) => !step.configured)).toBe(true);
  });
});
