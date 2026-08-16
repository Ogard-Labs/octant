import { describe, expect, it } from "vitest";
import type {
  AgentRunAuthority,
  AutomationDefinition,
  AutomationWeeklyResolution,
  AutomationTrigger,
} from "@octant/contracts";
import { decodeAutomationTrigger } from "@octant/contracts/automation";
import {
  AutomationPolicyRejected,
  buildAutomationWeeklyResolution,
  buildManualAutomationOccurrenceKey,
  buildScheduledAutomationOccurrenceKey,
  canExhaustOnceAutomation,
  intersectAutomationAuthority,
  isAutomationMutationAllowed,
  isAutomationRunLifecycleActive,
  reconcileMissedAutomationOccurrences,
  resolveNextAutomationOccurrence,
  resolveWeeklyLocalOccurrence,
  validateAutomationDefinition,
} from "./automationPolicy";

const utc = (value: string) => value as never;
const ids = {
  automation: "00000000-0000-4000-8000-000000000796",
  request: "00000000-0000-4000-8000-000000000804",
  actor: "00000000-0000-4000-8000-000000000805",
} as const;

const approval: AgentRunAuthority = {
  filesystem: true,
  shell: true,
  git: true,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
};

const once = decodeAutomationTrigger({
  kind: "once",
  scheduledAt: utc("2026-08-10T12:00:00.000Z"),
}) as Extract<AutomationTrigger, { readonly kind: "once" }>;

const interval = decodeAutomationTrigger({
  kind: "interval",
  anchorAt: utc("2026-08-10T00:00:00.000Z"),
  intervalMinutes: 60,
}) as Extract<AutomationTrigger, { readonly kind: "interval" }>;

const weekly = decodeAutomationTrigger({
  kind: "weekly-local",
  weekdays: [7],
  localTime: "02:30",
  timeZone: "America/New_York",
}) as Extract<AutomationTrigger, { readonly kind: "weekly-local" }>;

const persistedWeeklyResolution: AutomationWeeklyResolution = {
  resolutionVersion: 1,
  timeZone: "America/New_York",
  timeZoneDatabase: "tzdb-before-update",
  resolvedAt: utc("2026-08-09T07:30:00.000Z"),
  resolvedLocalDate: "2026-08-09" as never,
  resolvedLocalTime: "02:30" as never,
  utcOffsetMinutes: -300,
  resolution: "exact",
};

const fullExecutionProfileDefinition = {
  id: ids.automation,
  displayName: "Automation",
  taskPrompt: "Run the approved task.",
  lifecycle: "enabled" as const,
  hostId: "local",
  mode: "code" as const,
  projectId: ids.automation,
  projectVersion: 1,
  binding: {
    kind: "code" as const,
    hostId: "local",
    projectId: ids.automation,
    projectVersion: 1,
    bindingRevisionId: ids.request,
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: ids.request,
    worktreeReceiptId: ids.request,
  },
  executionProfile: {
    profileId: ids.actor,
    profileVersion: 1,
    hostId: "local",
    mode: "code" as const,
    projectId: ids.automation,
    providerInstanceId: ids.actor,
    modelId: "approved-model",
    executionPolicy: "full-access" as const,
    permissionPersistence: "current-session" as const,
  },
  authorityProfile: {
    profileId: ids.automation,
    profileVersion: 1,
    requested: approval,
    effective: approval,
    effectiveAuthorityDigest: "authority-digest",
  },
  deliveryTarget: {
    revisionId: ids.automation,
    revision: 1,
    mode: "code" as const,
    summary: "Complete the approved task.",
    confirmed: true as const,
    confirmedBy: ids.actor,
    confirmedAt: utc("2026-08-10T12:00:00.000Z"),
  },
  trigger: once,
  missedRunPolicy: "skip" as const,
  targetPolicy: "new-thread" as const,
  definitionRevision: 1,
  nextDueAt: once.scheduledAt,
  createdBy: { kind: "local-window" as const, windowId: "window-1", capabilityGeneration: 0 },
  updatedBy: { kind: "local-window" as const, windowId: "window-1", capabilityGeneration: 0 },
  version: 1,
  createdAt: utc("2026-08-10T12:00:00.000Z"),
  updatedAt: utc("2026-08-10T12:00:00.000Z"),
} as unknown as AutomationDefinition;

