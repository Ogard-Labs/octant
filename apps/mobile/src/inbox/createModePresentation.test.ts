import { describe, expect, it } from "vitest";
import { mobileCreateModePresentation } from "./createModePresentation";

describe("mobile create mode presentation", () => {
  it("keeps all three canonical modes create-capable with visible placement context", () => {
    expect(
      mobileCreateModePresentation("chat", {
        placementLabel: "Studio Mac",
        workProjectName: "Launch",
      }),
    ).toMatchObject({
      description: "Conversation on Studio Mac.",
      placeholder: "Ask your host…",
      showsComposer: true,
    });
    expect(
      mobileCreateModePresentation("work", {
        placementLabel: "Studio Mac",
        workProjectName: "Launch",
      }),
    ).toMatchObject({
      description: "Work in Launch on Studio Mac.",
      placeholder: "Plan work in this project…",
      showsComposer: true,
    });
    expect(
      mobileCreateModePresentation("code", {
        placementLabel: "Studio Mac",
        workProjectName: "Launch",
        codeProjectName: "Octant",
      }),
    ).toMatchObject({
      description: "Build in Octant on Studio Mac · approval gated.",
      placeholder: "Describe a Code task…",
      showsComposer: true,
    });
  });
});
