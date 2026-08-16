import { describe, expect, it } from "vitest";
import {
  automationAuthoritySummary,
  automationBlockReasonLabel,
  automationLifecycleLabel,
  automationNextRunLabel,
  automationRunStatusLabel,
  automationRunThreadTarget,
  automationTriggerSummary,
  buildAutomationDraft,
  type AutomationDraftFormInput,
} from "./automationCenterModel";
import {
  AUTOMATION_UI_TEST_DUE,
  AUTOMATION_UI_TEST_IDS,
  AUTOMATION_UI_TEST_NOW,
  automationDefinitionFixture,
  automationRunFixture,
} from "./automationTestFixtures";

const definition = automationDefinitionFixture();

function validFormInput(): AutomationDraftFormInput {
  return {
    displayName: "Weekly summary",
    taskPrompt: "Summarize the Project's open work.",
    hostId: "local",
    mode: "work",
    project: {
      projectId: definition.projectId,
      name: "Docs Project",
      mode: "work",
      projectVersion: definition.projectVersion,
      binding: definition.binding,
    },
    executionProfile: definition.executionProfile,
    authorityProfile: definition.authorityProfile,
    trigger: { kind: "once", scheduledAt: AUTOMATION_UI_TEST_DUE },
    missedRunPolicy: "skip",
    deliveryTargetSummary: "A confirmed weekly summary document exists in the Project.",
    deliveryTargetConfirmed: true,
    actorId: AUTOMATION_UI_TEST_IDS.actor,
    now: AUTOMATION_UI_TEST_NOW,
    generateId: () => AUTOMATION_UI_TEST_IDS.deliveryTargetRevision,
  };
}

describe("automationCenterModel labels", () => {
  it("names every definition lifecycle in plain text", () => {
    expect(automationLifecycleLabel("enabled")).toBe("Enabled");
    expect(automationLifecycleLabel("paused")).toBe("Paused");
    expect(automationLifecycleLabel("exhausted")).toBe("Completed schedule");
    expect(automationLifecycleLabel("archived")).toBe("Archived");
  });

  it("names every run lifecycle in plain text", () => {
    expect(automationRunStatusLabel("queued")).toBe("Queued");
    expect(automationRunStatusLabel("dispatching")).toBe("Dispatching");
    expect(automationRunStatusLabel("recovering-dispatch")).toBe("Recovering");
    expect(automationRunStatusLabel("running")).toBe("Running");
    expect(automationRunStatusLabel("waiting")).toBe("Waiting for you");
    expect(automationRunStatusLabel("completed")).toBe("Completed");
    expect(automationRunStatusLabel("failed")).toBe("Failed");
    expect(automationRunStatusLabel("cancelled")).toBe("Cancelled");
    expect(automationRunStatusLabel("interrupted")).toBe("Interrupted");
    expect(automationRunStatusLabel("skipped")).toBe("Skipped");
  });

  it("formats next run instants and names the unscheduled state", () => {
    expect(automationNextRunLabel(null)).toBe("Not scheduled");
    expect(automationNextRunLabel(AUTOMATION_UI_TEST_DUE, { timeZone: "UTC" })).toBe(
      "Sep 1, 2026, 09:00",
    );
  });

  it("summarizes each trigger kind including timezone facts", () => {
    expect(
      automationTriggerSummary({ kind: "once", scheduledAt: AUTOMATION_UI_TEST_DUE } as never, {
        timeZone: "UTC",
      }),
    ).toBe("Once at Sep 1, 2026, 09:00");
    expect(
      automationTriggerSummary(
        { kind: "interval", anchorAt: AUTOMATION_UI_TEST_DUE, intervalMinutes: 120 } as never,
        { timeZone: "UTC" },
      ),
    ).toBe("Every 2 hours from Sep 1, 2026, 09:00");
    expect(
      automationTriggerSummary(
        {
          kind: "weekly-local",
          weekdays: [1, 3],
          localTime: "09:30",
          timeZone: "Europe/Oslo",
        } as never,
        { timeZone: "UTC" },
      ),
    ).toBe("Weekly on Mon, Wed at 09:30 (Europe/Oslo)");
  });

  it("names typed block reasons as recoverable plain text", () => {
    expect(automationBlockReasonLabel("missed-run-cap-exceeded")).toBe(
      "Paused automatically: too many missed runs. Resume after reviewing the schedule.",
    );
    expect(automationBlockReasonLabel("authority-mismatch")).toBe(
      "The authority profile no longer matches. Edit and resume to revalidate.",
    );
    expect(automationBlockReasonLabel("automation-recursion")).toBe(
      "Automation-created work cannot manage automations.",
    );
  });

  it("summarizes effective authority as named text without secrets", () => {
    const summary = automationAuthoritySummary(definition.authorityProfile);
    expect(summary).toBe("Approval-gated · filesystem, tools · this session only");
    expect(summary).not.toContain("digest");
  });
});

