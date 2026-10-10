import { describe, expect, it } from "vitest";
import { buildFirstRunSteps, nextFirstRunStep, previousFirstRunStep } from "./firstRunStepModel";

describe("first-run steps", () => {
  it("asks for a provider, then a Project, then a model, and nothing else", () => {
    const steps = buildFirstRunSteps({
      current: "providers",
      providersReady: false,
      projectReady: false,
      modelChosen: false,
    });

    expect(steps.map((step) => step.id)).toEqual(["providers", "project", "model"]);
    expect(steps.filter((step) => step.current).map((step) => step.id)).toEqual(["providers"]);
    expect(steps.every((step) => !step.configured)).toBe(true);
    expect(nextFirstRunStep("model")).toBeUndefined();
    expect(previousFirstRunStep("providers")).toBeUndefined();
  });

  it("marks each step configured only from the fact it asks for", () => {
    const steps = buildFirstRunSteps({
      current: "model",
      providersReady: true,
      projectReady: false,
      modelChosen: true,
    });

    expect(steps.map((step) => [step.id, step.configured])).toEqual([
      ["providers", true],
      ["project", false],
      ["model", true],
    ]);
  });
});
