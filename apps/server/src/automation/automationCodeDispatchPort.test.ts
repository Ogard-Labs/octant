import { describe, expect, it, vi } from "vitest";
import type {
  AutomationDefinition,
  AutomationRun,
  CodeThreadId,
  PermissionMode,
  UtcTimestamp,
  WindowId,
} from "@octant/contracts";
import { createAutomationCodeDispatchPort } from "./automationCodeDispatchPort";
import {
  AUTOMATION_TEST_IDS,
  automationDefinitionFixture,
  automationRunForDefinition,
} from "./automationTestFixtures";

const threadId = "aa000000-0000-4000-8000-0000000000f9" as CodeThreadId;
const scopeId = "automation-host-scope" as WindowId;
const authority = {
  filesystem: true,
  shell: true,
  git: true,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
} as const;

function codeRun(overrides: Partial<AutomationDefinition> = {}): AutomationRun {
  return automationRunForDefinition(
    automationDefinitionFixture({
      mode: "code",
      binding: {
        kind: "code",
        hostId: "local",
        projectId: AUTOMATION_TEST_IDS.project,
        projectVersion: 1,
        bindingRevisionId: AUTOMATION_TEST_IDS.bindingRevision,
        repositoryId: `repo_${"a".repeat(64)}`,
        checkoutId: "aa000000-0000-4000-8000-0000000000d1",
        worktreeReceiptId: "aa000000-0000-4000-8000-0000000000d2",
      },
      executionProfile: {
        profileId: AUTOMATION_TEST_IDS.executionProfile,
        profileVersion: 1,
        hostId: "local",
        mode: "code",
        projectId: AUTOMATION_TEST_IDS.project,
        providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
        modelId: "approved-model",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      },
      authorityProfile: {
        profileId: AUTOMATION_TEST_IDS.authorityProfile,
        profileVersion: 1,
        requested: authority,
        effective: authority,
        effectiveAuthorityDigest: "automation-authority-digest",
      },
      deliveryTarget: {
        revisionId: AUTOMATION_TEST_IDS.deliveryTargetRevision,
        revision: 1,
        mode: "code",
        summary: "A green build report exists on the checkout.",
        confirmed: true,
        confirmedBy: AUTOMATION_TEST_IDS.actor,
        confirmedAt: "2026-08-10T12:00:00.000Z",
      },
      ...overrides,
    } as never),
  );
}

function port(projectLevel: PermissionMode = "full-access") {
  const execute = vi.fn(async (_scope: WindowId, _command: unknown) => ({
    kind: "managed-thread-created",
    thread: { id: threadId },
  }));
  const dispatch = createAutomationCodeDispatchPort({
    codeService: { execute, bootstrap: async () => ({ threads: [] }) },
    operations: { execute: vi.fn() as never },
    evidence: { put: vi.fn() as never },
    clock: () => "2026-08-10T12:00:00.000Z" as UtcTimestamp,
    uuid: () => "aa000000-0000-4000-8000-0000000000fa",
    projectLevel: () => projectLevel,
  });
  return { dispatch, execute };
}

describe("Code routine threads", () => {
  it("creates a routine's thread asking first unless the person opted it into its Project's level", async () => {
    const asked = port();
    await asked.dispatch.createApprovalGatedThread({
      run: codeRun(),
      threadId,
      title: "Nightly build check",
      scopeId,
    });
    expect(asked.execute.mock.calls[0]?.[1]).toMatchObject({
      kind: "create-managed-code-thread",
      executionPolicy: "approval-gated",
    });

    const optedIn = port();
    await optedIn.dispatch.createApprovalGatedThread({
      run: codeRun({ projectLevel: "opted-in" }),
      threadId,
      title: "Nightly build check",
      scopeId,
    });
    expect(optedIn.execute.mock.calls[0]?.[1]).toMatchObject({
      kind: "create-managed-code-thread",
      executionPolicy: "full-access",
    });
  });

  it("caps a follow-up turn at the level picked on the routine", async () => {
    const start = async (runLevel: "ask-first" | "auto-accept-edits" | "full-access") => {
      const operations = {
        execute: vi.fn(async () => ({ kind: "provider-turn-state", state: "running" })),
      };
      const dispatch = createAutomationCodeDispatchPort({
        codeService: {
          execute: vi.fn() as never,
          bootstrap: async () => ({ threads: [{ id: threadId, checkoutId: "checkout-1" }] }),
        },
        operations: operations as never,
        evidence: { put: () => ({ contentId: "c", digest: "d", byteLength: 1 }) as never },
        clock: () => "2026-08-10T12:00:00.000Z" as UtcTimestamp,
        uuid: () => "aa000000-0000-4000-8000-0000000000fa",
        projectLevel: () => "full-access",
      });
      const base = codeRun();
      const run: AutomationRun = {
        ...base,
        definitionSnapshot: { ...base.definitionSnapshot, runLevel, targetPolicy: "same-thread" },
      };
      await dispatch.startOrRecoverFirstTurn({
        run,
        threadId,
        firstTurnRequestId: run.firstTurnRequestId,
        promptDigest: "unused" as never,
        scopeId,
      });
      return (
        operations.execute.mock.calls[0] as unknown as [unknown, { executionPolicy?: string }]
      )[1].executionPolicy;
    };

    expect(await start("ask-first")).toBe("approval-gated");
    expect(await start("auto-accept-edits")).toBe("auto-accept-edits");
    expect(await start("full-access")).toBe("full-access");
  });

  it("creates a run at the level picked on the routine, never above the Project's", async () => {
    const created = async (
      projectLevel: PermissionMode,
      runLevel: "ask-first" | "auto-accept-edits" | "full-access",
    ) => {
      const subject = port(projectLevel);
      await subject.dispatch.createApprovalGatedThread({
        run: codeRun({ runLevel }),
        threadId,
        title: "Nightly build check",
        scopeId,
      });
      return subject.execute.mock.calls[0]?.[1];
    };

    // The Project's new threads start at Full access, so each pick holds.
    expect(await created("full-access", "auto-accept-edits")).toMatchObject({
      executionPolicy: "auto-accept-edits",
    });
    expect(await created("full-access", "full-access")).toMatchObject({
      executionPolicy: "full-access",
    });
    expect(await created("full-access", "ask-first")).toMatchObject({
      executionPolicy: "approval-gated",
      autoApprove: false,
    });
    // A Project that starts at Ask first caps a pick of Full access.
    expect(await created("ask-first", "full-access")).toMatchObject({
      executionPolicy: "approval-gated",
      autoApprove: false,
    });
  });
});
