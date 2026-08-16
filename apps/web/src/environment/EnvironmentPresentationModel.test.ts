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
    byMode: { chat: "hidden", work: "floating", code: "pinned" },
  });
}

describe("EnvironmentPresentationModel", () => {
  it("resolves the mode default when no tab override exists", () => {
    expect(resolveTabPresentation(state(), "code", tabA).presentation).toBe("pinned");
    expect(resolveTabPresentation(state(), "chat", tabA).presentation).toBe("hidden");
  });

  it("resolves a tab override over the mode default", () => {
    const withOverride = replaceTabPresentation(state(), tabA, "floating");
    expect(resolveTabPresentation(withOverride, "code", tabA).presentation).toBe("floating");
    expect(resolveTabPresentation(withOverride, "code", tabB).presentation).toBe("pinned");
  });

  it("replaces an existing override instead of duplicating", () => {
    const first = replaceTabPresentation(state(), tabA, "floating");
    const updated = replaceTabPresentation(first, tabA, "hidden");
    expect(updated.byTab).toHaveLength(1);
    expect(resolveTabPresentation(updated, "code", tabA).presentation).toBe("hidden");
  });

  it("preserves pinned width when replacing without an explicit width", () => {
    const withWidth = replaceTabPresentation(state(), tabA, "pinned", 400);
    const updated = replaceTabPresentation(withWidth, tabA, "pinned");
    expect(resolveTabPresentation(updated, "code", tabA).pinnedWidth).toBe(400);
  });

  it("clears a tab override so the mode default applies again", () => {
    const withOverride = replaceTabPresentation(state(), tabA, "floating");
    const cleared = clearTabPresentation(withOverride, tabA);
    expect(cleared.byTab).toHaveLength(0);
    expect(resolveTabPresentation(cleared, "code", tabA).presentation).toBe("pinned");
  });

  it("does not mutate the default presentation state", () => {
    const baseline = defaultEnvironmentPresentationState();
    replaceTabPresentation(baseline, tabA, "floating");
    expect(baseline.byTab).toHaveLength(0);
  });
});
