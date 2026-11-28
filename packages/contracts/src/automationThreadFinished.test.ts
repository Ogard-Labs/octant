import { describe, expect, it } from "vitest";
import {
  AutomationDefinitionSnapshot,
  AUTOMATION_THREAD_FINISHED_READS_FLAG,
  automationLevelFitsTrigger,
  automationThreadFinishedTurnPrompt,
  decodeAutomationDefinitionDraft,
  decodeAutomationFinishWaitChanged,
  decodeAutomationOccurrence,
  decodeAutomationThreadFinishedTrigger,
  decodeRoutineFinishWaitProposal,
  deriveAutomationOccurrenceKey,
  parseAutomationFollowUpTurnPrompt,
  parseAutomationThreadFinishedTurnPrompt,
} from "./automation";

const IDS = {
  automation: "11111111-1111-4111-8111-111111111111",
  wait: "22222222-2222-4222-8222-222222222222",
  originThread: "33333333-3333-4333-8333-333333333333",
  targetThread: "44444444-4444-4444-8444-444444444444",
  project: "55555555-5555-4555-8555-555555555555",
  host: "66666666-6666-4666-8666-666666666666",
  profile: "77777777-7777-4777-8777-777777777777",
  authorityProfile: "88888888-8888-4888-8888-888888888888",
  deliveryTarget: "99999999-9999-4999-8999-999999999999",
  actor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  provider: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  bindingRevision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  proposal: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

const authority = {
  filesystem: true,
  shell: true,
  git: true,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated" as const,
  permissionPersistence: "project-default" as const,
};

function baseDraft(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Follow up after build thread",
    taskPrompt: "Review the diff and continue.",
    hostId: IDS.host,
    mode: "work" as const,
    projectId: IDS.project,
    projectVersion: 1,
    binding: {
      kind: "work" as const,
      hostId: IDS.host,
      projectId: IDS.project,
      projectVersion: 1,
      bindingRevisionId: IDS.bindingRevision,
      bindingReceiptId: "A".repeat(43),
    },
    executionProfile: {
      profileId: IDS.profile,
      profileVersion: 1,
      hostId: IDS.host,
      mode: "work" as const,
      projectId: IDS.project,
      providerInstanceId: IDS.provider,
      modelId: "claude-sonnet-4-6",
      executionPolicy: "approval-gated" as const,
      permissionPersistence: "project-default" as const,
    },
    authorityProfile: {
      profileId: IDS.authorityProfile,
      profileVersion: 1,
      requested: authority,
      effective: authority,
      effectiveAuthorityDigest: "a".repeat(64),
    },
    deliveryTarget: {
      revisionId: IDS.deliveryTarget,
      revision: 1,
      mode: "work" as const,
      summary: "One follow-up turn in the Work thread.",
      confirmed: true as const,
      confirmedBy: IDS.actor,
      confirmedAt: "2026-11-28T10:00:00.000Z",
    },
    trigger: {
      kind: "thread-finished" as const,
      targetThreadId: IDS.targetThread,
      targetMode: "work" as const,
      targetProjectId: IDS.project,
      condition: "turn-finished" as const,
      armedAt: "2026-11-28T10:00:00.000Z",
      expiresAt: "2026-12-05T10:00:00.000Z",
      baselineTurnId: "turn-0",
    },
    missedRunPolicy: "run-once" as const,
    targetPolicy: "same-thread" as const,
    ...overrides,
  };
}

