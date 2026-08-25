import { describe, expect, it } from "vitest";
import { allGuarantees, ChildAgentAdapterError } from "./childAgentAdapter";
import {
  childAgentFamilyFixtures,
  runChildAgentConformance,
  type ChildAgentFamilyFixture,
} from "./childAgentConformance";
import { selectChildExecutionKind } from "./childAgentAdapter";

describe("childAgentConformance", () => {
  it("covers three representative provider families including local OpenAI-compatible", () => {
    const fixtures = childAgentFamilyFixtures();
    expect(fixtures.map((fixture) => fixture.family).sort()).toEqual([
      "local-openai-compatible",
      "managed-fallback",
      "native-capable",
    ]);

    const evidence = fixtures.map((fixture) => runChildAgentConformance(fixture));
    const byFamily = Object.fromEntries(evidence.map((item) => [item.family, item]));

    expect(byFamily["native-capable"]?.selection.selectedExecutionKind).toBe("provider-native");
    expect(byFamily["native-capable"]?.events.some((event) => event.kind === "activity")).toBe(
      true,
    );
    expect(
      byFamily["native-capable"]?.events.some(
        (event) => event.kind === "activity" && event.transcriptOnly,
      ),
    ).toBe(true);

    expect(byFamily["managed-fallback"]?.selection.selectedExecutionKind).toBe("octant-managed");
    expect(byFamily["managed-fallback"]?.selection.selectedFallback?.kind).toBe("octant-managed");
    expect(byFamily["managed-fallback"]?.fallbackExplicit).toBe(true);

    expect(byFamily["local-openai-compatible"]?.selection.selectedExecutionKind).toBe(
      "octant-managed",
    );
    expect(byFamily["local-openai-compatible"]?.nativeMetadataIsolated).toBe(true);
  });

  it("rejects capability overclaim and keeps managed path fail-closed", () => {
    const overclaim: ChildAgentFamilyFixture = {
      family: "managed-fallback",
      claimedNativeSupport: "unsupported",
      nativeGuaranteeMatrix: allGuarantees(true),
      preferredKind: "provider-native",
      managedAvailable: true,
    };
    expect(() =>
      selectChildExecutionKind({
        claimedNativeSupport: overclaim.claimedNativeSupport,
        nativeGuaranteeMatrix: overclaim.nativeGuaranteeMatrix,
        preferredKind: overclaim.preferredKind,
        managedAvailable: overclaim.managedAvailable,
      }),
    ).toThrow(ChildAgentAdapterError);

    const evidence = runChildAgentConformance(overclaim);
    expect(evidence.overclaimRejected).toBe(true);
    expect(evidence.selection.selectedExecutionKind).toBe("octant-managed");
  });

  it("does not let native metadata create an alternate authority or cancel path", () => {
    const managed = runChildAgentConformance(
      childAgentFamilyFixtures().find((fixture) => fixture.family === "managed-fallback")!,
    );
    expect(managed.events.every((event) => event.nativeChildId === undefined)).toBe(true);
    expect(managed.events.some((event) => event.kind === "stop")).toBe(true);
    expect(managed.events.some((event) => event.kind === "reconcile")).toBe(true);
  });
});
