import type { ProviderModelOption } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { chatSettingsToSend, chosenReasoningLabel } from "./modelSettings";

const settings: ReadonlyArray<ProviderModelOption> = [
  { id: "effort", displayName: "Reasoning effort", kind: "selection", values: ["low", "high"] },
  { id: "service-tier", displayName: "Service tier", kind: "selection", values: ["fast"] },
];

describe("the model settings a Chat send carries", () => {
  it("sends nothing until the person chooses, so a change made on another computer stands", () => {
    expect(chatSettingsToSend({ settings, chosen: undefined, thread: { effort: "high" } })).toBe(
      undefined,
    );
  });

  it("sends the person's choice when it differs from the thread's", () => {
    expect(
      chatSettingsToSend({ settings, chosen: { effort: "high" }, thread: { effort: "low" } }),
    ).toEqual({ effort: "high" });
  });

  it("sends an empty set when the person cleared every choice, so the host clears them too", () => {
    expect(chatSettingsToSend({ settings, chosen: {}, thread: { effort: "low" } })).toEqual({});
  });

  it("sends nothing when the choice is what the thread already has", () => {
    expect(
      chatSettingsToSend({ settings, chosen: { effort: "low" }, thread: { effort: "low" } }),
    ).toBe(undefined);
  });

  it("leaves out a value the model does not offer", () => {
    expect(
      chatSettingsToSend({
        settings,
        chosen: { effort: "high", verbosity: "max" },
        thread: { verbosity: "max" },
      }),
    ).toEqual({ effort: "high" });
  });
});

describe("the effort shown beside the model's name", () => {
  it("names the chosen reasoning level, and nothing when none is chosen", () => {
    expect(chosenReasoningLabel(settings, { effort: "high", "service-tier": "fast" })).toBe("High");
    expect(chosenReasoningLabel(settings, { "service-tier": "fast" })).toBe(undefined);
  });
});
