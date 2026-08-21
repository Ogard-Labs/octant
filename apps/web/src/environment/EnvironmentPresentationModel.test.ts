import {
  decodeEnvironmentPresentationState,
  decodeWorkspaceTabId,
  type EnvironmentPresentationState,
} from "@octant/contracts";
import { defaultEnvironmentPresentationState } from "@octant/domain/shell-policy";
import { describe, expect, it } from "vitest";
import {
  clearTabPresentation,
  replaceTabPresentation,
  resolveTabPresentation,
} from "./EnvironmentPresentationModel";

const tabA = decodeWorkspaceTabId("30000000-0000-4000-8000-00000000000a");
const tabB = decodeWorkspaceTabId("30000000-0000-4000-8000-00000000000b");

function state(): EnvironmentPresentationState {
  return decodeEnvironmentPresentationState({
    byTab: [],
    byMode: { chat: "hidden", work: "floating", code: "floating" },
  });
}

describe("resolving a thread tab's environment presentation", () => {
  it("resolves the mode default when no tab override exists", () => {
    expect(resolveTabPresentation(state(), "code", tabA)).toBe("floating");
    expect(resolveTabPresentation(state(), "chat", tabA)).toBe("hidden");
  });

  it("resolves a tab override over the mode default", () => {
    const withOverride = replaceTabPresentation(state(), tabA, "hidden");
    expect(resolveTabPresentation(withOverride, "code", tabA)).toBe("hidden");
    expect(resolveTabPresentation(withOverride, "code", tabB)).toBe("floating");
  });

  it("replaces an existing override instead of duplicating", () => {
    const first = replaceTabPresentation(state(), tabA, "floating");
    const updated = replaceTabPresentation(first, tabA, "hidden");
    expect(updated.byTab).toHaveLength(1);
    expect(resolveTabPresentation(updated, "code", tabA)).toBe("hidden");
  });

  it("clears a tab override so the mode default applies again", () => {
    const withOverride = replaceTabPresentation(state(), tabA, "hidden");
    const cleared = clearTabPresentation(withOverride, tabA);
    expect(cleared.byTab).toHaveLength(0);
    expect(resolveTabPresentation(cleared, "code", tabA)).toBe("floating");
  });

  it("does not mutate the default presentation state", () => {
    const baseline = defaultEnvironmentPresentationState();
    replaceTabPresentation(baseline, tabA, "hidden");
    expect(baseline.byTab).toHaveLength(0);
  });
});
