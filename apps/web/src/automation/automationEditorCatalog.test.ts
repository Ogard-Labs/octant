import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@octant/contracts/agent-profile";
import type { CodeBootstrap, CodeThread } from "@octant/contracts/code";
import type { ProjectSummary } from "@octant/contracts/projects";
import { decodeBindingReceiptId } from "@octant/contracts/projects";
import {
  buildAutomationEditorCatalog,
  durableWorkBindingReceiptId,
  durableCodeWorktreeReceiptId,
  automationAuthorityDigest,
} from "./automationEditorCatalog";
import { AUTOMATION_UI_TEST_IDS } from "./automationTestFixtures";

const now = "2026-08-10T12:00:00.000Z";

function workProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: AUTOMATION_UI_TEST_IDS.project,
    name: "Docs Project",
    type: "work",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: "/Users/example/Docs" },
    bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
    ...overrides,
  } as ProjectSummary;
}

function codeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: AUTOMATION_UI_TEST_IDS.otherProject,
    name: "Repo Project",
    type: "code",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 2,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: "/Users/example/Repo" },
    bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
    codeAccessPersistence: "current-session",
    ...overrides,
  } as ProjectSummary;
}

function approvalGatedProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: AUTOMATION_UI_TEST_IDS.executionProfile as AgentProfile["id"],
    displayName: "Work default",
    approvedSkillIds: [],
    toolConstraints: [],
    modelConstraints: ["approved-model" as never],
    defaultExecutionPolicy: "approval-gated",
    defaultPermissionPersistence: "current-session",
    compatibleModes: ["work"],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as AgentProfile;
}

