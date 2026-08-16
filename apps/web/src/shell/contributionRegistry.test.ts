import { describe, expect, it } from "vitest";
import {
  resolveSettingsSectionContributions,
  resolveSidebarContributions,
  type FirstPartyPluginComponentId,
} from "./contributionRegistry";

function effectiveMap(
  entries: Partial<Record<FirstPartyPluginComponentId, boolean>>,
): ReadonlyMap<FirstPartyPluginComponentId, boolean> {
  return new Map(Object.entries(entries) as Array<[FirstPartyPluginComponentId, boolean]>);
}

describe("resolveSidebarContributions", () => {
  it("includes thread-board for work and code when the board plugin is effective", () => {
    const effective = effectiveMap({ board: true });
    expect(resolveSidebarContributions("work", effective).has("thread-board")).toBe(true);
    expect(resolveSidebarContributions("code", effective).has("thread-board")).toBe(true);
    expect(resolveSidebarContributions("chat", effective).has("thread-board")).toBe(false);
  });

  it("omits thread-board when the board plugin is not effective", () => {
    const effective = effectiveMap({ board: false });
    expect(resolveSidebarContributions("code", effective).has("thread-board")).toBe(false);
  });

  it("includes pull-requests only in code mode when github is effective", () => {
    const effective = effectiveMap({ "github-integration": true });
    expect(resolveSidebarContributions("code", effective).has("pull-requests")).toBe(true);
    expect(resolveSidebarContributions("work", effective).has("pull-requests")).toBe(false);
  });

  it("treats an unlisted component as not effective", () => {
    expect(resolveSidebarContributions("code", effectiveMap({})).size).toBe(0);
  });
});

describe("resolveSettingsSectionContributions", () => {
  it("includes github when effective", () => {
    expect(
      resolveSettingsSectionContributions(effectiveMap({ "github-integration": true })).has(
        "github",
      ),
    ).toBe(true);
  });

  it("omits github when not effective", () => {
    expect(
      resolveSettingsSectionContributions(effectiveMap({ "github-integration": false })).has(
        "github",
      ),
    ).toBe(false);
  });
});
