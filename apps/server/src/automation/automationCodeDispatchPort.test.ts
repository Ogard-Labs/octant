import { describe, expect, it, vi } from "vitest";
import type {
  AutomationDefinition,
  AutomationRun,
  CodeThreadId,
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

function port() {
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
    projectLevel: () => "full-access",
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
});
