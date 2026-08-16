import { describe, expect, it } from "vitest";
import {
  AutomationDefinition,
  AutomationQuery,
  AutomationRun,
  decodeAutomationCommand,
  decodeAutomationDefinition,
  decodeAutomationEvent,
  decodeAutomationQuery,
  decodeAutomationRun,
  decodeAutomationTrigger,
} from "./automation";

const ids = {
  automation: "00000000-0000-4000-8000-000000000796",
  run: "00000000-0000-4000-8000-000000000797",
  profile: "00000000-0000-4000-8000-000000000798",
  authorityProfile: "00000000-0000-4000-8000-000000000799",
  targetRevision: "00000000-0000-4000-8000-000000000800",
  project: "00000000-0000-4000-8000-000000000801",
  binding: "00000000-0000-4000-8000-000000000802",
  revision: "00000000-0000-4000-8000-000000000803",
  request: "00000000-0000-4000-8000-000000000804",
  actor: "00000000-0000-4000-8000-000000000805",
} as const;

const at = "2026-08-10T12:00:00.000Z";
const weeklyDueAt = "2026-08-10T07:30:00.000Z";
const weeklyResolution = {
  resolutionVersion: 1,
  timeZone: "Europe/Oslo",
  timeZoneDatabase: "tzdb-2026a",
  resolvedAt: weeklyDueAt,
  resolvedLocalDate: "2026-08-10",
  resolvedLocalTime: "09:30",
  utcOffsetMinutes: 120,
  resolution: "exact" as const,
};
const approvalAuthority = {
  filesystem: true,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated" as const,
  permissionPersistence: "current-session" as const,
};

const trigger = {
  kind: "weekly-local" as const,
  weekdays: [1, 3, 5],
  localTime: "09:30",
  timeZone: "Europe/Oslo",
};

const target = {
  revisionId: ids.targetRevision,
  revision: 1,
  mode: "work" as const,
  summary: "Produce the reviewed research brief",
  confirmed: true as const,
  confirmedBy: ids.actor,
  confirmedAt: at,
};

const definition = {
  id: ids.automation,
  displayName: "Weekly research",
  taskPrompt: "Prepare the weekly research brief from the approved project context.",
  lifecycle: "enabled" as const,
  hostId: "local",
  mode: "work" as const,
  projectId: ids.project,
  projectVersion: 4,
  binding: {
    kind: "work" as const,
    hostId: "local",
    projectId: ids.project,
    projectVersion: 4,
    bindingRevisionId: ids.binding,
    bindingReceiptId: `${"a".repeat(42)}A`,
  },
  executionProfile: {
    profileId: ids.profile,
    profileVersion: 2,
    hostId: "local",
    mode: "work" as const,
    projectId: ids.project,
    providerInstanceId: "00000000-0000-4000-8000-000000000806",
    modelId: "research-model",
    executionPolicy: "approval-gated" as const,
    permissionPersistence: "current-session" as const,
  },
  authorityProfile: {
    profileId: ids.authorityProfile,
    profileVersion: 2,
    requested: approvalAuthority,
    effective: approvalAuthority,
    effectiveAuthorityDigest: "authority-digest-796",
  },
  deliveryTarget: target,
  trigger,
  missedRunPolicy: "run-once" as const,
  targetPolicy: "new-thread" as const,
  definitionRevision: 3,
  nextDueAt: weeklyDueAt,
  nextDueResolution: weeklyResolution,
  blockedReason: undefined,
  createdBy: { kind: "local-user" as const, actorId: ids.actor },
  updatedBy: { kind: "local-user" as const, actorId: ids.actor },
  version: 4,
  createdAt: at,
  updatedAt: at,
};

