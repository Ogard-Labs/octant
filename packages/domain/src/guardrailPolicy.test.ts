import { describe, expect, it } from "vitest";
import {
  AUTO_UNSUPPORTED_REASON,
  defaultPermissionModeFor,
  defaultWorkPermissionModeFor,
  guardrailLowered,
  guardrailScopeOf,
  guardrailLevelOf,
  permissionModeOf,
  clampWorkAccess,
  chosenAutoReviewer,
  resolveAutoReviewer,
  resolveGuardrail,
  shieldReviewsPrompts,
  shieldRoutesApprovals,
  threadAccessOf,
  workAccessOfPermissionMode,
  workThreadAccessOf,
  workTurnCapabilityFacts,
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

  it("guards Work exactly as Code at every level, network included", () => {
    for (const access of [
      { executionPolicy: "approval-gated" },
      { executionPolicy: "approval-gated", autoApprove: true },
      { executionPolicy: "auto-accept-edits" },
      { executionPolicy: "full-access" },
    ] as const) {
      expect(resolveGuardrail({ access, capabilities: claudeOrCodex, mode: "work" })).toEqual(
        resolveGuardrail({ access, capabilities: claudeOrCodex, mode: "code" }),
      );
    }
  });

  it("gives Chat no network at any level", () => {
    for (const executionPolicy of ["approval-gated", "full-access"] as const) {
      expect(
        resolveGuardrail({
          access: { executionPolicy },
          capabilities: claudeOrCodex,
          mode: "chat",
        }),
      ).toMatchObject({ egress: "none" });
    }
  });
});

