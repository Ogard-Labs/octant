import { describe, expect, it } from "vitest";
import { contextFixture } from "./contextFixtures";
import {
  contextCompositionEntries,
  contextEntryControls,
  contextStatusModel,
  serviceLimitLabel,
  tokenMeasurementLabel,
} from "./contextInspectorModel";

describe("context inspector presentation model", () => {
  it.each(["healthy", "watch", "optimizing", "action-needed", "blocked", "rate-limited"] as const)(
    "represents %s with a non-color label",
    (health) => {
      expect(contextStatusModel(contextFixture({ health }), { kind: "thread" })).toMatchObject({
        health,
        healthLabel: expect.any(String),
        scopeLabel: "Fixture thread · model-a",
      });
    },
  );

  it("does not present unknown tokens as exact", () => {
    const fixture = contextFixture({ unknownTokens: true });
    expect(contextStatusModel(fixture, { kind: "thread" }).usageLabel).toContain("unknown");
    expect(tokenMeasurementLabel(fixture.next.manifest.entries[1]!.tokens)).toBe("Unknown");
  });

  it("keeps pane focus explicit while preserving thread attention", () => {
    expect(
      contextStatusModel(contextFixture({ health: "blocked" }), {
        kind: "pane",
        label: "Terminal",
      }),
    ).toMatchObject({ scopeLabel: "Terminal", attentionLabel: "Fixture thread: Blocked" });
  });

  it("calls unavailable limits unavailable instead of unlimited", () => {
    expect(serviceLimitLabel({ status: "unavailable" })).toBe("Unavailable");
  });

  it("prevents protected exclusions and ineligible pins in the view model", () => {
    const fixture = contextFixture();
    expect(contextEntryControls(fixture.next.manifest.entries[0]!, fixture)).toMatchObject({
      canExclude: false,
      canPin: true,
    });
    const ineligible = {
      ...fixture.next.manifest.entries[1]!,
      eligibility: {
        providerInstanceId: fixture.modelLimits.providerInstanceId,
        status: "ineligible" as const,
        reason: "authority-denied" as const,
      },
      state: "omitted" as const,
      includedSize: 0,
    };
    expect(contextEntryControls(ineligible, fixture)).toMatchObject({ canPin: false });
  });

  it("joins manifest metadata to authoritative planned state, reason, and tokens", () => {
    const fixture = contextFixture({ plannedReduction: true });
    const optional = contextCompositionEntries(fixture)[1]!;
    expect(optional).toMatchObject({
      label: "Repository search",
      plannedState: "truncated",
      planReason: "truncated",
      plannedTokens: {
        kind: "known",
        tokens: 21,
        accuracy: "conservative-heuristic",
      },
    });
    expect(optional.manifestState).toBe("included");
  });
});
