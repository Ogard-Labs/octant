import { describe, expect, it } from "vitest";
import {
  DESKTOP_APPROVAL_DEFER_COPY,
  desktopApprovalImpactSummary,
  venueForHighRiskAction,
} from "./approvalPresentation";

describe("approvalPresentation", () => {
  it("routes merge and revoke to phone biometrics", () => {
    expect(venueForHighRiskAction("merge")).toBe("phone-biometric");
    expect(venueForHighRiskAction("revoke")).toBe("phone-biometric");
  });

  it("keeps approve/reject/elevate on the desktop host", () => {
    expect(venueForHighRiskAction("approve")).toBe("desktop-host-only");
    expect(venueForHighRiskAction("reject")).toBe("desktop-host-only");
    expect(venueForHighRiskAction("elevate-full-access")).toBe("desktop-host-only");
  });

  it("builds impact summaries from host facts only", () => {
    expect(
      desktopApprovalImpactSummary({
        hostLabel: "Studio",
        mode: "code",
        threadTitle: "Ship merge",
        executionPolicy: "approval-gated",
        operationSummary: "create-pull-request",
      }),
    ).toContain("Studio");
    expect(desktopApprovalImpactSummary({})).toContain("cannot mint local approval");
    expect(DESKTOP_APPROVAL_DEFER_COPY).toContain("desktop host");
  });
});