describe("automation trigger policy", () => {
  it("resolves once and bounded UTC intervals deterministically", () => {
    expect(
      resolveNextAutomationOccurrence({ trigger: once, after: utc("2026-08-10T11:59:59.999Z") }),
    ).toBe("2026-08-10T12:00:00.000Z");
    expect(
      resolveNextAutomationOccurrence({ trigger: once, after: utc("2026-08-10T12:00:00.000Z") }),
    ).toBe(undefined);
    expect(
      resolveNextAutomationOccurrence({
        trigger: interval,
        after: utc("2026-08-10T02:30:00.000Z"),
      }),
    ).toBe("2026-08-10T03:00:00.000Z");
  });

  it("uses the earlier UTC instant for a DST fold and shifts a gap forward", () => {
    expect(
      resolveWeeklyLocalOccurrence(
        decodeAutomationTrigger({ ...weekly, localTime: "01:30" }) as Extract<
          AutomationTrigger,
          { readonly kind: "weekly-local" }
        >,
        utc("2024-11-01T00:00:00.000Z"),
      ),
    ).toBe("2024-11-03T05:30:00.000Z");
    expect(resolveWeeklyLocalOccurrence(weekly, utc("2024-03-08T00:00:00.000Z"))).toBe(
      "2024-03-10T07:00:00.000Z",
    );

    const auckland = decodeAutomationTrigger({
      kind: "weekly-local",
      weekdays: [7],
      localTime: "02:30",
      timeZone: "Pacific/Auckland",
    }) as Extract<AutomationTrigger, { readonly kind: "weekly-local" }>;
    expect(resolveWeeklyLocalOccurrence(auckland, utc("2024-09-28T00:00:00.000Z"))).toBe(
      "2024-09-28T14:00:00.000Z",
    );
  });

  it("reconciles missed occurrences without a catch-up burst and caps unsafe input", () => {
    const skipped = reconcileMissedAutomationOccurrences({
      trigger: interval,
      nextDueAt: utc("2026-08-10T00:00:00.000Z"),
      now: utc("2026-08-10T03:15:00.000Z"),
      policy: "skip",
      cap: 8,
    });
    expect(skipped).toMatchObject({
      kind: "reconciled",
      skipped: [
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T01:00:00.000Z",
        "2026-08-10T02:00:00.000Z",
        "2026-08-10T03:00:00.000Z",
      ],
      claimed: undefined,
      nextDueAt: "2026-08-10T04:00:00.000Z",
    });

    const runOnce = reconcileMissedAutomationOccurrences({
      trigger: interval,
      nextDueAt: utc("2026-08-10T00:00:00.000Z"),
      now: utc("2026-08-10T03:15:00.000Z"),
      policy: "run-once",
      cap: 8,
    });
    expect(runOnce).toMatchObject({
      kind: "reconciled",
      skipped: ["2026-08-10T00:00:00.000Z", "2026-08-10T01:00:00.000Z", "2026-08-10T02:00:00.000Z"],
      claimed: "2026-08-10T03:00:00.000Z",
      nextDueAt: "2026-08-10T04:00:00.000Z",
    });

    expect(
      reconcileMissedAutomationOccurrences({
        trigger: interval,
        nextDueAt: utc("2026-08-10T00:00:00.000Z"),
        now: utc("2026-08-11T00:00:00.000Z"),
        policy: "run-once",
        cap: 3,
      }),
    ).toMatchObject({ kind: "cap-exceeded", reason: "missed-run-cap-exceeded" });
  });
});

