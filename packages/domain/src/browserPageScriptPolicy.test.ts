import { describe, expect, it } from "vitest";
import { evaluateBrowserPageScriptPolicy } from "./browserPageScriptPolicy";

describe("page script authority", () => {
  it("requires Full access even when Private-page session eligibility is unknown", () => {
    expect(
      evaluateBrowserPageScriptPolicy({ executionPolicy: "full-access", caller: "person" }),
    ).toEqual({ status: "allowed" });
    for (const executionPolicy of ["approval-gated", "auto-accept-edits"] as const)
      expect(evaluateBrowserPageScriptPolicy({ executionPolicy, caller: "person" })).toEqual({
        status: "refused",
        reason: "full-access-required",
      });
    expect(evaluateBrowserPageScriptPolicy({ executionPolicy: "plan", caller: "person" })).toEqual({
      status: "refused",
      reason: "plan-is-read-only",
    });
  });

  it("allows a local person to authorize one scoped script below Full access while Plan still refuses", () => {
    for (const executionPolicy of ["approval-gated", "auto-accept-edits"] as const)
      expect(
        evaluateBrowserPageScriptPolicy({
          executionPolicy,
          caller: "person",
          scopedPermission: true,
        }),
      ).toEqual({ status: "allowed" });
    expect(
      evaluateBrowserPageScriptPolicy({
        executionPolicy: "plan",
        caller: "person",
        scopedPermission: true,
      }),
    ).toEqual({ status: "refused", reason: "plan-is-read-only" });
    expect(
      evaluateBrowserPageScriptPolicy({
        executionPolicy: "approval-gated",
        caller: "remote-device",
        scopedPermission: true,
      }),
    ).toEqual({ status: "refused", reason: "local-person-required" });
  });

  it("does not give routine, paired or terminal callers script authority through Full access", () => {
    for (const caller of ["unattended", "remote-device", "terminal-grant"] as const)
      expect(evaluateBrowserPageScriptPolicy({ executionPolicy: "full-access", caller })).toEqual({
        status: "refused",
        reason: "local-person-required",
      });
  });
});
