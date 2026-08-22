import { describe, expect, it } from "vitest";
import {
  hasActionableDelivery,
  isAuthorizedCanvasDocument,
  isCurrentPlanArtifact,
  isDockToolLaunchable,
  isDockToolStillOpenable,
} from "./dockToolAvailability";

describe("which live tools the dock may offer", () => {
  it("treats only a current plan artifact as Plan, never a withdrawn or empty plan", () => {
    expect(isCurrentPlanArtifact(undefined)).toBe(false);
    expect(isCurrentPlanArtifact(null)).toBe(false);
    expect(isCurrentPlanArtifact({ status: "withdrawn" } as never)).toBe(false);
    expect(isCurrentPlanArtifact({ status: "proposed" } as never)).toBe(true);
    expect(isCurrentPlanArtifact({ status: "approved" } as never)).toBe(true);
  });

  it("offers Delivery only for an enabled target or an actionable publication plan", () => {
    expect(hasActionableDelivery({ targets: [] })).toBe(false);
    expect(hasActionableDelivery({ targets: [{ enabled: false }] })).toBe(false);
    expect(hasActionableDelivery({ targets: [{ enabled: true }] })).toBe(true);
    expect(
      hasActionableDelivery({
        targets: [{ enabled: false }],
        plan: { targetId: "target" } as never,
      }),
    ).toBe(true);
  });

  it("opens only an authorized Canvas document", () => {
    expect(isAuthorizedCanvasDocument({ status: "ready" })).toBe(true);
    expect(isAuthorizedCanvasDocument({ status: "limited" })).toBe(true);
    expect(isAuthorizedCanvasDocument({ status: "unauthorized" })).toBe(false);
    expect(isAuthorizedCanvasDocument({ status: "invalid" })).toBe(false);
    expect(isAuthorizedCanvasDocument({ status: "failed" })).toBe(false);
  });

  it("keeps Plan, Delivery, and Canvas off the launcher until the host confirms they exist", () => {
    const unknown = {
      hasPlanArtifact: "unknown" as const,
      hasDelivery: "unknown" as const,
      hasCanvasDocument: "unknown" as const,
      hasAppleSimulator: false,
    };
    expect(isDockToolLaunchable("plan", unknown)).toBe(false);
    expect(isDockToolLaunchable("delivery", unknown)).toBe(false);
    expect(isDockToolLaunchable("canvas", unknown)).toBe(false);
    expect(isDockToolStillOpenable("plan", unknown)).toBe(true);
    expect(
      isDockToolLaunchable("plan", {
        ...unknown,
        hasPlanArtifact: true,
      }),
    ).toBe(true);
    expect(
      isDockToolStillOpenable("plan", {
        ...unknown,
        hasPlanArtifact: false,
      }),
    ).toBe(false);
  });

  it("hides iOS Simulator rather than offering an empty workbench", () => {
    const capabilities = {
      hasPlanArtifact: false,
      hasDelivery: false,
      hasCanvasDocument: false,
      hasAppleSimulator: false,
    } as const;
    expect(isDockToolLaunchable("ios-simulator", capabilities)).toBe(false);
    expect(
      isDockToolLaunchable("ios-simulator", { ...capabilities, hasAppleSimulator: true }),
    ).toBe(true);
  });
});