describe("automation identity and authority policy", () => {
  it("builds deterministic scheduled and manual occurrence keys", () => {
    const scheduled = buildScheduledAutomationOccurrenceKey({
      automationId: ids.automation as never,
      definitionRevision: 2,
      triggerKind: "interval",
      scheduledAt: utc("2026-08-10T12:00:00.000Z"),
    });
    expect(scheduled).toBe(
      buildScheduledAutomationOccurrenceKey({
        automationId: ids.automation as never,
        definitionRevision: 2,
        triggerKind: "interval",
        scheduledAt: utc("2026-08-10T12:00:00.000Z"),
      }),
    );
    expect(scheduled).not.toBe(
      buildScheduledAutomationOccurrenceKey({
        automationId: ids.automation as never,
        definitionRevision: 3,
        triggerKind: "interval",
        scheduledAt: utc("2026-08-10T12:00:00.000Z"),
      }),
    );
    expect(
      buildManualAutomationOccurrenceKey({
        automationId: ids.automation as never,
        definitionRevision: 2,
        runNowRequestId: ids.request as never,
      }),
    ).toBe(
      buildManualAutomationOccurrenceKey({
        automationId: ids.automation as never,
        definitionRevision: 2,
        runNowRequestId: ids.request as never,
      }),
    );
  });

  it("intersects every authority ceiling and rejects Full access instead of downgrading", () => {
    expect(
      intersectAutomationAuthority({
        requested: approval,
        hostCapability: approval,
        modeProjectCeiling: approval,
        savedProfile: approval,
        providerCapability: { ...approval, network: true },
        mode: "code",
      }),
    ).toEqual(approval);
    expect(() =>
      intersectAutomationAuthority({
        requested: { ...approval, executionPolicy: "full-access" },
        hostCapability: approval,
        modeProjectCeiling: approval,
        savedProfile: { ...approval, executionPolicy: "full-access" },
        providerCapability: approval,
        mode: "code",
      }),
    ).toThrowError(AutomationPolicyRejected);
  });

  it("rejects automation-origin mutation and accepts interactive origin", () => {
    expect(isAutomationMutationAllowed({ kind: "interactive" })).toBe(true);
    expect(
      isAutomationMutationAllowed({
        kind: "automation-run",
        automationId: ids.automation as never,
        runId: ids.request as never,
        occurrenceKey: "scheduled:key" as never,
      }),
    ).toBe(false);
  });

  it("classifies active versus terminal run lifecycles", () => {
    for (const lifecycle of [
      "queued",
      "dispatching",
      "recovering-dispatch",
      "running",
      "waiting",
    ] as const) {
      expect(isAutomationRunLifecycleActive(lifecycle)).toBe(true);
    }
    for (const lifecycle of [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "skipped",
    ] as const) {
      expect(isAutomationRunLifecycleActive(lifecycle)).toBe(false);
    }
  });
});

