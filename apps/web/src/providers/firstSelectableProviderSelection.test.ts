import { describe, expect, it } from "vitest";
import type { PickerGroup, PickerModel } from "@octant/domain";
import { firstSelectableProviderSelection } from "./firstSelectableProviderSelection";

function picker(modelId: string, unavailableReason?: string): PickerModel {
  return {
    model: { id: modelId },
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  } as unknown as PickerModel;
}

function group(models: ReadonlyArray<PickerModel>): PickerGroup {
  return {
    instance: { id: "provider-1" },
    sections: [{ models }],
  } as unknown as PickerGroup;
}

describe("firstSelectableProviderSelection", () => {
  it("skips unavailable models and returns the first selectable one", () => {
    expect(
      firstSelectableProviderSelection([
        group([picker("unavailable", "Provider is still scanning"), picker("selectable")]),
      ]),
    ).toEqual({ providerInstanceId: "provider-1", modelId: "selectable" });
  });

  it("returns undefined when no model is selectable", () => {
    expect(
      firstSelectableProviderSelection([
        group([picker("unavailable", "Provider is still scanning")]),
      ]),
    ).toBeUndefined();
  });
});
