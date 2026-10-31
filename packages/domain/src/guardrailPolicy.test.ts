import { describe, expect, it } from "vitest";
import {
  AUTO_UNSUPPORTED_REASON,
  defaultPermissionModeFor,
  guardrailLevelOf,
  permissionModeOf,
  resolveGuardrail,
  threadAccessOf,
} from "./guardrailPolicy";

const claudeOrCodex = { providerReview: true, providerSandbox: true } as const;
const wrappedRuntime = { providerReview: false, providerSandbox: false } as const;

describe("guardrail levels", () => {
  it("maps every stored posture onto one level, so old journals replay onto the same level", () => {
    const table = [
      [{ executionPolicy: "approval-gated" }, "guarded", "ask-first"],
      [{ executionPolicy: "approval-gated", autoApprove: true }, "provider-review", "auto"],
      [{ executionPolicy: "auto-accept-edits" }, "guarded", "accept-edits"],
      [
        { executionPolicy: "auto-accept-edits", autoApprove: true },
        "provider-review",
        "accept-edits",
      ],
      [{ executionPolicy: "plan" }, "guarded", "plan"],
      [{ executionPolicy: "plan", autoApprove: true }, "guarded", "plan"],
      [{ executionPolicy: "full-access" }, "full-access", "full-access"],
    ] as const;
    for (const [access, level, mode] of table) {
      expect([access, guardrailLevelOf(access)]).toEqual([access, level]);
      expect([access, permissionModeOf(access)]).toEqual([access, mode]);
    }
  });

  it("stores each picker choice as a posture that reads back as the same choice", () => {
    for (const mode of ["auto", "ask-first", "accept-edits", "plan", "full-access"] as const) {
      expect(permissionModeOf(threadAccessOf(mode))).toBe(mode);
    }
  });

  it("decides sandbox, approver, egress and outside-content handling per level for a provider with its own reviewer and sandbox", () => {
    const row = (access: Parameters<typeof guardrailLevelOf>[0]) => {
      const resolved = resolveGuardrail({ access, capabilities: claudeOrCodex });
      if (resolved.status !== "supported") throw new Error("expected supported");
      return [resolved.sandbox, resolved.approver, resolved.egress, resolved.outsideContent];
    };
    expect(row({ executionPolicy: "approval-gated" })).toEqual([
      "both",
      "person",
      "provider-endpoints-only",
      "gates",
    ]);
    expect(row({ executionPolicy: "approval-gated", autoApprove: true })).toEqual([
      "both",
      "provider-review",
      "provider-endpoints-only",
      "gates",
    ]);
    expect(row({ executionPolicy: "full-access" })).toEqual([
      "none",
      "none",
      "unrestricted",
      "recorded",
    ]);
    expect(row({ executionPolicy: "plan" })).toEqual(["both", "person", "none", "gates"]);
  });

  it("reports Auto unsupported for a provider without a reviewer and runs it as Ask first", () => {
    const resolved = resolveGuardrail({
      access: { executionPolicy: "approval-gated", autoApprove: true },
      capabilities: wrappedRuntime,
    });
    expect(resolved).toMatchObject({
      status: "unsupported",
      mode: "auto",
      reason: AUTO_UNSUPPORTED_REASON,
      fallback: { level: "guarded", mode: "ask-first", approver: "person", sandbox: "octant" },
    });
  });

  it("runs Full access with no sandbox for every runtime, wrapped or not", () => {
    for (const capabilities of [claudeOrCodex, wrappedRuntime]) {
      expect(
        resolveGuardrail({ access: { executionPolicy: "full-access" }, capabilities }),
      ).toMatchObject({
        status: "supported",
        level: "full-access",
        sandbox: "none",
        approver: "none",
      });
    }
  });

  it("gives Work no network at any level", () => {
    for (const executionPolicy of ["approval-gated", "full-access"] as const) {
      expect(
        resolveGuardrail({
          access: { executionPolicy },
          capabilities: claudeOrCodex,
          mode: "work",
        }),
      ).toMatchObject({ egress: "none" });
    }
  });
});

describe("the mode a new thread starts in", () => {
  const settings = { defaultExecutionPolicy: "approval-gated", defaultAutoApprove: true } as const;

  it("follows Settings when the Project has no choice of its own", () => {
    expect(defaultPermissionModeFor({ settings })).toBe("auto");
    expect(
      defaultPermissionModeFor({ settings: { defaultExecutionPolicy: "approval-gated" } }),
    ).toBe("ask-first");
  });

  it("lets a Project override Settings", () => {
    expect(defaultPermissionModeFor({ project: { defaultPermissionMode: "plan" }, settings })).toBe(
      "plan",
    );
  });

  it("starts a Project that remembered Full access before Project modes existed in Full access", () => {
    expect(
      defaultPermissionModeFor({ project: { codeAccessPersistence: "project-default" }, settings }),
    ).toBe("full-access");
  });
});