function managedCodeBootstrap(): CodeBootstrap {
  const thread = {
    id: AUTOMATION_UI_TEST_IDS.thread,
    projectId: AUTOMATION_UI_TEST_IDS.otherProject,
    bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
    repositoryId: AUTOMATION_UI_TEST_IDS.repository,
    checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
    title: "Nightly",
    lifecycle: "active",
    providerInstanceId: AUTOMATION_UI_TEST_IDS.providerInstance,
    modelId: "approved-model",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/x",
      remoteName: "origin",
      proposedBaseRepository: AUTOMATION_UI_TEST_IDS.repository,
      proposedBaseBranch: "development",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as CodeThread;
  return {
    settings: {
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      version: 1,
      updatedAt: now,
    },
    threads: [thread],
    checkouts: [
      {
        id: AUTOMATION_UI_TEST_IDS.checkout as never,
        repositoryId: AUTOMATION_UI_TEST_IDS.repository as never,
        kind: "managed-worktree",
        availability: "available",
        head: { kind: "branch", name: "feature/x", oid: "a".repeat(40) },
        ownershipReceiptId: AUTOMATION_UI_TEST_IDS.worktreeReceipt as never,
        observedAt: now as never,
      },
    ],
    activity: [],
  } as unknown as CodeBootstrap;
}

describe("automationEditorCatalog", () => {
  it("derives a contract-valid durable Work binding receipt from revision facts", () => {
    const receiptId = durableWorkBindingReceiptId(
      AUTOMATION_UI_TEST_IDS.project,
      AUTOMATION_UI_TEST_IDS.bindingRevision,
    );
    expect(decodeBindingReceiptId(receiptId)).toBe(receiptId);
    expect(
      durableWorkBindingReceiptId(
        AUTOMATION_UI_TEST_IDS.project,
        AUTOMATION_UI_TEST_IDS.bindingRevision,
      ),
    ).toBe(receiptId);
    expect(
      durableWorkBindingReceiptId(
        AUTOMATION_UI_TEST_IDS.otherProject,
        AUTOMATION_UI_TEST_IDS.bindingRevision,
      ),
    ).not.toBe(receiptId);
  });

  it("hashes authority digests stably for the same authority snapshot", () => {
    const authority = {
      filesystem: true,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated" as const,
      permissionPersistence: "current-session" as const,
    };
    const digest = automationAuthorityDigest(authority);
    expect(digest).toHaveLength(64);
    expect(automationAuthorityDigest(authority)).toBe(digest);
  });

  it("includes active Work Projects that have a binding revision", () => {
    const catalog = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [
        workProject(),
        workProject({
          id: AUTOMATION_UI_TEST_IDS.otherProject as never,
          lifecycle: "archived",
          name: "Archived",
        }),
        {
          id: AUTOMATION_UI_TEST_IDS.otherProject,
          name: "Chat",
          type: "chat",
          lifecycle: "active",
          pinned: false,
          rank: "0/1",
          version: 1,
          createdAt: now,
          updatedAt: now,
        } as ProjectSummary,
      ],
      profiles: [],
      providerChoicesByMode: { work: [], code: [] },
    });

    expect(catalog.projects).toHaveLength(1);
    expect(catalog.projects[0]).toMatchObject({
      projectId: AUTOMATION_UI_TEST_IDS.project,
      name: "Docs Project",
      mode: "work",
      projectVersion: 1,
      binding: {
        kind: "work",
        hostId: "local",
        projectId: AUTOMATION_UI_TEST_IDS.project,
        projectVersion: 1,
        bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
      },
    });
    expect(
      catalog.projects[0]!.binding.kind === "work" && catalog.projects[0]!.binding.bindingReceiptId,
    ).toBeTruthy();
  });

  it("derives a durable Code worktree receipt from Project + checkout facts", () => {
    const receiptId = durableCodeWorktreeReceiptId({
      projectId: AUTOMATION_UI_TEST_IDS.otherProject,
      bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
      repositoryId: AUTOMATION_UI_TEST_IDS.repository,
      checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
    });
    expect(receiptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(
      durableCodeWorktreeReceiptId({
        projectId: AUTOMATION_UI_TEST_IDS.otherProject,
        bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
        repositoryId: AUTOMATION_UI_TEST_IDS.repository,
        checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
      }),
    ).toBe(receiptId);
    expect(
      durableCodeWorktreeReceiptId({
        projectId: AUTOMATION_UI_TEST_IDS.project,
        bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
        repositoryId: AUTOMATION_UI_TEST_IDS.repository,
        checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
      }),
    ).not.toBe(receiptId);
  });

  it("includes Code Projects with complete managed-checkout facts using durable receipt", () => {
    const withCheckout = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [codeProject()],
      profiles: [],
      providerChoicesByMode: { work: [], code: [] },
      codeBootstrap: managedCodeBootstrap(),
    });
    expect(withCheckout.projects).toHaveLength(1);
    expect(withCheckout.projects[0]?.binding).toMatchObject({
      kind: "code",
      hostId: "local",
      projectId: AUTOMATION_UI_TEST_IDS.otherProject,
      projectVersion: 2,
      bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
      repositoryId: AUTOMATION_UI_TEST_IDS.repository,
      checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
    });
    expect(
      withCheckout.projects[0]!.binding.kind === "code" &&
        withCheckout.projects[0]!.binding.worktreeReceiptId,
    ).toBe(
      durableCodeWorktreeReceiptId({
        projectId: AUTOMATION_UI_TEST_IDS.otherProject,
        bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
        repositoryId: AUTOMATION_UI_TEST_IDS.repository,
        checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
      }),
    );
    // Prefer binding-revision-backed durable receipt over the ephemeral ownership id.
    expect(
      withCheckout.projects[0]!.binding.kind === "code" &&
        withCheckout.projects[0]!.binding.worktreeReceiptId,
    ).not.toBe(AUTOMATION_UI_TEST_IDS.worktreeReceipt);

    const withoutCheckout = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [codeProject()],
      profiles: [],
      providerChoicesByMode: { work: [], code: [] },
    });
    expect(withoutCheckout.projects).toHaveLength(0);
  });

  it("includes Code Projects from prepared checkout facts without inventing incomplete ones", () => {
    const preparedExisting = {
      projectId: AUTOMATION_UI_TEST_IDS.otherProject as never,
      bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision as never,
      checkout: {
        id: AUTOMATION_UI_TEST_IDS.checkout as never,
        repositoryId: AUTOMATION_UI_TEST_IDS.repository as never,
        kind: "existing-worktree" as const,
        availability: "available" as const,
        head: { kind: "branch" as const, name: "development" as never, oid: "b".repeat(40) },
        observedAt: now as never,
      },
    } as const;

    const withPrepared = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [codeProject()],
      profiles: [],
      providerChoicesByMode: { work: [], code: [] },
      preparedCodeCheckouts: [preparedExisting as never],
    });
    expect(withPrepared.projects).toHaveLength(1);
    expect(withPrepared.projects[0]?.binding).toMatchObject({
      kind: "code",
      bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
      repositoryId: AUTOMATION_UI_TEST_IDS.repository,
      checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
      worktreeReceiptId: durableCodeWorktreeReceiptId({
        projectId: AUTOMATION_UI_TEST_IDS.otherProject,
        bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
        repositoryId: AUTOMATION_UI_TEST_IDS.repository,
        checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
      }),
    });

    const incompletePrepared = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [codeProject()],
      profiles: [],
      providerChoicesByMode: { work: [], code: [] },
      preparedCodeCheckouts: [
        {
          ...preparedExisting,
          checkout: {
            ...preparedExisting.checkout,
            availability: "unavailable",
          },
        } as never,
      ],
    });
    expect(incompletePrepared.projects).toHaveLength(0);

    const revisionMismatch = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [codeProject()],
      profiles: [],
      providerChoicesByMode: { work: [], code: [] },
      preparedCodeCheckouts: [
        {
          ...preparedExisting,
          bindingRevisionId: "bb000000-0000-4000-8000-000000000099" as never,
        } as never,
      ],
    });
    expect(revisionMismatch.projects).toHaveLength(0);
  });

  it("omits Code Projects whose managed checkout lacks an ownership receipt", () => {
    const bootstrap = managedCodeBootstrap();
    const catalog = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [codeProject()],
      profiles: [],
      providerChoicesByMode: { work: [], code: [] },
      codeBootstrap: {
        ...bootstrap,
        checkouts: [
          {
            id: AUTOMATION_UI_TEST_IDS.checkout as never,
            repositoryId: AUTOMATION_UI_TEST_IDS.repository as never,
            kind: "existing-worktree",
            availability: "available",
            head: { kind: "branch", name: "feature/x" as never, oid: "a".repeat(40) },
            observedAt: now as never,
          },
        ],
        activity: [],
      } as unknown as CodeBootstrap,
    });
    expect(catalog.projects).toHaveLength(0);
  });

  it("maps approval-gated profiles into execution and authority receipts and excludes full-access", () => {
    const catalog = buildAutomationEditorCatalog({
      hostId: "local",
      hostLabel: "This Mac",
      actorId: AUTOMATION_UI_TEST_IDS.actor,
      projects: [workProject()],
      profiles: [
        approvalGatedProfile(),
        approvalGatedProfile({
          id: AUTOMATION_UI_TEST_IDS.codeExecutionProfile as never,
          displayName: "Full access",
          defaultExecutionPolicy: "full-access",
          compatibleModes: ["work", "code"],
        }),
      ],
      providerChoicesByMode: {
        work: [
          {
            providerInstanceId: AUTOMATION_UI_TEST_IDS.providerInstance,
            modelId: "approved-model",
          },
        ],
        code: [],
      },
    });

    expect(catalog.executionProfiles).toHaveLength(1);
    expect(catalog.executionProfiles[0]).toMatchObject({
      label: "Work default",
      receipt: {
        profileId: AUTOMATION_UI_TEST_IDS.executionProfile,
        hostId: "local",
        mode: "work",
        projectId: AUTOMATION_UI_TEST_IDS.project,
        providerInstanceId: AUTOMATION_UI_TEST_IDS.providerInstance,
        modelId: "approved-model",
        executionPolicy: "approval-gated",
      },
    });
    expect(catalog.authorityProfiles).toHaveLength(1);
    expect(catalog.authorityProfiles[0]?.receipt.effective.executionPolicy).toBe("approval-gated");
    expect(catalog.authorityProfiles[0]?.receipt.effective.shell).toBe(false);
    expect(catalog.authorityProfiles[0]?.receipt.effective.git).toBe(false);
    expect(catalog.authorityProfiles[0]?.receipt.effectiveAuthorityDigest).toHaveLength(64);
  });
});
