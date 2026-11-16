import { describe, expect, it } from "vitest";
import {
  AUTO_UNSUPPORTED_REASON,
  approvalAnswerUnderPosture,
  approvalPostureOf,
  defaultFullAccessSandboxFor,
  defaultPermissionModeFor,
  defaultWorkPermissionModeFor,
  guardrailLowered,
  guardrailScopeOf,
  guardrailLevelOf,
  hostProviderTurnRefusal,
  hostReadsProviderCatalogUnconfined,
  hostSandboxRefusal,
  hostStartsThreadsAtOpenFullAccess,
  windowsProviderLaunch,
  WINDOWS_CHAT_PROVIDER_REFUSAL,
  WINDOWS_KEPT_SANDBOX_REFUSAL,
  WINDOWS_SANDBOX_MISSING_REASON,
  WINDOWS_STRICT_REFUSAL,
  outsideContentRecordedOnly,
  permissionModeOf,
  permissionModeOfWorkAccess,
  refusesFullAccessSandbox,
  resolveStrict,
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

  it("keeps Octant's confinement and proxied egress at Full access when the thread opted into the sandbox", () => {
    for (const capabilities of [claudeOrCodex, wrappedRuntime]) {
      expect(
        resolveGuardrail({
          access: { executionPolicy: "full-access", fullAccessSandbox: true },
          capabilities,
        }),
      ).toMatchObject({
        status: "supported",
        level: "full-access",
        sandbox: capabilities.providerSandbox ? "both" : "octant",
        approver: "none",
        egress: "provider-endpoints-only",
        outsideContent: "recorded",
      });
    }
    // Absent flag: unchanged, fully open.
    expect(
      resolveGuardrail({
        access: { executionPolicy: "full-access" },
        capabilities: claudeOrCodex,
      }),
    ).toMatchObject({ sandbox: "none", egress: "unrestricted" });
  });

  it("keeps the sandbox at Full access on Codex, Claude, Pi, OpenCode, ACP agents and the Octant Harness, and refuses it elsewhere or on an unknown runtime", () => {
    const sandboxed = { executionPolicy: "full-access", fullAccessSandbox: true } as const;
    expect(refusesFullAccessSandbox({ access: sandboxed, driverKind: "codex" })).toBe(false);
    expect(refusesFullAccessSandbox({ access: sandboxed, driverKind: "claude" })).toBe(false);
    expect(refusesFullAccessSandbox({ access: sandboxed, driverKind: "pi" })).toBe(false);
    expect(refusesFullAccessSandbox({ access: sandboxed, driverKind: "opencode" })).toBe(false);
    expect(refusesFullAccessSandbox({ access: sandboxed, driverKind: "mistral-vibe" })).toBe(false);
    expect(refusesFullAccessSandbox({ access: sandboxed, driverKind: "openai-compatible" })).toBe(
      false,
    );
    for (const driverKind of ["oh-my-pi", undefined] as const) {
      expect(refusesFullAccessSandbox({ access: sandboxed, driverKind })).toBe(true);
    }
    // Without the choice, or below Full access, nothing refuses.
    expect(
      refusesFullAccessSandbox({
        access: { executionPolicy: "full-access" },
        driverKind: "claude",
      }),
    ).toBe(false);
    expect(
      refusesFullAccessSandbox({
        access: { executionPolicy: "approval-gated", fullAccessSandbox: true },
        driverKind: "claude",
      }),
    ).toBe(false);
  });

  it("takes a new Full access thread's sandbox from its Project, else Settings, else off", () => {
    expect(defaultFullAccessSandboxFor({})).toBe(false);
    expect(defaultFullAccessSandboxFor({ settings: { defaultFullAccessSandbox: true } })).toBe(
      true,
    );
    expect(
      defaultFullAccessSandboxFor({
        project: { defaultFullAccessSandbox: false },
        settings: { defaultFullAccessSandbox: true },
      }),
    ).toBe(false);
  });

  it("takes Strict from the thread's own choice, else its Project's, else Settings', else off", () => {
    expect(resolveStrict({})).toBe(false);
    expect(resolveStrict({ settings: { defaultStrict: true } })).toBe(true);
    expect(
      resolveStrict({ project: { defaultStrict: false }, settings: { defaultStrict: true } }),
    ).toBe(false);
    expect(
      resolveStrict({
        thread: { strict: true },
        project: { defaultStrict: false },
        settings: { defaultStrict: false },
      }),
    ).toBe(true);
    expect(resolveStrict({ thread: { strict: false }, project: { defaultStrict: true } })).toBe(
      false,
    );
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

describe("levels on a host without Octant's sandbox", () => {
  it("runs Octant's own terminals and commands only at Full access with the sandbox off on Windows and names the missing sandbox for every other level", () => {
    expect(
      hostSandboxRefusal({ platform: "win32", access: { executionPolicy: "full-access" } }),
    ).toBeUndefined();
    for (const access of [
      { executionPolicy: "approval-gated" },
      { executionPolicy: "approval-gated", autoApprove: true },
      { executionPolicy: "auto-accept-edits" },
      { executionPolicy: "plan" },
      { executionPolicy: "full-access", fullAccessSandbox: true },
    ] as const) {
      expect(hostSandboxRefusal({ platform: "win32", access })).toBe(
        WINDOWS_SANDBOX_MISSING_REASON,
      );
    }
    expect(WINDOWS_SANDBOX_MISSING_REASON).toMatch(/sandbox.*Windows/);
  });

  it("counts a host as starting threads at open Full access only when a Code or Work default is Full access without the sandbox", () => {
    expect(hostStartsThreadsAtOpenFullAccess({})).toBe(false);
    expect(
      hostStartsThreadsAtOpenFullAccess({ code: { defaultExecutionPolicy: "full-access" } }),
    ).toBe(true);
    expect(
      hostStartsThreadsAtOpenFullAccess({
        code: { defaultExecutionPolicy: "full-access", defaultFullAccessSandbox: true },
      }),
    ).toBe(false);
    expect(
      hostStartsThreadsAtOpenFullAccess({ code: { defaultExecutionPolicy: "approval-gated" } }),
    ).toBe(false);
    expect(hostStartsThreadsAtOpenFullAccess({ work: { defaultAccess: "full-access" } })).toBe(
      true,
    );
    expect(hostStartsThreadsAtOpenFullAccess({ work: { defaultAccess: "auto" } })).toBe(false);
  });

  it("starts a provider turn at every level outside Strict on Windows and refuses Strict and a kept sandbox by name", () => {
    for (const access of [
      { executionPolicy: "full-access" },
      { executionPolicy: "approval-gated" },
      { executionPolicy: "approval-gated", autoApprove: true },
      { executionPolicy: "auto-accept-edits" },
      { executionPolicy: "plan" },
    ] as const) {
      expect(hostProviderTurnRefusal({ platform: "win32", access, strict: false })).toBeUndefined();
    }
    expect(
      hostProviderTurnRefusal({
        platform: "win32",
        access: { executionPolicy: "approval-gated" },
        strict: true,
      }),
    ).toBe(WINDOWS_STRICT_REFUSAL);
    expect(WINDOWS_STRICT_REFUSAL).toMatch(/^Strict needs a sandbox Windows doesn't have yet/);
    expect(
      hostProviderTurnRefusal({
        platform: "win32",
        access: { executionPolicy: "full-access", fullAccessSandbox: true },
        strict: false,
      }),
    ).toBe(WINDOWS_KEPT_SANDBOX_REFUSAL);
    // Strict confines nothing at Full access on any platform.
    expect(
      hostProviderTurnRefusal({
        platform: "win32",
        access: { executionPolicy: "full-access" },
        strict: true,
      }),
    ).toBeUndefined();
    expect(
      hostProviderTurnRefusal({
        platform: "linux",
        access: { executionPolicy: "approval-gated" },
        strict: true,
      }),
    ).toBeUndefined();
  });

  it("decides each Windows provider launch from its own mode, level and Strict value", () => {
    expect(windowsProviderLaunch({ mode: "code", executionPolicy: "full-access" })).toEqual({
      status: "unconfined",
      approvals: "none",
    });
    expect(
      windowsProviderLaunch({ mode: "work", executionPolicy: "approval-gated", strict: false }),
    ).toEqual({ status: "unconfined", approvals: "provider" });
    expect(windowsProviderLaunch({ mode: "code", executionPolicy: "plan", strict: false })).toEqual(
      {
        status: "unconfined",
        approvals: "provider",
      },
    );
    // A launch that does not carry its Strict value is Strict.
    expect(windowsProviderLaunch({ mode: "code", executionPolicy: "auto-accept-edits" })).toEqual({
      status: "refused",
      reason: WINDOWS_STRICT_REFUSAL,
    });
    expect(
      windowsProviderLaunch({
        mode: "code",
        executionPolicy: "full-access",
        fullAccessSandbox: true,
        strict: false,
      }),
    ).toEqual({ status: "refused", reason: WINDOWS_KEPT_SANDBOX_REFUSAL });
    expect(windowsProviderLaunch({ mode: "chat", executionPolicy: "plan", strict: false })).toEqual(
      { status: "refused", reason: WINDOWS_CHAT_PROVIDER_REFUSAL },
    );
  });

  it("reads a provider catalog unconfined on Windows unless a Settings default is Strict and none is open Full access", () => {
    expect(hostReadsProviderCatalogUnconfined({})).toBe(true);
    expect(
      hostReadsProviderCatalogUnconfined({
        code: { defaultExecutionPolicy: "approval-gated", defaultStrict: true },
      }),
    ).toBe(false);
    expect(
      hostReadsProviderCatalogUnconfined({
        code: { defaultExecutionPolicy: "approval-gated", defaultStrict: true },
        work: { defaultAccess: "full-access" },
      }),
    ).toBe(true);
  });

  it("refuses nothing on macOS or Linux, where the sandbox exists", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(
        hostSandboxRefusal({ platform, access: { executionPolicy: "approval-gated" } }),
      ).toBeUndefined();
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

  it("maps each Work level back to the Code mode that stands for it", () => {
    for (const mode of ["auto", "ask-first", "accept-edits", "full-access"] as const) {
      const access = workAccessOfPermissionMode(mode);
      expect(access === undefined ? undefined : permissionModeOfWorkAccess(access)).toBe(mode);
    }
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

describe("outside content at each level", () => {
  it("is recorded only for a Work or Code thread at Full access, and gates everywhere else", () => {
    for (const mode of ["work", "code"] as const) {
      expect(outsideContentRecordedOnly({ mode, executionPolicy: "full-access" })).toBe(true);
      for (const executionPolicy of ["approval-gated", "auto-accept-edits", "plan"] as const) {
        expect([
          mode,
          executionPolicy,
          outsideContentRecordedOnly({ mode, executionPolicy }),
        ]).toEqual([mode, executionPolicy, false]);
      }
    }
    expect(outsideContentRecordedOnly({ mode: "chat", executionPolicy: "full-access" })).toBe(
      false,
    );
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

describe("answering an approval after the posture changed", () => {
  const askFirst = approvalPostureOf({
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  });
  const auto = approvalPostureOf({
    executionPolicy: "approval-gated",
    autoApprove: true,
    permissionPersistence: "current-session",
  });
  const plan = approvalPostureOf({
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  });

  it("delivers an allow given under the posture the thread still holds", () => {
    expect(
      approvalAnswerUnderPosture({ approved: true, askedUnder: askFirst, current: askFirst }),
    ).toBe("deliver");
  });

  it("asks again when an allow was given under a posture the thread no longer holds", () => {
    expect(
      approvalAnswerUnderPosture({ approved: true, askedUnder: askFirst, current: plan }),
    ).toBe("ask-again");
    expect(
      approvalAnswerUnderPosture({ approved: true, askedUnder: askFirst, current: auto }),
    ).toBe("ask-again");
    expect(
      approvalAnswerUnderPosture({ approved: true, askedUnder: undefined, current: askFirst }),
    ).toBe("ask-again");
    expect(
      approvalAnswerUnderPosture({ approved: true, askedUnder: askFirst, current: undefined }),
    ).toBe("ask-again");
  });

  it("delivers a denial whatever the posture became", () => {
    expect(
      approvalAnswerUnderPosture({ approved: false, askedUnder: askFirst, current: plan }),
    ).toBe("deliver");
  });
});