describe("thread-finished automation contracts", () => {
  it("accepts thread-finished triggers with same-thread and new-thread Work/Code routines and refuses unattended Full access", () => {
    const sameThread = decodeAutomationDefinitionDraft(baseDraft());
    expect(sameThread.trigger.kind).toBe("thread-finished");
    expect(sameThread.targetPolicy).toBe("same-thread");
    expect(automationLevelFitsTrigger(sameThread)).toBe(true);

    const newThread = decodeAutomationDefinitionDraft(baseDraft({ targetPolicy: "new-thread" }));
    expect(newThread.targetPolicy).toBe("new-thread");
    expect(automationLevelFitsTrigger(newThread)).toBe(true);

    expect(
      automationLevelFitsTrigger(
        decodeAutomationDefinitionDraft(baseDraft({ projectLevel: "opted-in" })),
      ),
    ).toBe(false);
    expect(
      automationLevelFitsTrigger(
        decodeAutomationDefinitionDraft(baseDraft({ runLevel: "full-access" })),
      ),
    ).toBe(false);
    expect(
      automationLevelFitsTrigger(decodeAutomationDefinitionDraft(baseDraft({ runLevel: "auto" }))),
    ).toBe(false);
    expect(AutomationDefinitionSnapshot).toBeDefined();
  });

  it("refuses a thread-finished trigger whose expiry is not strictly after armedAt", () => {
    expect(() =>
      decodeAutomationThreadFinishedTrigger({
        kind: "thread-finished",
        targetThreadId: IDS.targetThread,
        targetMode: "code",
        targetProjectId: IDS.project,
        condition: "turn-finished",
        armedAt: "2026-11-28T10:00:00.000Z",
        expiresAt: "2026-11-28T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("derives a deterministic occurrence key from automation, revision, target thread, and attested turn", () => {
    const occurrence = decodeAutomationOccurrence({
      kind: "thread-finished",
      automationId: IDS.automation,
      definitionRevision: 2,
      targetThreadId: IDS.targetThread,
      attestedTurnId: "turn-42",
      finishedAt: "2026-11-28T10:05:00.000Z",
      waitId: IDS.wait,
    });
    expect(deriveAutomationOccurrenceKey(occurrence)).toBe(
      `thread-finished:${IDS.automation}:2:${IDS.targetThread}:turn-42`,
    );
  });

  it("frames the follow-up turn prompt with the target thread reference only and parses it back", () => {
    const framed = automationThreadFinishedTurnPrompt("Run the release checks.", IDS.targetThread);
    expect(framed).toBe(
      `Follow-up started after thread ${IDS.targetThread} finished:\n\nRun the release checks.`,
    );
    expect(parseAutomationThreadFinishedTurnPrompt(framed)).toEqual({
      targetThreadId: IDS.targetThread,
      prompt: "Run the release checks.",
    });
    expect(parseAutomationFollowUpTurnPrompt(framed)).toBe("Run the release checks.");
    expect(AUTOMATION_THREAD_FINISHED_READS_FLAG).toBe("thread-finished");
  });

  it("decodes automation-finish-wait-changed events and agent finish-wait proposals strictly", () => {
    const changed = decodeAutomationFinishWaitChanged({
      automationId: IDS.automation,
      definitionRevision: 1,
      previousState: "armed",
      recordedAt: "2026-11-28T10:05:00.000Z",
      wait: {
        waitId: IDS.wait,
        targetThreadId: IDS.targetThread,
        targetMode: "code",
        targetProjectId: IDS.project,
        condition: "done",
        armedAt: "2026-11-28T10:00:00.000Z",
        expiresAt: "2026-12-05T10:00:00.000Z",
        state: "missed",
        updatedAt: "2026-11-28T10:05:00.000Z",
        attestedTurnId: "turn-99",
        finishedAt: "2026-11-27T08:00:00.000Z",
        reason: "More than 24 hours late.",
      },
    });
    expect(changed.wait.state).toBe("missed");

    const proposal = decodeRoutineFinishWaitProposal({
      kind: "routine-finish-wait-proposal",
      proposalId: IDS.proposal,
      threadId: IDS.originThread,
      mode: "code",
      projectId: IDS.project,
      action: "same-thread",
      displayName: "Continue after target finishes",
      taskPrompt: "Check the PR status.",
      targetThreadId: IDS.targetThread,
      targetMode: "code",
      targetProjectId: IDS.project,
      condition: "turn-finished",
      expiresAt: "2026-12-05T10:00:00.000Z",
      requestedAt: "2026-11-28T10:00:00.000Z",
    });
    expect(proposal.action).toBe("same-thread");

    expect(() =>
      decodeRoutineFinishWaitProposal({
        kind: "routine-finish-wait-proposal",
        proposalId: IDS.proposal,
        threadId: IDS.originThread,
        mode: "code",
        projectId: IDS.project,
        action: "run-routine",
        displayName: "Run routine after target finishes",
        taskPrompt: "Should not be present for run-routine.",
        targetThreadId: IDS.targetThread,
        targetMode: "code",
        targetProjectId: IDS.project,
        condition: "done",
        expiresAt: "2026-12-05T10:00:00.000Z",
        requestedAt: "2026-11-28T10:00:00.000Z",
      }),
    ).toThrow();
  });
});