describe("Work levels", () => {
  it("stores each Work level as the Code mode of the same name", () => {
    expect(workThreadAccessOf("ask-first")).toEqual(threadAccessOf("ask-first"));
    expect(workThreadAccessOf("auto")).toEqual(threadAccessOf("auto"));
    expect(workThreadAccessOf("auto-accept-edits")).toEqual(threadAccessOf("accept-edits"));
    expect(workThreadAccessOf("full-access")).toEqual(threadAccessOf("full-access"));
    expect(workAccessOfPermissionMode("plan")).toBeUndefined();
    expect(workAccessOfPermissionMode("accept-edits")).toBe("auto-accept-edits");
  });

  it("records shell and Git at the level a Work turn ran with", () => {
    expect(workTurnCapabilityFacts("ask-first")).toMatchObject({
      shell: "guarded",
      git: "guarded",
      confinement: "project-root-confined",
    });
    expect(workTurnCapabilityFacts("auto")).toMatchObject({
      shell: "provider-review",
      git: "provider-review",
    });
    expect(workTurnCapabilityFacts("full-access")).toMatchObject({
      shell: "full-access",
      git: "full-access",
      confinement: "unconfined",
      worktree: "denied",
      pullRequest: "denied",
    });
  });

  it("never lets a caller's ceiling widen a Work turn", () => {
    expect(clampWorkAccess("full-access", "ask-first")).toBe("ask-first");
    expect(clampWorkAccess("full-access", "auto-accept-edits")).toBe("auto-accept-edits");
    expect(clampWorkAccess("auto-accept-edits", "full-access")).toBe("auto-accept-edits");
    expect(clampWorkAccess("auto", "auto-accept-edits")).toBe("ask-first");
    expect(clampWorkAccess("ask-first", "full-access")).toBe("ask-first");
    expect(clampWorkAccess("auto", "auto")).toBe("auto");
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

describe("which runtimes Octant Shield can review", () => {
  it("reviews every runtime that sends its prompts to Octant, and none that decides alone", () => {
    for (const kind of [
      "openai-compatible",
      "ollama",
      "claude",
      "codex",
      "opencode",
      "pi",
      "kilo",
    ]) {
      expect(shieldRoutesApprovals(kind as never), kind).toBe(true);
    }
    for (const kind of ["oh-my-pi", "openai-image"]) {
      expect(shieldRoutesApprovals(kind as never), kind).toBe(false);
    }
  });

  it("takes the Project's reviewer over Settings'", () => {
    expect(
      chosenAutoReviewer({
        project: { autoReviewer: "provider" },
        settings: { autoReviewer: "octant-shield" },
      }),
    ).toBe("provider");
    expect(chosenAutoReviewer({ project: {}, settings: { autoReviewer: "octant-shield" } })).toBe(
      "octant-shield",
    );
    expect(chosenAutoReviewer({})).toBeUndefined();
  });
});

describe("who reviews at Auto", () => {
  const auto = { executionPolicy: "approval-gated", autoApprove: true } as const;
  const shieldRuns = { available: true } as const;

  it("defaults to the provider's own reviewer where it has one and Octant Shield elsewhere", () => {
    expect(
      resolveGuardrail({ access: auto, capabilities: { ...claudeOrCodex, shield: shieldRuns } }),
    ).toMatchObject({ status: "supported", approver: "provider-review" });
    expect(
      resolveGuardrail({ access: auto, capabilities: { ...wrappedRuntime, shield: shieldRuns } }),
    ).toMatchObject({ status: "supported", level: "provider-review", approver: "octant-shield" });
  });

  it("uses Octant Shield on Claude or Codex when the person chose it", () => {
    expect(
      resolveGuardrail({
        access: auto,
        capabilities: { ...claudeOrCodex, shield: shieldRuns },
        reviewer: "octant-shield",
      }),
    ).toMatchObject({ approver: "octant-shield" });
  });

  it("reads Provider's own on a provider without one as Octant Shield", () => {
    expect(
      resolveAutoReviewer({ chosen: "provider", providerReview: false, shield: shieldRuns }),
    ).toEqual({ status: "reviewer", reviewer: "octant-shield" });
  });

  it("asks first with the reason when the chosen reviewer cannot run", () => {
    const reason = "No Octant Shield model is configured for this provider.";
    expect(
      resolveGuardrail({
        access: auto,
        capabilities: { ...claudeOrCodex, shield: { available: false, reason } },
        reviewer: "octant-shield",
      }),
    ).toMatchObject({ status: "unsupported", reason, fallback: { mode: "ask-first" } });
    expect(
      resolveGuardrail({
        access: auto,
        capabilities: { ...wrappedRuntime, shield: { available: false, reason } },
      }),
    ).toMatchObject({ status: "unsupported", reason });
  });

  it("lets Shield answer prompts only at Auto on a prompting posture", () => {
    const capabilities = { ...wrappedRuntime, shield: shieldRuns };
    expect(shieldReviewsPrompts({ access: auto, capabilities })).toBe(true);
    expect(
      shieldReviewsPrompts({
        access: { executionPolicy: "auto-accept-edits", autoApprove: true },
        capabilities,
      }),
    ).toBe(true);
    expect(
      shieldReviewsPrompts({ access: { executionPolicy: "approval-gated" }, capabilities }),
    ).toBe(false);
    expect(
      shieldReviewsPrompts({
        access: { executionPolicy: "plan", autoApprove: true },
        capabilities,
      }),
    ).toBe(false);
    expect(
      shieldReviewsPrompts({
        access: auto,
        capabilities: { ...claudeOrCodex, shield: shieldRuns },
      }),
    ).toBe(false);
  });
});

describe("lowering and scope", () => {
  it("counts a move to anything but Ask first or Plan as a lowering", () => {
    expect(guardrailLowered("ask-first", "full-access")).toBe(true);
    expect(guardrailLowered("ask-first", "auto")).toBe(true);
    expect(guardrailLowered("auto", "accept-edits")).toBe(true);
    expect(guardrailLowered("full-access", "ask-first")).toBe(false);
    expect(guardrailLowered("full-access", "plan")).toBe(false);
    expect(guardrailLowered("auto", "auto")).toBe(false);
  });

  it("starts a Work thread at its Project's mode, else Work's default, else Ask first", () => {
    const settings = { defaultAccess: "auto" } as const;
    expect(
      defaultWorkPermissionModeFor({ project: { defaultPermissionMode: "full-access" }, settings }),
    ).toBe("full-access");
    expect(defaultWorkPermissionModeFor({ project: {}, settings })).toBe("auto");
    expect(defaultWorkPermissionModeFor({})).toBe("ask-first");
  });

  it("names the narrowest scope that gives a thread its level", () => {
    expect(guardrailScopeOf({ mode: "auto", globalDefault: "auto" })).toBe("global");
    expect(
      guardrailScopeOf({ mode: "auto", projectDefault: "auto", globalDefault: "ask-first" }),
    ).toBe("project");
    expect(
      guardrailScopeOf({
        mode: "full-access",
        projectDefault: "auto",
        globalDefault: "full-access",
      }),
    ).toBe("thread");
    expect(guardrailScopeOf({ mode: "plan", globalDefault: "auto" })).toBe("thread");
  });
});
