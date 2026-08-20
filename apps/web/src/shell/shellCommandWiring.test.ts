import { describe, expect, it } from "vitest";
import { EXECUTION_POLICY_LABEL, visuallyHiddenStyle } from "./shellCommandWiring";

describe("shell command wiring", () => {
  it("names an agent profile's default policy in words, never by colour", () => {
    expect(EXECUTION_POLICY_LABEL["full-access"]).toBe("Full access");
    expect(EXECUTION_POLICY_LABEL["approval-gated"]).toBe("Approval gated");
    expect(EXECUTION_POLICY_LABEL["auto-accept-edits"]).toBe("Auto-accept edits");
    expect(EXECUTION_POLICY_LABEL.plan).toBe("Plan");
  });

  it("hides live announcements from layout while keeping them readable", () => {
    expect(visuallyHiddenStyle.position).toBe("absolute");
    expect(visuallyHiddenStyle.clipPath).toBe("inset(50%)");
  });
});