describe("automation fail-closed revision policy", () => {
  it("rejects a Full access execution profile even with bounded authority receipts", () => {
    expect(() => validateAutomationDefinition(fullExecutionProfileDefinition)).toThrowError(
      AutomationPolicyRejected,
    );
  });

  it("keeps authority within the selected execution profile ceiling", () => {
    const planWithApprovalAuthority = {
      ...fullExecutionProfileDefinition,
      executionProfile: {
        ...fullExecutionProfileDefinition.executionProfile,
        executionPolicy: "plan" as const,
        permissionPersistence: "current-session" as const,
      },
    } as AutomationDefinition;
    expect(() => validateAutomationDefinition(planWithApprovalAuthority)).toThrowError(
      AutomationPolicyRejected,
    );

    const planWithProjectDefaultAuthority = {
      ...planWithApprovalAuthority,
      authorityProfile: {
        ...planWithApprovalAuthority.authorityProfile,
        requested: {
          ...approval,
          executionPolicy: "plan" as const,
          permissionPersistence: "project-default" as const,
        },
        effective: {
          ...approval,
          executionPolicy: "plan" as const,
          permissionPersistence: "project-default" as const,
        },
      },
    } as AutomationDefinition;
    expect(() => validateAutomationDefinition(planWithProjectDefaultAuthority)).toThrowError(
      AutomationPolicyRejected,
    );
  });

  it("exhausts a once definition only when the current revision consumed its instant", () => {
    expect(
      canExhaustOnceAutomation({
        trigger: once,
        currentDefinitionRevision: 2,
        occurrenceDefinitionRevision: 2,
        currentOnceAt: once.scheduledAt,
        occurrenceScheduledAt: once.scheduledAt,
        terminal: true,
      }),
    ).toBe(true);
    expect(
      canExhaustOnceAutomation({
        trigger: once,
        currentDefinitionRevision: 3,
        occurrenceDefinitionRevision: 2,
        currentOnceAt: once.scheduledAt,
        occurrenceScheduledAt: once.scheduledAt,
        terminal: true,
      }),
    ).toBe(false);
  });

  it("fails closed for malformed definition data rather than trusting display facts", () => {
    expect(() =>
      validateAutomationDefinition({
        mode: "chat",
        displayName: "display-only fact",
      } as unknown as AutomationDefinition),
    ).toThrowError(AutomationPolicyRejected);
  });

  it("keeps enabled once definitions bound to their configured due instant", () => {
    const validDefinition = {
      ...fullExecutionProfileDefinition,
      executionProfile: {
        ...fullExecutionProfileDefinition.executionProfile,
        executionPolicy: "approval-gated" as const,
      },
      nextDueAt: once.scheduledAt,
    } as AutomationDefinition;
    expect(validateAutomationDefinition(validDefinition)).toMatchObject({
      nextDueAt: once.scheduledAt,
    });
    expect(() =>
      validateAutomationDefinition({ ...validDefinition, blockedReason: "host-mismatch" }),
    ).toThrowError(AutomationPolicyRejected);
    expect(() =>
      validateAutomationDefinition({ ...validDefinition, nextDueAt: null }),
    ).toThrowError(AutomationPolicyRejected);
    expect(() =>
      validateAutomationDefinition({
        ...validDefinition,
        nextDueAt: "2026-08-10T13:00:00.000Z" as never,
      }),
    ).toThrowError(AutomationPolicyRejected);

    for (const recurringTrigger of [interval, weekly]) {
      const recurringDueAt =
        recurringTrigger.kind === "interval"
          ? utc("2026-08-10T12:00:00.000Z")
          : utc("2026-08-09T06:30:00.000Z");
      const invalidRecurringDueAt =
        recurringTrigger.kind === "interval"
          ? utc("2026-08-10T12:01:00.000Z")
          : utc("2026-08-09T06:31:00.000Z");
      expect(() =>
        validateAutomationDefinition({
          ...validDefinition,
          trigger: recurringTrigger,
          nextDueAt: null,
        }),
      ).toThrowError(AutomationPolicyRejected);
      expect(() =>
        validateAutomationDefinition({
          ...validDefinition,
          trigger: recurringTrigger,
          nextDueAt: invalidRecurringDueAt,
        }),
      ).toThrowError(AutomationPolicyRejected);
      expect(
        validateAutomationDefinition({
          ...validDefinition,
          trigger: recurringTrigger,
          nextDueAt: recurringDueAt,
        }),
      ).toMatchObject({ trigger: recurringTrigger, nextDueAt: recurringDueAt });
    }

    const persistedWeeklyDefinition = {
      ...validDefinition,
      trigger: weekly,
      nextDueAt: persistedWeeklyResolution.resolvedAt,
      nextDueResolution: persistedWeeklyResolution,
    } as AutomationDefinition;
    expect(validateAutomationDefinition(persistedWeeklyDefinition)).toMatchObject({
      nextDueAt: persistedWeeklyResolution.resolvedAt,
      nextDueResolution: persistedWeeklyResolution,
    });
    expect(() =>
      validateAutomationDefinition({
        ...persistedWeeklyDefinition,
        nextDueResolution: {
          ...persistedWeeklyResolution,
          resolvedAt: utc("2026-08-09T06:30:00.000Z"),
        },
      } as AutomationDefinition),
    ).toThrowError(AutomationPolicyRejected);
  });
});