describe("automationRunThreadTarget", () => {
  it("returns the ordinary-thread target only after the thread exists", () => {
    const waiting = automationRunFixture(definition, { lifecycle: "waiting" });
    expect(automationRunThreadTarget(waiting)).toEqual({
      mode: "work",
      threadId: AUTOMATION_UI_TEST_IDS.thread,
    });
    const completed = automationRunFixture(definition, { lifecycle: "completed" });
    expect(automationRunThreadTarget(completed)).toEqual({
      mode: "work",
      threadId: AUTOMATION_UI_TEST_IDS.thread,
    });
  });

  it("returns no target for a pre-thread run so failures stay on the Automation run", () => {
    const failed = automationRunFixture(definition, { lifecycle: "failed" });
    expect(automationRunThreadTarget(failed)).toBeUndefined();
    const queued = automationRunFixture(definition, { lifecycle: "queued" });
    expect(automationRunThreadTarget(queued)).toBeUndefined();
  });
});

describe("buildAutomationDraft", () => {
  it("builds a strict contract-valid draft with a freshly confirmed delivery target", () => {
    const result = buildAutomationDraft(validFormInput());
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.draft.displayName).toBe("Weekly summary");
    expect(result.draft.deliveryTarget.confirmed).toBe(true);
    expect(result.draft.deliveryTarget.confirmedBy).toBe(AUTOMATION_UI_TEST_IDS.actor);
    expect(result.draft.deliveryTarget.confirmedAt).toBe(AUTOMATION_UI_TEST_NOW);
    expect(result.draft.deliveryTarget.revision).toBe(1);
    expect(result.draft.trigger).toEqual({ kind: "once", scheduledAt: AUTOMATION_UI_TEST_DUE });
    expect(result.draft.targetPolicy).toBe("new-thread");
  });

  it("increments the delivery-target revision when editing", () => {
    const result = buildAutomationDraft({
      ...validFormInput(),
      previousDeliveryTargetRevision: 3,
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.draft.deliveryTarget.revision).toBe(4);
  });

  it("refuses to build without an explicit delivery-target confirmation", () => {
    const result = buildAutomationDraft({ ...validFormInput(), deliveryTargetConfirmed: false });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues).toContain("Confirm the delivery target before saving.");
  });

  it("requires name, prompt, Project, and both profiles", () => {
    const result = buildAutomationDraft({
      ...validFormInput(),
      displayName: "  ",
      taskPrompt: "",
      project: undefined,
      executionProfile: undefined,
      authorityProfile: undefined,
    });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues).toContain("Name the automation.");
    expect(result.issues).toContain("Describe the task for each run.");
    expect(result.issues).toContain("Choose the exact Project.");
    expect(result.issues).toContain("Choose an execution profile.");
    expect(result.issues).toContain("Choose an authority profile.");
  });

  it("rejects a full-access authority profile instead of downgrading it", () => {
    const fullAccess = {
      ...definition.authorityProfile,
      requested: { ...definition.authorityProfile.requested, executionPolicy: "full-access" },
      effective: { ...definition.authorityProfile.effective, executionPolicy: "full-access" },
    };
    const result = buildAutomationDraft({
      ...validFormInput(),
      authorityProfile: fullAccess as never,
    });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues).toContain(
      "Full access profiles are not eligible for automations. Choose an approval-gated profile.",
    );
  });

  it("rejects trigger values the contract would refuse", () => {
    const result = buildAutomationDraft({
      ...validFormInput(),
      trigger: { kind: "interval", anchorAt: AUTOMATION_UI_TEST_DUE, intervalMinutes: 5 },
    });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues).toContain("Repeat intervals run from 15 minutes to 30 days.");
  });

  it("rejects a weekly trigger without weekdays or with an unknown timezone", () => {
    const noDays = buildAutomationDraft({
      ...validFormInput(),
      trigger: { kind: "weekly-local", weekdays: [], localTime: "09:30", timeZone: "Europe/Oslo" },
    });
    expect(noDays.kind).toBe("invalid");
    if (noDays.kind !== "invalid") return;
    expect(noDays.issues).toContain("Choose at least one weekday.");

    const badZone = buildAutomationDraft({
      ...validFormInput(),
      trigger: {
        kind: "weekly-local",
        weekdays: [1],
        localTime: "09:30",
        timeZone: "Not/AZone",
      },
    });
    expect(badZone.kind).toBe("invalid");
    if (badZone.kind !== "invalid") return;
    expect(badZone.issues).toContain("Choose a valid IANA timezone.");
  });

  it("surfaces a mode mismatch between Project and profiles as a named issue", () => {
    const input = validFormInput();
    const result = buildAutomationDraft({
      ...input,
      executionProfile: { ...input.executionProfile!, mode: "code" } as never,
    });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues).toContain(
      "The selection does not satisfy the automation contract. Match host, mode, and Project across every choice.",
    );
  });
});