describe("automation contracts", () => {
  it("decodes typed triggers and rejects unsafe or unsupported trigger input", () => {
    expect(decodeAutomationTrigger(trigger)).toEqual(trigger);
    expect(
      decodeAutomationTrigger({
        kind: "interval",
        anchorAt: at,
        intervalMinutes: 15,
      }),
    ).toMatchObject({ kind: "interval" });
    expect(() => decodeAutomationTrigger({ ...trigger, cron: "* * * * *" })).toThrow();
    expect(() => decodeAutomationTrigger({ ...trigger, weekdays: [1, 1] })).toThrow();
    expect(() => decodeAutomationTrigger({ ...trigger, localTime: "25:00" })).toThrow();
    expect(() =>
      decodeAutomationTrigger({
        kind: "interval",
        anchorAt: at,
        intervalMinutes: 14,
      }),
    ).toThrow();
    expect(() => decodeAutomationTrigger({ ...trigger, timeZone: "not/a-time-zone" })).toThrow();
  });

  it("decodes a bounded definition and fails closed on Chat, excess, and unconfirmed targets", () => {
    expect(decodeAutomationDefinition(definition)).toEqual(definition);
    expect(() => decodeAutomationDefinition({ ...definition, unexpected: true })).toThrow();
    expect(() => decodeAutomationDefinition({ ...definition, mode: "chat" })).toThrow();
    expect(() =>
      decodeAutomationDefinition({
        ...definition,
        deliveryTarget: { ...target, confirmed: false },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationDefinition({
        ...definition,
        taskPrompt: "x".repeat(10_000),
      }),
    ).toThrow();
  });

  it("validates definitions embedded in every persisted definition event", () => {
    const validEvents = [
      {
        eventName: "automation-definition-created@1",
        payload: { automation: definition },
      },
      {
        eventName: "automation-definition-updated@1",
        payload: { automation: definition, previousDefinitionRevision: 2 },
      },
      {
        eventName: "automation-definition-lifecycle-changed@1",
        payload: { automation: definition, previousLifecycle: "paused" },
      },
    ] as const;
    for (const event of validEvents) {
      expect(decodeAutomationEvent(event)).toMatchObject({ eventName: event.eventName });
    }

    const invalidDefinition = {
      ...definition,
      binding: { ...definition.binding, hostId: "other-host" },
    };
    const invalidEvents = [
      {
        eventName: "automation-definition-created@1",
        payload: { automation: invalidDefinition },
      },
      {
        eventName: "automation-definition-updated@1",
        payload: { automation: invalidDefinition, previousDefinitionRevision: 2 },
      },
      {
        eventName: "automation-definition-lifecycle-changed@1",
        payload: { automation: invalidDefinition, previousLifecycle: "paused" },
      },
    ] as const;
    for (const event of invalidEvents) {
      expect(() => decodeAutomationEvent(event)).toThrow();
    }
    for (const event of validEvents) {
      expect(() =>
        decodeAutomationEvent({
          ...event,
          payload: {
            ...event.payload,
            automation: { ...event.payload.automation, blockedReason: "host-mismatch" },
          },
        }),
      ).toThrow();
    }
    for (const lifecycle of ["archived", "exhausted"] as const) {
      const terminalDefinition = { ...definition, lifecycle, nextDueAt: at };
      expect(() =>
        decodeAutomationEvent({
          eventName: "automation-definition-created@1",
          payload: { automation: terminalDefinition },
        }),
      ).toThrow();
      expect(() =>
        decodeAutomationEvent({
          eventName: "automation-definition-updated@1",
          payload: { automation: terminalDefinition, previousDefinitionRevision: 2 },
        }),
      ).toThrow();
      expect(() =>
        decodeAutomationEvent({
          eventName: "automation-definition-lifecycle-changed@1",
          payload: { automation: terminalDefinition, previousLifecycle: "enabled" },
        }),
      ).toThrow();
    }

    const onceDefinition = {
      ...definition,
      trigger: { kind: "once" as const, scheduledAt: at },
      nextDueAt: null,
      nextDueResolution: undefined,
    };
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-definition-created@1",
        payload: { automation: onceDefinition },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-definition-updated@1",
        payload: {
          automation: { ...onceDefinition, nextDueAt: "2026-08-10T13:00:00.000Z" },
          previousDefinitionRevision: 2,
        },
      }),
    ).toThrow();
    expect(
      decodeAutomationEvent({
        eventName: "automation-definition-lifecycle-changed@1",
        payload: { automation: { ...onceDefinition, nextDueAt: at }, previousLifecycle: "paused" },
      }),
    ).toMatchObject({ eventName: "automation-definition-lifecycle-changed@1" });

    for (const recurringTrigger of [
      {
        kind: "interval" as const,
        anchorAt: at,
        intervalMinutes: 60 as const,
      },
      {
        kind: "weekly-local" as const,
        weekdays: [1, 3, 5],
        localTime: "09:30",
        timeZone: "Europe/Oslo",
      },
    ]) {
      const recurringDueAt = recurringTrigger.kind === "interval" ? at : weeklyDueAt;
      const invalidRecurringDueAt =
        recurringTrigger.kind === "interval" ? "2026-08-10T12:01:00.000Z" : at;
      expect(() =>
        decodeAutomationEvent({
          eventName: "automation-definition-created@1",
          payload: { automation: { ...definition, trigger: recurringTrigger, nextDueAt: null } },
        }),
      ).toThrow();
      expect(() =>
        decodeAutomationEvent({
          eventName: "automation-definition-created@1",
          payload: {
            automation: {
              ...definition,
              trigger: recurringTrigger,
              nextDueAt: invalidRecurringDueAt,
              nextDueResolution:
                recurringTrigger.kind === "weekly-local" ? weeklyResolution : undefined,
            },
          },
        }),
      ).toThrow();
      if (recurringTrigger.kind === "weekly-local") {
        expect(
          decodeAutomationEvent({
            eventName: "automation-definition-created@1",
            payload: {
              automation: {
                ...definition,
                trigger: recurringTrigger,
                nextDueAt: at,
                nextDueResolution: {
                  ...weeklyResolution,
                  timeZoneDatabase: "tzdb-before-update",
                  resolvedAt: at,
                  utcOffsetMinutes: -150,
                },
              },
            },
          }),
        ).toMatchObject({ eventName: "automation-definition-created@1" });
      }
      expect(
        decodeAutomationEvent({
          eventName: "automation-definition-updated@1",
          payload: {
            automation: {
              ...definition,
              trigger: recurringTrigger,
              nextDueAt: recurringDueAt,
              nextDueResolution:
                recurringTrigger.kind === "weekly-local" ? weeklyResolution : undefined,
            },
            previousDefinitionRevision: 2,
          },
        }),
      ).toMatchObject({ eventName: "automation-definition-updated@1" });
    }
  });

  it("keeps run snapshots and command/query shapes strict and bounded", () => {
    const run = {
      id: ids.run,
      automationId: ids.automation,
      occurrence: {
        kind: "manual" as const,
        automationId: ids.automation,
        definitionRevision: definition.definitionRevision,
        runNowRequestId: ids.request,
      },
      occurrenceKey:
        "manual:00000000-0000-4000-8000-000000000796:3:00000000-0000-4000-8000-000000000804",
      scheduledAt: null,
      claimedAt: at,
      definitionSnapshot: {
        automationId: definition.id,
        definitionRevision: definition.definitionRevision,
        displayName: definition.displayName,
        taskPrompt: definition.taskPrompt,
        hostId: definition.hostId,
        mode: definition.mode,
        projectId: definition.projectId,
        projectVersion: definition.projectVersion,
        binding: definition.binding,
        executionProfile: definition.executionProfile,
        authorityProfile: definition.authorityProfile,
        deliveryTarget: definition.deliveryTarget,
        trigger: definition.trigger,
        missedRunPolicy: definition.missedRunPolicy,
        targetPolicy: definition.targetPolicy,
      },
      authoritySnapshot: {
        ...definition.authorityProfile,
        capturedAt: at,
      },
      firstTurnRequestId: ids.request,
      lifecycle: "queued" as const,
      notificationRefs: [],
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
    expect(decodeAutomationRun(run)).toEqual(run);
    expect(() => decodeAutomationRun({ ...run, transcript: "secret" })).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        occurrenceKey: "manual:unrelated-occurrence-key",
      }),
    ).toThrow();
    const workShellAndGitAuthority = {
      ...run.authoritySnapshot.requested,
      shell: true,
      git: true,
    };
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          authorityProfile: {
            ...run.definitionSnapshot.authorityProfile,
            requested: workShellAndGitAuthority,
            effective: workShellAndGitAuthority,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        authoritySnapshot: {
          ...run.authoritySnapshot,
          requested: workShellAndGitAuthority,
          effective: workShellAndGitAuthority,
        },
      }),
    ).toThrow();

    expect(() =>
      decodeAutomationRun({
        ...run,
        authoritySnapshot: {
          ...run.authoritySnapshot,
          profileId: ids.profile,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        authoritySnapshot: {
          ...run.authoritySnapshot,
          profileVersion: 1,
        },
      }),
    ).toThrow();
    const differentRequestedAuthority = {
      ...run.authoritySnapshot.requested,
      network: true,
    };
    expect(() =>
      decodeAutomationRun({
        ...run,
        authoritySnapshot: {
          ...run.authoritySnapshot,
          requested: differentRequestedAuthority,
          effective: differentRequestedAuthority,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        authoritySnapshot: {
          ...run.authoritySnapshot,
          effectiveAuthorityDigest: "different-authority-digest",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          authorityProfile: {
            ...run.definitionSnapshot.authorityProfile,
            effective: {
              ...run.definitionSnapshot.authorityProfile.effective,
              filesystem: false,
            },
          },
        },
      }),
    ).toThrow();
    const planExecutionProfile = {
      ...run.definitionSnapshot.executionProfile,
      executionPolicy: "plan" as const,
      permissionPersistence: "current-session" as const,
    };
    const approvalGatedAuthority = {
      ...run.authoritySnapshot.requested,
      executionPolicy: "approval-gated" as const,
    };
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          executionProfile: planExecutionProfile,
          authorityProfile: {
            ...run.definitionSnapshot.authorityProfile,
            requested: approvalGatedAuthority,
            effective: approvalGatedAuthority,
          },
        },
        authoritySnapshot: {
          ...run.authoritySnapshot,
          requested: approvalGatedAuthority,
          effective: approvalGatedAuthority,
        },
      }),
    ).toThrow();
    const projectDefaultPlanAuthority = {
      ...run.authoritySnapshot.requested,
      executionPolicy: "plan" as const,
      permissionPersistence: "project-default" as const,
    };
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          executionProfile: planExecutionProfile,
          authorityProfile: {
            ...run.definitionSnapshot.authorityProfile,
            requested: projectDefaultPlanAuthority,
            effective: projectDefaultPlanAuthority,
          },
        },
        authoritySnapshot: {
          ...run.authoritySnapshot,
          requested: projectDefaultPlanAuthority,
          effective: projectDefaultPlanAuthority,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        automationId: ids.project,
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        scheduledAt: at,
      }),
    ).toThrow();
    const scheduledRun = {
      ...run,
      occurrence: {
        kind: "scheduled" as const,
        automationId: ids.automation,
        definitionRevision: definition.definitionRevision,
        triggerKind: "weekly-local" as const,
        scheduledAt: "2026-08-10T07:30:00.000Z",
        resolutionEvidence: weeklyResolution,
      },
      occurrenceKey:
        "scheduled:00000000-0000-4000-8000-000000000796:3:weekly-local:2026-08-10T07:30:00.000Z",
      scheduledAt: "2026-08-10T07:30:00.000Z",
    };
    expect(decodeAutomationRun(scheduledRun)).toMatchObject({
      scheduledAt: "2026-08-10T07:30:00.000Z",
    });
    expect(() =>
      decodeAutomationRun({
        ...scheduledRun,
        occurrence: { ...scheduledRun.occurrence, resolutionEvidence: undefined },
      }),
    ).toThrow();
    expect(
      decodeAutomationRun({
        ...scheduledRun,
        occurrence: {
          ...scheduledRun.occurrence,
          scheduledAt: at,
          resolutionEvidence: {
            ...weeklyResolution,
            timeZoneDatabase: "tzdb-before-update",
            resolvedAt: at,
            utcOffsetMinutes: -150,
          },
        },
        occurrenceKey:
          "scheduled:00000000-0000-4000-8000-000000000796:3:weekly-local:2026-08-10T12:00:00.000Z",
        scheduledAt: at,
      }),
    ).toMatchObject({ scheduledAt: at });
    expect(() =>
      decodeAutomationRun({
        ...scheduledRun,
        occurrence: { ...scheduledRun.occurrence, triggerKind: "once" },
        occurrenceKey:
          "scheduled:00000000-0000-4000-8000-000000000796:3:once:2026-08-10T12:00:00.000Z",
      }),
    ).toThrow();
    const intervalRun = {
      ...run,
      definitionSnapshot: {
        ...run.definitionSnapshot,
        trigger: {
          kind: "interval" as const,
          anchorAt: "2026-08-10T00:00:00.000Z",
          intervalMinutes: 60 as const,
        },
      },
      occurrence: {
        kind: "scheduled" as const,
        automationId: ids.automation,
        definitionRevision: definition.definitionRevision,
        triggerKind: "interval" as const,
        scheduledAt: "2026-08-10T00:30:00.000Z",
      },
      occurrenceKey:
        "scheduled:00000000-0000-4000-8000-000000000796:3:interval:2026-08-10T00:30:00.000Z",
      scheduledAt: "2026-08-10T00:30:00.000Z",
    };
    expect(() => decodeAutomationRun(intervalRun)).toThrow();
    const onceScheduledAt = "2026-08-10T13:00:00.000Z";
    const onceRun = {
      ...run,
      definitionSnapshot: {
        ...run.definitionSnapshot,
        trigger: { kind: "once" as const, scheduledAt: at },
      },
      occurrence: {
        kind: "scheduled" as const,
        automationId: ids.automation,
        definitionRevision: definition.definitionRevision,
        triggerKind: "once" as const,
        scheduledAt: onceScheduledAt,
      },
      occurrenceKey:
        "scheduled:00000000-0000-4000-8000-000000000796:3:once:2026-08-10T13:00:00.000Z",
      scheduledAt: onceScheduledAt,
    };
    expect(() => decodeAutomationRun(onceRun)).toThrow();
    expect(
      decodeAutomationRun({
        ...onceRun,
        occurrence: { ...onceRun.occurrence, scheduledAt: at },
        occurrenceKey:
          "scheduled:00000000-0000-4000-8000-000000000796:3:once:2026-08-10T12:00:00.000Z",
        scheduledAt: at,
      }),
    ).toMatchObject({ scheduledAt: at });
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          definitionRevision: 4,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          binding: { ...run.definitionSnapshot.binding, hostId: "other-host" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          mode: "code",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          binding: { ...run.definitionSnapshot.binding, projectVersion: 5 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          authorityProfile: {
            ...run.definitionSnapshot.authorityProfile,
            effective: {
              ...run.definitionSnapshot.authorityProfile.effective,
              executionPolicy: "full-access",
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          executionProfile: {
            ...run.definitionSnapshot.executionProfile,
            projectId: ids.targetRevision,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          executionProfile: {
            ...run.definitionSnapshot.executionProfile,
            executionPolicy: "full-access",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        definitionSnapshot: {
          ...run.definitionSnapshot,
          authorityProfile: {
            ...run.definitionSnapshot.authorityProfile,
            requested: { ...run.definitionSnapshot.authorityProfile.requested, network: false },
            effective: { ...run.definitionSnapshot.authorityProfile.effective, network: true },
          },
        },
      }),
    ).toThrow();

    const fullAccessAuthority = {
      ...run.authoritySnapshot.requested,
      executionPolicy: "full-access" as const,
    };
    const authorityWidenings = [
      {
        requested: { ...run.authoritySnapshot.requested, filesystem: false },
        effective: { ...run.authoritySnapshot.effective, filesystem: true },
      },
      {
        requested: { ...run.authoritySnapshot.requested, shell: false },
        effective: { ...run.authoritySnapshot.effective, shell: true },
      },
      {
        requested: { ...run.authoritySnapshot.requested, git: false },
        effective: { ...run.authoritySnapshot.effective, git: true },
      },
      {
        requested: { ...run.authoritySnapshot.requested, network: false },
        effective: { ...run.authoritySnapshot.effective, network: true },
      },
      {
        requested: { ...run.authoritySnapshot.requested, tools: false },
        effective: { ...run.authoritySnapshot.effective, tools: true },
      },
      {
        requested: { ...run.authoritySnapshot.requested, subagents: false },
        effective: { ...run.authoritySnapshot.effective, subagents: true },
      },
      {
        requested: { ...run.authoritySnapshot.requested, executionPolicy: "plan" },
        effective: { ...run.authoritySnapshot.effective, executionPolicy: "approval-gated" },
      },
      {
        requested: {
          ...run.authoritySnapshot.requested,
          permissionPersistence: "current-session",
        },
        effective: {
          ...run.authoritySnapshot.effective,
          permissionPersistence: "project-default",
        },
      },
    ];
    for (const authority of authorityWidenings) {
      expect(() =>
        decodeAutomationRun({
          ...run,
          authoritySnapshot: { ...run.authoritySnapshot, ...authority },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeAutomationRun({
        ...run,
        authoritySnapshot: {
          ...run.authoritySnapshot,
          requested: fullAccessAuthority,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        authoritySnapshot: {
          ...run.authoritySnapshot,
          effective: fullAccessAuthority,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-run-created@1",
        payload: {
          run: {
            ...run,
            authoritySnapshot: {
              ...run.authoritySnapshot,
              requested: fullAccessAuthority,
            },
          },
        },
      }),
    ).toThrow();

    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-blocked@1",
        payload: {
          automationId: ids.automation,
          reason: "missed-run-cap-exceeded",
          recordedAt: at,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-blocked@1",
        payload: {
          automationId: ids.automation,
          reason: "missed-run-cap-exceeded",
          examinedFrom: "2026-08-10T03:00:00.000Z",
          examinedThrough: "2026-08-10T02:00:00.000Z",
          nextFutureOccurrence: "2026-08-10T04:00:00.000Z",
          recordedAt: at,
        },
      }),
    ).toThrow();
    expect(
      decodeAutomationEvent({
        eventName: "automation-blocked@1",
        payload: {
          automationId: ids.automation,
          reason: "missed-run-cap-exceeded",
          examinedFrom: "2026-08-10T00:00:00.000Z",
          examinedThrough: "2026-08-10T03:00:00.000Z",
          nextFutureOccurrence: "2026-08-10T04:00:00.000Z",
          recordedAt: at,
        },
      }),
    ).toMatchObject({ eventName: "automation-blocked@1" });

    const launchReceipts = {
      dispatchIntent: {
        firstTurnRequestId: ids.request,
        threadId: ids.run,
        authoritySnapshot: run.authoritySnapshot,
        promptDigest: "prompt-digest",
        recordedAt: at,
      },
      runtimeLaunchClaim: {
        firstTurnRequestId: ids.request,
        generation: 1,
        leaseExpiresAt: "2026-08-10T12:05:00.000Z",
        claimedAt: at,
      },
      firstTurnAcceptance: {
        firstTurnRequestId: ids.request,
        runtimeReceipt: "runtime-receipt",
        acceptedAt: at,
      },
    };
    const cancellationTombstone = {
      requestId: ids.request,
      cancelledAt: at,
    };
    expect(
      decodeAutomationRun({
        ...run,
        lifecycle: "cancelled",
        cancellationTombstone,
      }),
    ).toMatchObject({ lifecycle: "cancelled", cancellationTombstone });
    expect(() =>
      decodeAutomationRun({
        ...run,
        lifecycle: "queued",
        cancellationTombstone,
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        lifecycle: "cancelled",
        threadId: ids.run,
        ...launchReceipts,
        cancellationTombstone,
      }),
    ).toThrow();
    for (const lifecycle of ["running", "waiting", "completed", "interrupted"] as const) {
      expect(() =>
        decodeAutomationRun({
          ...run,
          lifecycle,
          threadId: ids.run,
          dispatchIntent: launchReceipts.dispatchIntent,
          runtimeLaunchClaim: launchReceipts.runtimeLaunchClaim,
        }),
      ).toThrow();
      expect(
        decodeAutomationRun({
          ...run,
          lifecycle,
          threadId: ids.run,
          ...launchReceipts,
        }),
      ).toMatchObject({ lifecycle, threadId: ids.run });
    }
    expect(() => decodeAutomationRun({ ...run, threadId: ids.run, ...launchReceipts })).toThrow();
    for (const lifecycle of ["dispatching", "recovering-dispatch"] as const) {
      expect(() =>
        decodeAutomationRun({
          ...run,
          lifecycle,
          threadId: ids.run,
          ...launchReceipts,
        }),
      ).toThrow();
    }
    for (const leaseExpiresAt of [at, "2026-08-10T11:59:59.999Z"]) {
      expect(() =>
        decodeAutomationRun({
          ...run,
          lifecycle: "dispatching",
          threadId: ids.run,
          dispatchIntent: launchReceipts.dispatchIntent,
          runtimeLaunchClaim: { ...launchReceipts.runtimeLaunchClaim, leaseExpiresAt },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeAutomationRun({
        ...run,
        runtimeLaunchClaim: launchReceipts.runtimeLaunchClaim,
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        firstTurnAcceptance: launchReceipts.firstTurnAcceptance,
      }),
    ).toThrow();
    expect(() => decodeAutomationRun({ ...run, ...launchReceipts })).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        threadId: ids.actor,
        ...launchReceipts,
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        threadId: ids.run,
        ...launchReceipts,
        dispatchIntent: {
          ...launchReceipts.dispatchIntent,
          authoritySnapshot: {
            ...run.authoritySnapshot,
            effectiveAuthorityDigest: "different-authority-digest",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        threadId: ids.run,
        ...launchReceipts,
        dispatchIntent: {
          ...launchReceipts.dispatchIntent,
          firstTurnRequestId: ids.actor,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        threadId: ids.run,
        ...launchReceipts,
        runtimeLaunchClaim: {
          ...launchReceipts.runtimeLaunchClaim,
          firstTurnRequestId: ids.actor,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationRun({
        ...run,
        threadId: ids.run,
        ...launchReceipts,
        firstTurnAcceptance: {
          ...launchReceipts.firstTurnAcceptance,
          firstTurnRequestId: ids.actor,
        },
      }),
    ).toThrow();
    expect(() => decodeAutomationRun({ ...run, lifecycle: "failed" })).toThrow();
    expect(
      decodeAutomationRun({
        ...run,
        lifecycle: "failed",
        failure: {
          reason: "provider-launch-failed",
          message: "Provider launch failed before first-turn acceptance.",
        },
      }),
    ).toMatchObject({ failure: { reason: "provider-launch-failed" } });

    expect(
      decodeAutomationEvent({
        eventName: "automation-occurrence-claimed@1",
        payload: {
          automationId: ids.automation,
          runId: ids.run,
          occurrence: run.occurrence,
          occurrenceKey: run.occurrenceKey,
          claimedAt: at,
        },
      }),
    ).toMatchObject({ eventName: "automation-occurrence-claimed@1" });
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-occurrence-claimed@1",
        payload: {
          automationId: ids.project,
          runId: ids.run,
          occurrence: run.occurrence,
          occurrenceKey: run.occurrenceKey,
          claimedAt: at,
        },
      }),
    ).toThrow();

    const scheduledOccurrence = {
      kind: "scheduled" as const,
      automationId: ids.automation,
      definitionRevision: definition.definitionRevision,
      triggerKind: "weekly-local" as const,
      scheduledAt: at,
      resolutionEvidence: {
        ...weeklyResolution,
        resolvedAt: at,
        timeZoneDatabase: "tzdb-before-update",
        utcOffsetMinutes: -150,
      },
    };
    expect(
      decodeAutomationEvent({
        eventName: "automation-occurrence-skipped@1",
        payload: {
          automationId: ids.automation,
          occurrence: scheduledOccurrence,
          occurrenceKey:
            "scheduled:00000000-0000-4000-8000-000000000796:3:weekly-local:2026-08-10T12:00:00.000Z",
          skippedAt: at,
          reason: "missed-run-policy",
        },
      }),
    ).toMatchObject({ eventName: "automation-occurrence-skipped@1" });
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-occurrence-skipped@1",
        payload: {
          automationId: ids.project,
          occurrence: scheduledOccurrence,
          occurrenceKey:
            "scheduled:00000000-0000-4000-8000-000000000796:3:weekly-local:2026-08-10T12:00:00.000Z",
          skippedAt: at,
          reason: "missed-run-policy",
        },
      }),
    ).toThrow();

    expect(
      decodeAutomationEvent({
        eventName: "automation-run-status-changed@1",
        payload: {
          automationId: ids.automation,
          runId: ids.run,
          previousLifecycle: "running",
          lifecycle: "completed",
          version: definition.version,
          updatedAt: at,
        },
      }),
    ).toMatchObject({ eventName: "automation-run-status-changed@1" });
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-run-status-changed@1",
        payload: {
          automationId: ids.automation,
          runId: ids.run,
          previousLifecycle: "running",
          lifecycle: "completed",
          version: definition.version,
          failure: {
            reason: "provider-launch-failed",
            message: "Provider launch failed before first-turn acceptance.",
          },
          updatedAt: at,
        },
      }),
    ).toThrow();
    expect(
      decodeAutomationEvent({
        eventName: "automation-run-status-changed@1",
        payload: {
          automationId: ids.automation,
          runId: ids.run,
          previousLifecycle: "running",
          lifecycle: "failed",
          version: definition.version,
          failure: {
            reason: "provider-launch-failed",
            message: "Provider launch failed before first-turn acceptance.",
          },
          updatedAt: at,
        },
      }),
    ).toMatchObject({ eventName: "automation-run-status-changed@1" });
    expect(() =>
      decodeAutomationEvent({
        eventName: "automation-run-status-changed@1",
        payload: {
          automationId: ids.automation,
          runId: ids.run,
          previousLifecycle: "running",
          lifecycle: "failed",
          version: definition.version,
          updatedAt: at,
        },
      }),
    ).toThrow();

    expect(
      decodeAutomationCommand({
        kind: "run-now-automation",
        automationId: ids.automation,
        expectedVersion: definition.version,
        runNowRequestId: ids.request,
        principal: {
          kind: "local-window",
          windowId: "window-1",
          capabilityGeneration: 0,
        },
        origin: { kind: "interactive" },
      }),
    ).toMatchObject({ kind: "run-now-automation" });
    expect(() =>
      decodeAutomationCommand({
        kind: "run-now-automation",
        automationId: ids.automation,
        expectedVersion: definition.version,
        runNowRequestId: ids.request,
        principal: { kind: "local-user", actorId: ids.actor },
        origin: { kind: "interactive" },
        displayOnlyStatus: "enabled",
      }),
    ).toThrow();

    const query = {
      kind: "list-automations" as const,
      hostId: "local",
      mode: "work" as const,
      limit: 25,
    };
    expect(decodeAutomationQuery(query)).toEqual(query);
    expect(() => decodeAutomationQuery({ ...query, limit: 0 })).toThrow();
    expect(() => decodeAutomationQuery({ ...query, privateCanonicalRoot: "/secret" })).toThrow();
    expect(AutomationDefinition).toBeDefined();
    expect(AutomationRun).toBeDefined();
    expect(AutomationQuery).toBeDefined();
  });

  it("accepts the authenticated local-window generation-zero principal only", () => {
    const command = {
      kind: "run-now-automation" as const,
      automationId: ids.automation,
      expectedVersion: definition.version,
      runNowRequestId: ids.request,
      origin: { kind: "interactive" as const },
    };
    expect(
      decodeAutomationCommand({
        ...command,
        principal: {
          kind: "local-window" as const,
          windowId: "window-1",
          capabilityGeneration: 0,
        },
      }),
    ).toMatchObject({ principal: { kind: "local-window", capabilityGeneration: 0 } });
    expect(() =>
      decodeAutomationCommand({
        ...command,
        principal: {
          kind: "local-window" as const,
          windowId: "window-1",
          capabilityGeneration: -1,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationCommand({
        ...command,
        principal: {
          kind: "local-window" as const,
          windowId: "window-1",
          capabilityGeneration: 0,
          unexpected: true,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeAutomationCommand({
        ...command,
        principal: {
          kind: "remote-device" as const,
          hostId: "00000000-0000-4000-8000-000000000806",
          deviceId: "device-1",
          credentialGeneration: 0,
          origin: "https://remote.octant.local",
          protocolVersion: 1,
          capabilityDigest: "digest",
          sessionId: "session-1",
        },
      }),
    ).toThrow();
  });

  it("keeps unauthenticated local users out of commands while retaining author attribution", () => {
    expect(decodeAutomationDefinition(definition).createdBy).toMatchObject({
      kind: "local-user",
      actorId: ids.actor,
    });
    expect(() =>
      decodeAutomationCommand({
        kind: "run-now-automation",
        automationId: ids.automation,
        expectedVersion: definition.version,
        runNowRequestId: ids.request,
        principal: { kind: "local-user", actorId: ids.actor },
        origin: { kind: "interactive" },
      }),
    ).toThrow();
  });
});