describe("automation weekly resolution evidence", () => {
  it("builds exact evidence for an unambiguous local occurrence", () => {
    const evidence = buildAutomationWeeklyResolution({
      trigger: weekly,
      scheduledAt: utc("2026-08-09T06:30:00.000Z"),
    });
    expect(evidence).toMatchObject({
      resolutionVersion: 1,
      timeZone: "America/New_York",
      resolvedAt: "2026-08-09T06:30:00.000Z",
      resolvedLocalDate: "2026-08-09",
      resolvedLocalTime: "02:30",
      utcOffsetMinutes: -240,
      resolution: "exact",
    });
  });

  it("builds gap-forward evidence for the first valid instant after a DST gap", () => {
    const gapScheduledAt = resolveWeeklyLocalOccurrence(weekly, utc("2026-03-07T00:00:00.000Z"));
    expect(gapScheduledAt).toBe("2026-03-08T07:00:00.000Z");
    const evidence = buildAutomationWeeklyResolution({
      trigger: weekly,
      scheduledAt: gapScheduledAt!,
    });
    expect(evidence).toMatchObject({
      resolvedLocalDate: "2026-03-08",
      resolvedLocalTime: "03:00",
      utcOffsetMinutes: -240,
      resolution: "gap-forward",
    });
  });

  it("builds fold-earlier evidence when the local minute occurs twice", () => {
    const foldTrigger = decodeAutomationTrigger({ ...weekly, localTime: "01:30" }) as Extract<
      AutomationTrigger,
      { readonly kind: "weekly-local" }
    >;
    const foldScheduledAt = resolveWeeklyLocalOccurrence(
      foldTrigger,
      utc("2026-10-31T00:00:00.000Z"),
    );
    expect(foldScheduledAt).toBe("2026-11-01T05:30:00.000Z");
    const evidence = buildAutomationWeeklyResolution({
      trigger: foldTrigger,
      scheduledAt: foldScheduledAt!,
    });
    expect(evidence).toMatchObject({
      resolvedLocalDate: "2026-11-01",
      resolvedLocalTime: "01:30",
      utcOffsetMinutes: -240,
      resolution: "fold-earlier",
    });
  });

  it("rejects instants that are not the canonical resolution of the trigger", () => {
    // Wrong minute for the trigger's local wall time.
    expect(() =>
      buildAutomationWeeklyResolution({
        trigger: weekly,
        scheduledAt: utc("2026-08-09T06:31:00.000Z"),
      }),
    ).toThrowError(AutomationPolicyRejected);
    // Correct local minute but wrong weekday (2026-08-10 is a Monday).
    expect(() =>
      buildAutomationWeeklyResolution({
        trigger: weekly,
        scheduledAt: utc("2026-08-10T06:30:00.000Z"),
      }),
    ).toThrowError(AutomationPolicyRejected);
    // The later fold instant is never the canonical earlier choice.
    const foldTrigger = decodeAutomationTrigger({ ...weekly, localTime: "01:30" }) as Extract<
      AutomationTrigger,
      { readonly kind: "weekly-local" }
    >;
    expect(() =>
      buildAutomationWeeklyResolution({
        trigger: foldTrigger,
        scheduledAt: utc("2026-11-01T06:30:00.000Z"),
      }),
    ).toThrowError(AutomationPolicyRejected);
  });

  it("produces evidence the persisted definition policy accepts", () => {
    const baseDefinition = {
      ...fullExecutionProfileDefinition,
      executionProfile: {
        ...fullExecutionProfileDefinition.executionProfile,
        executionPolicy: "approval-gated" as const,
      },
      trigger: weekly,
    } as AutomationDefinition;
    for (const scheduledAt of [
      utc("2026-08-09T06:30:00.000Z"),
      resolveWeeklyLocalOccurrence(weekly, utc("2026-03-07T00:00:00.000Z"))!,
    ]) {
      const evidence = buildAutomationWeeklyResolution({ trigger: weekly, scheduledAt });
      expect(
        validateAutomationDefinition({
          ...baseDefinition,
          nextDueAt: scheduledAt,
          nextDueResolution: evidence,
        } as AutomationDefinition),
      ).toMatchObject({ nextDueAt: scheduledAt });
    }
  });
});
