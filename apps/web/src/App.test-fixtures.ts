import {
  decodeWorkThreadId,
  decodeProjectId,
  decodeWorkspaceOperation,
  decodeWindowId,
  decodeWorkspaceLayoutNode,
  type ShellBootstrap,
  type ShellCommand,
  type CodeEnvironmentObservation,
  type ProjectBootstrap,
  type ProjectCommand,
  type ProjectCommandResult,
  type ProjectId,
  type ProviderInstance,
  type ProviderModel,
  type ProviderObservedState,
  type UtcTimestamp,
  type WorkspaceLayoutNode,
} from "@octant/contracts";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { ContextClient } from "@octant/client-runtime/context-client";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import {
  applyWorkspaceOperation,
  buildSurfaceCatalog,
  defaultEnvironmentPresentationState,
  defaultShellSettings,
  defaultWindowWorkspace,
  reconcileWorkspaceWithSettings,
} from "@octant/domain/shell-policy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { contextFixture } from "./context/contextFixtures";
import { type SplitWorkspaceProps } from "./shell/SplitWorkspace";
import {
  decodeChatBootstrap,
  decodeChatCommandResult,
  decodeChatThread,
  decodeChatThreadId,
  decodeChatThreadView,
  type ChatThread,
} from "@octant/contracts/chat";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodeComputerUseSessionView } from "@octant/contracts/computer-use";

/**
 * Shell settings for a host that has already resolved first run. These suites
 * exercise the workspace, and the first-run surface is a modal that correctly
 * hides the workspace from assistive technology while it is open.
 */
export function settingsPastFirstRun(): ReturnType<typeof defaultShellSettings> {
  return { ...defaultShellSettings(), firstRunOnboarding: "completed" as const };
}

export const windowId = decodeWindowId("00000000-0000-4000-8000-000000000601");
export const projectWindowCapability = "C".repeat(43);
export const bindingReceipt = `${"R".repeat(42)}A`;
export const projectId = decodeProjectId("00000000-0000-4000-8000-000000000801");
export const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000802");
export const oldChatThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000803");
export const createdChatThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000804");
export const archivedChatThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000805");
export const codeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000805");
export const workProjectId = decodeProjectId("00000000-0000-4000-8000-000000000806");
export const workThreadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000807");
export const styles = [
  readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(
    '@import "./styles/shell.css";',
    "",
  ),
  readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/styles/dock.css"), "utf8"),
].join("\n");

export const readyEnvironment: Extract<CodeEnvironmentObservation, { status: "ready" }> = {
  status: "ready",
  projectId,
  projectName: "Octant",
  observedAt: "2026-07-16T09:00:00.000Z" as CodeEnvironmentObservation["observedAt"],
  repositoryRoot: "/Users/example/Dev/Repos/octant",
  worktreeRoot: "/Users/example/Dev/Repos/octant/.agent-worktrees/issue-52-distilled-shell",
  branch: { kind: "named", name: "feature/issue-52-distilled-shell" },
  changes: "dirty",
};

export function credentialHostOperations() {
  return {
    clearProviderCredential: vi.fn(),
    providerCredentialStatus: vi.fn(async () => "missing" as const),
    setProviderCredential: vi.fn(),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

export function projectBootstrap(): ProjectBootstrap {
  return {
    active: [
      {
        id: projectId,
        type: "code",
        name: "Octant",
        lifecycle: "active",
        pinned: true,
        rank: "0/1" as ProjectBootstrap["active"][number]["rank"],
        version: 1 as ProjectBootstrap["active"][number]["version"],
        createdAt: "2026-07-14T08:00:00.000Z" as ProjectBootstrap["active"][number]["createdAt"],
        updatedAt: "2026-07-14T08:00:00.000Z" as ProjectBootstrap["active"][number]["updatedAt"],
        binding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
        bindingRevisionId: "30000000-0000-4000-8000-000000000099" as never,
        codeAccessPersistence: "current-session",
      },
    ],
    archived: [],
    availability: [
      {
        projectId,
        status: "unavailable",
        reason: "Repository moved.",
        observedAt:
          "2026-07-14T09:00:00.000Z" as ProjectBootstrap["availability"][number]["observedAt"],
      },
    ],
    memory: [],
  };
}

export function projects(value = projectBootstrap()): ProjectClient {
  return {
    bootstrap: vi.fn(async () => value),
    search: vi.fn(async () => value.active),
    executeProject: vi.fn(async (command: ProjectCommand): Promise<ProjectCommandResult> => {
      if (command.kind === "relink-project") {
        return {
          kind: "project-relinked",
          project: {
            ...value.active[0]!,
            bindingHistory: [
              {
                revisionId: "00000000-0000-4000-8000-000000000811" as never,
                revision: 1,
                currentBinding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
                actor: {
                  kind: "local-user",
                  actorId: "00000000-0000-4000-8000-000000000812" as never,
                },
                changedAt: "2026-07-14T09:00:00.000Z" as never,
              },
            ],
          } as never,
        };
      }
      throw new Error(`Unhandled ${command.kind}`);
    }),
    memory: vi.fn(),
    environment: vi.fn(async () => {
      throw new Error("Unexpected environment request.");
    }),
    environmentForThread: vi.fn(async () => {
      throw new Error("Unexpected thread environment request.");
    }),
    executeMemory: vi.fn(),
  };
}

export function bootstrap(): ShellBootstrap {
  return {
    settings: settingsPastFirstRun(),
    workspace: defaultWindowWorkspace(windowId),
    availableSurfaces: buildSurfaceCatalog(defaultWindowWorkspace(windowId).contextByMode),
    connectionStatus: "connected",
    settingsVersion: 0 as ShellBootstrap["settingsVersion"],
    workspaceVersion: 0 as ShellBootstrap["workspaceVersion"],
    environmentPresentation: defaultEnvironmentPresentationState(),
    presentationVersion: 0 as ShellBootstrap["presentationVersion"],
  };
}

export function chatShellBootstrap(): ShellBootstrap {
  const value = bootstrap();
  return {
    ...value,
    workspace: applyWorkspaceOperation(value.workspace, { kind: "set-active-mode", mode: "chat" }),
  };
}

export function splitChatShellBootstrap(): ShellBootstrap {
  const value = chatShellBootstrap();
  const chatLayout = value.workspace.layouts.chat;
  if (chatLayout.kind !== "group") throw new Error("Expected the default Chat group.");
  const withOlderChat = applyWorkspaceOperation(
    value.workspace,
    decodeWorkspaceOperation({
      kind: "open-tab",
      mode: "chat",
      groupId: chatLayout.groupId,
      tab: {
        kind: "chat-thread",
        id: "00000000-0000-4000-8000-000000000831",
        threadId: oldChatThreadId,
        mode: "chat",
        title: "Older chat",
      },
    }),
  );
  const withBothChats = applyWorkspaceOperation(
    withOlderChat,
    decodeWorkspaceOperation({
      kind: "open-tab",
      mode: "chat",
      groupId: chatLayout.groupId,
      tab: {
        kind: "chat-thread",
        id: "00000000-0000-4000-8000-000000000832",
        threadId: createdChatThreadId,
        mode: "chat",
        title: "Exact created chat",
      },
    }),
  );
  return {
    ...value,
    workspace: applyWorkspaceOperation(
      withBothChats,
      decodeWorkspaceOperation({
        kind: "split-group",
        mode: "chat",
        groupId: chatLayout.groupId,
        tabId: "00000000-0000-4000-8000-000000000832",
        splitNodeId: "00000000-0000-4000-8000-000000000833",
        newGroupNodeId: "00000000-0000-4000-8000-000000000834",
        newGroupId: "00000000-0000-4000-8000-000000000835",
        orientation: "horizontal",
        placement: "after",
        ratio: 0.5,
      }),
    ),
  };
}

export function codeShellBootstrap(): ShellBootstrap {
  const value = bootstrap();
  const activeCodeWorkspace = applyWorkspaceOperation(value.workspace, {
    kind: "set-active-mode",
    mode: "code",
  });
  const layout = activeCodeWorkspace.layouts.code;
  if (layout.kind !== "group") throw new Error("Expected the default Code group.");
  return {
    ...value,
    workspace: applyWorkspaceOperation(
      activeCodeWorkspace,
      decodeWorkspaceOperation({
        kind: "open-tab",
        mode: "code",
        groupId: layout.groupId,
        tab: {
          kind: "code-overview",
          id: "00000000-0000-4000-8000-000000000806",
          threadId: codeThreadId,
          mode: "code",
          title: "Controller foundation",
        },
      }),
    ),
  };
}

export function chats(options: { readonly threadProjectId?: string } = {}): ChatClient {
  const now = "2026-07-20T08:00:00.000Z";
  const providerInstanceId = "10000000-0000-4000-8000-000000000001";
  const oldThread = {
    id: oldChatThreadId,
    title: "Older chat",
    ...(options.threadProjectId === undefined ? {} : { projectId: options.threadProjectId }),
    lifecycle: "active" as const,
    providerInstanceId,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic" as const,
    personalityInstructions: "Be calm.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const createdThread = { ...oldThread, id: createdChatThreadId, title: "Exact created chat" };
  let created = false;
  return {
    bootstrap: vi.fn(async () =>
      decodeChatBootstrap({
        settings: {
          defaultProviderInstanceId: providerInstanceId,
          defaultModelId: "model-a",
          defaultResearchEnabled: false,
          defaultResearchRouting: "automatic",
          defaultPersonalityInstructions: "Be calm.",
          version: 1,
          updatedAt: now,
        },
        threads: created ? [createdThread, oldThread] : [oldThread],
      }),
    ),
    execute: vi.fn(async () => {
      created = true;
      return decodeChatCommandResult({ kind: "thread-created", thread: createdThread });
    }),
    search: vi.fn(async () => []),
    subscribe: vi.fn(async function* () {}),
    thread: vi.fn(async (threadId) =>
      decodeChatThreadView({
        thread: String(threadId) === String(createdChatThreadId) ? createdThread : oldThread,
        turns: [],
        lastSequence: 0,
        contents: [],
        attachments: [],
        citations: [],
        workItems: [],
        workListVersion: 0,
        followUpVersion: 0,
      }),
    ),
    upload: vi.fn(),
    discard: vi.fn(),
  };
}

/** One archived Chat thread, as only the host's thread search can report it. */
export function archivedChatThread(): ChatThread {
  const now = "2026-07-20T08:00:00.000Z";
  return decodeChatThread({
    id: archivedChatThreadId,
    title: "Retired chat",
    lifecycle: "archived",
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

export function codes(): CodeClient {
  const now = "2026-07-21T12:00:00.000Z";
  const checkout = {
    id: "40000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "development", oid: "a".repeat(40) },
    observedAt: now,
  } as const;
  const thread = {
    id: codeThreadId,
    projectId,
    bindingRevisionId: "30000000-0000-4000-8000-000000000001",
    repositoryId: checkout.repositoryId,
    checkoutId: checkout.id,
    title: "Controller foundation",
    lifecycle: "active",
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/controller",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as const;
  return {
    bootstrap: vi.fn(
      async () =>
        ({
          checkouts: [checkout],
          activity: [],
          settings: {
            defaultExecutionPolicy: "approval-gated",
            defaultPermissionPersistence: "current-session",
            version: 1,
            updatedAt: now,
          },
          threads: [thread],
        }) as never,
    ),
    queryBoard: vi.fn(
      async () => ({ version: 1, query: { version: 1 }, cards: [], generatedAt: now }) as never,
    ),
    conversation: vi.fn(async (threadId) => ({
      version: 3 as const,
      threadId,
      turns: [],
      nextCursor: 0,
      hasMore: false,
    })),
    content: vi.fn(),
    operationContent: vi.fn(),
    execute: vi.fn(),
    executeOperation: vi.fn(),
    inspectTerminal: vi.fn(),
    putAttachment: vi.fn(),
    discardAttachment: vi.fn(),
    attachment: vi.fn(),
    putEvidence: vi.fn(),
    save: vi.fn(),
    openFile: vi.fn(),
    subscribe: vi.fn(async function* () {}),
    subscribeOperation: vi.fn(),
    thread: vi.fn(async () => ({ checkout, lastSequence: 0, thread }) as never),
    readFollowUp: vi.fn(async (threadId) => ({ threadId, followUpVersion: 0 }) as never),
    executeFollowUp: vi.fn(),
  };
}

export function client(value: ShellBootstrap = codeShellBootstrap()) {
  let state = value;
  return {
    bootstrap: vi.fn(async () => state),
    execute: vi.fn(async (command: ShellCommand) => {
      if (command.kind === "replace-settings") {
        state = {
          ...state,
          settings: command.settings,
          settingsVersion: (state.settingsVersion + 1) as ShellBootstrap["settingsVersion"],
        };
        return {
          kind: "settings-replaced" as const,
          settings: state.settings,
          version: state.settingsVersion,
        };
      }
      if (command.kind === "set-environment-presentation") {
        state = {
          ...state,
          environmentPresentation: command.presentation,
          presentationVersion: (state.presentationVersion +
            1) as ShellBootstrap["presentationVersion"],
        };
        return {
          kind: "environment-presentation-replaced" as const,
          presentation: state.environmentPresentation,
          version: state.presentationVersion,
        };
      }
      const workspace = applyWorkspaceOperation(
        reconcileWorkspaceWithSettings(state.workspace, state.settings),
        command.operation,
      );
      state = {
        ...state,
        workspace,
        workspaceVersion: (state.workspaceVersion + 1) as ShellBootstrap["workspaceVersion"],
      };
      return { kind: "workspace-replaced" as const, workspace, version: state.workspaceVersion };
    }),
  };
}

export function providers(): ProviderClient {
  return {
    bootstrap: vi.fn(async () => ({
      instances: [],
      defaults: { permissionPersistence: "current-session" as const, version: 0 as never },
      observedStates: [],
    })),
    execute: vi.fn(),
    probe: vi.fn(),
  };
}

export function providersWithToolModel(): ProviderClient {
  const instance = openAiProvider("90000000-0000-4000-8000-000000000001", "OpenAI Compatible");
  const readyModel = providerModel({
    id: "gpt-5",
    displayName: "GPT-5",
    toolCalling: "supported",
    evidence: "supported",
  });
  return {
    bootstrap: vi.fn(async () => ({
      instances: [instance],
      defaults: { permissionPersistence: "current-session" as const, version: 0 as never },
      observedStates: [observedProvider(instance.id, [readyModel])],
    })),
    execute: vi.fn(),
    probe: vi.fn(),
  };
}

/**
 * A ready provider whose only model is chat-only. The Code picker lists it with
 * an unavailableReason, so no Code flow may offer or silently select it.
 */
export function providersWithChatOnlyModel(): ProviderClient {
  const instance = openAiProvider("90000000-0000-4000-8000-000000000001", "OpenAI Compatible");
  const chatOnlyModel = providerModel({
    id: "chat-only",
    displayName: "Chat Only",
    toolCalling: "unsupported",
    evidence: "unsupported",
  });
  return {
    bootstrap: vi.fn(async () => ({
      instances: [instance],
      defaults: { permissionPersistence: "current-session" as const, version: 0 as never },
      observedStates: [observedProvider(instance.id, [chatOnlyModel])],
    })),
    execute: vi.fn(),
    probe: vi.fn(),
  };
}

export function computerUseClientWithSession(): ComputerUseClient {
  const session = decodeComputerUseSessionView({
    sessionId: "10000000-0000-4000-8000-000000000001",
    threadId: String(codeThreadId),
    requestedBy: {
      kind: "local-user",
      actorId: "30000000-0000-4000-8000-000000000001",
    },
    authority: {
      hostId: "40000000-0000-4000-8000-000000000001",
      mode: "code",
      projectId: String(projectId),
      providerInstanceId: "60000000-0000-4000-8000-000000000001",
      extension: { kind: "core" },
    },
    state: "waiting-for-approval",
    sequence: 1,
    pendingApproval: {
      approvalId: "70000000-0000-4000-8000-000000000001",
      actionId: "80000000-0000-4000-8000-000000000001",
      expiresAt: "2026-07-27T21:01:00.000Z",
      summary: "click in Preview",
    },
    events: [
      {
        sequence: 1,
        kind: "approval-requested",
        occurredAt: "2026-07-27T21:00:00.000Z",
        detail: "One-time approval is required.",
      },
    ],
  });
  return {
    list: vi.fn(async () => [session]),
    inspect: vi.fn(async () => session),
    decide: vi.fn(async () => session),
    stop: vi.fn(async () => session),
  };
}

export function workProjects(
  overrides: Partial<ProjectBootstrap> = {},
  availabilityStatus: "available" | "unavailable" = "available",
): ProjectClient {
  return projects({
    active: [
      {
        id: workProjectId,
        type: "work",
        name: "Strategy Docs",
        lifecycle: "active",
        pinned: true,
        rank: "0/1" as ProjectBootstrap["active"][number]["rank"],
        version: 1 as ProjectBootstrap["active"][number]["version"],
        createdAt: "2026-07-26T09:00:00.000Z" as ProjectBootstrap["active"][number]["createdAt"],
        updatedAt: "2026-07-26T09:00:00.000Z" as ProjectBootstrap["active"][number]["updatedAt"],
        binding: { canonicalRoot: "/Users/example/Documents/strategy-docs" },
        bindingRevisionId: "30000000-0000-4000-8000-000000000001" as never,
      } as ProjectBootstrap["active"][number],
    ],
    archived: [],
    availability: [
      {
        projectId: workProjectId,
        status: availabilityStatus,
        ...(availabilityStatus === "available" ? {} : { reason: "Folder moved." }),
        observedAt:
          "2026-07-26T09:05:00.000Z" as ProjectBootstrap["availability"][number]["observedAt"],
      } as ProjectBootstrap["availability"][number],
    ],
    memory: [],
    ...overrides,
  });
}

export function workShellBootstrap(): ShellBootstrap {
  const value = bootstrap();
  const activeWorkModeWorkspace = applyWorkspaceOperation(value.workspace, {
    kind: "set-active-mode",
    mode: "work",
  });
  const layout = activeWorkModeWorkspace.layouts.work;
  if (layout.kind !== "group") throw new Error("Expected the default Work group.");
  const boundWorkspace = {
    ...activeWorkModeWorkspace,
    contextByMode: {
      ...activeWorkModeWorkspace.contextByMode,
      work: {
        ...activeWorkModeWorkspace.contextByMode.work,
        projectId: workProjectId,
        boundRoot: "/Users/example/Documents/strategy-docs",
      },
    },
  };
  return {
    ...value,
    workspace: applyWorkspaceOperation(
      boundWorkspace,
      decodeWorkspaceOperation({
        kind: "open-tab",
        mode: "work",
        groupId: layout.groupId,
        tab: {
          kind: "project",
          id: "00000000-0000-4000-8000-000000000808",
          projectId: workProjectId,
          mode: "work",
          title: "Strategy Docs",
        },
      }),
    ),
  };
}

export function workDraftShellBootstrap(): ShellBootstrap {
  const value = workShellBootstrap();
  const layout = value.workspace.layouts.work;
  if (layout.kind !== "group") throw new Error("Expected the Work layout group.");
  return {
    ...value,
    workspace: applyWorkspaceOperation(
      value.workspace,
      decodeWorkspaceOperation({
        kind: "open-tab",
        mode: "work",
        groupId: layout.groupId,
        tab: {
          kind: "draft-thread",
          id: "00000000-0000-4000-8000-000000000809",
          mode: "work",
          title: "New Work thread",
          projectId: workProjectId,
        },
      }),
    ),
  };
}

/**
 * A Code draft tab still bound to `draftProjectId` while the Code mode context
 * is bound to a different Project — the shape a rehydrated draft has after its
 * chosen Project was archived or deleted.
 */
export function codeDraftShellBootstrap(draftProjectId: ProjectId): ShellBootstrap {
  const value = bootstrap();
  const activeWorkspace = applyWorkspaceOperation(value.workspace, {
    kind: "set-active-mode",
    mode: "code",
  });
  const layout = activeWorkspace.layouts.code;
  if (layout.kind !== "group") throw new Error("Expected the Code layout group.");
  return {
    ...value,
    workspace: applyWorkspaceOperation(
      {
        ...activeWorkspace,
        contextByMode: {
          ...activeWorkspace.contextByMode,
          code: { ...activeWorkspace.contextByMode.code, projectId },
        },
      },
      decodeWorkspaceOperation({
        kind: "open-tab",
        mode: "code",
        groupId: layout.groupId,
        tab: {
          kind: "draft-thread",
          id: "00000000-0000-4000-8000-000000000810",
          mode: "code",
          title: "New Code thread",
          projectId: String(draftProjectId),
        },
      }),
    ),
  };
}

/** The active "Octant" Code Project plus an archived Code Project. */
export function projectsWithArchivedCodeProject(): ProjectClient {
  const base = projectBootstrap();
  const active = base.active[0]!;
  return projects({
    active: [active],
    archived: [{ ...active, id: otherProjectId, name: "Retired repo", lifecycle: "archived" }],
    availability: [
      {
        projectId,
        status: "available",
        observedAt: "2026-07-14T09:00:00.000Z" as never,
      } as ProjectBootstrap["availability"][number],
    ],
    memory: [],
  });
}

/** A Code client that prepares a checkout and reports every create it is given. */
export function codesRecordingCreates() {
  const value = codes();
  const execute = vi.fn(async (command: { readonly kind: string }) => {
    if (command.kind === "prepare-code-project-checkout") {
      return {
        kind: "checkout-prepared",
        bindingRevisionId: "30000000-0000-4000-8000-000000000099",
        checkout: {
          id: "40000000-0000-4000-8000-000000000001",
          repositoryId: `repo_${"a".repeat(64)}`,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "development", oid: "a".repeat(40) },
          observedAt: "2026-07-21T12:00:00.000Z",
        },
      };
    }
    // Every other command is a create or a composer preview this fixture does
    // not serve; the controller reports the failure instead of crashing.
    throw new Error(`Unhandled ${command.kind}`);
  });
  return { ...value, execute } as unknown as CodeClient & { execute: typeof execute };
}

export function hostClient() {
  return {
    list: vi.fn(async () => []),
  };
}

export function contextClient(): ContextClient {
  return {
    inspect: vi.fn(async ({ subject }) => {
      const snapshot = contextFixture();
      return {
        ...snapshot,
        subject,
        displayLabel: "Strategy Docs",
        next: {
          ...snapshot.next,
          manifest: { ...snapshot.next.manifest, subject },
        },
        latestSent: snapshot.latestSent
          ? {
              ...snapshot.latestSent,
              manifest: { ...snapshot.latestSent.manifest, subject },
            }
          : undefined,
        capacity: snapshot.capacity ? { ...snapshot.capacity, subject } : undefined,
      } as never;
    }),
    execute: vi.fn(),
  };
}

export function openAiProvider(id: string, displayName: string): ProviderInstance {
  const now = "2026-07-26T09:00:00.000Z" as UtcTimestamp;
  return {
    id: id as ProviderInstance["id"],
    displayName,
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication: "none",
      protocol: "responses",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: now,
    updatedAt: now,
  };
}

export function providerModel(input: {
  id: string;
  displayName: string;
  toolCalling?: "supported" | "unsupported" | "unavailable";
  evidence?: "supported" | "unsupported" | "unavailable";
}): ProviderModel {
  const now = "2026-07-26T09:00:00.000Z" as UtcTimestamp;
  return {
    id: input.id as ProviderModel["id"],
    displayName: input.displayName,
    orderHint: undefined,
    contextLimit: undefined,
    maxOutputTokens: undefined,
    reasoning: "unavailable",
    toolCalling: input.toolCalling,
    parallelTools: undefined,
    structuredOutput: undefined,
    streaming: undefined,
    inputModalities: ["text"],
    options: [],
    capabilityEvidence:
      input.evidence === undefined
        ? undefined
        : [
            {
              capability: "tool-calling",
              support: input.evidence,
              source: "endpoint-observation",
              confidence: "high",
              protocol: "responses",
              observedAt: now,
              invalidated: false,
            },
          ],
    source: "discovered",
    verification: "verified",
  };
}

export function observedProvider(
  instanceId: ProviderInstance["id"],
  models: ReadonlyArray<ProviderModel>,
): ProviderObservedState {
  return {
    instanceId,
    readiness: "ready",
    processState: "running",
    models,
    capabilities: {
      streaming: "supported",
      resume: "unavailable",
      interruption: "supported",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "unavailable",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "unavailable",
      diffs: "unavailable",
      taskProgress: "supported",
      nativeChildAgents: "unavailable",
      nativeAttachments: "unavailable",
      nativeWebResearch: "unavailable",
      appManagedTools: "supported",
      citations: "unavailable",
    },
    observedAt: "2026-07-26T09:00:00.000Z" as UtcTimestamp,
  };
}

export function splitLayout(
  orientation: "horizontal" | "vertical" = "horizontal",
  ratio = 0.3,
): WorkspaceLayoutNode {
  return decodeWorkspaceLayoutNode({
    kind: "split",
    nodeId: "00000000-0000-4000-8000-000000000610",
    orientation,
    ratio,
    first: {
      kind: "group",
      nodeId: "00000000-0000-4000-8000-000000000611",
      groupId: "00000000-0000-4000-8000-000000000612",
      tabs: [
        {
          kind: "welcome",
          id: "00000000-0000-4000-8000-000000000613",
          mode: "code",
          title: "First",
        },
        {
          kind: "welcome",
          id: "00000000-0000-4000-8000-000000000614",
          mode: "code",
          title: "Second",
        },
      ],
      activeTabId: "00000000-0000-4000-8000-000000000613",
    },
    second: {
      kind: "group",
      nodeId: "00000000-0000-4000-8000-000000000621",
      groupId: "00000000-0000-4000-8000-000000000622",
      tabs: [
        {
          kind: "welcome",
          id: "00000000-0000-4000-8000-000000000623",
          mode: "code",
          title: "Third",
        },
      ],
      activeTabId: "00000000-0000-4000-8000-000000000623",
    },
  });
}

export function splitCallbacks(): Omit<SplitWorkspaceProps, "layout" | "renderTab"> {
  return {
    mode: "code",
    onActivate: vi.fn(),
    onClearFocus: vi.fn(),
    onClose: vi.fn(),
    onCommitResize: vi.fn(),
    onFocus: vi.fn(),
    onDropTab: vi.fn(),
    onMove: vi.fn(),
    onPreviewResize: vi.fn(),
    onReorder: vi.fn(),
    onSplit: vi.fn(),
    totalWorkspaceGroupCount: 4,
  };
}

export function emptyCanvasInventoryResponse(
  projectId: string = "00000000-0000-4000-8000-000000000806",
) {
  return new Response(JSON.stringify({ projectId, entries: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function canvasFetchPassthrough(url: string): Response | undefined {
  if (url.includes("/api/canvas/inventory")) {
    const projectId = new URL(url, "http://127.0.0.1").searchParams.get("projectId") ?? undefined;
    return emptyCanvasInventoryResponse(projectId);
  }
  if (url.includes("/api/canvas/get")) {
    return new Response(
      JSON.stringify({
        kind: "unavailable",
        canvasId: "11111111-1111-4111-8111-111111111111",
        reason: "Canvas is unavailable.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return undefined;
}

export async function openSidebarProject(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = await screen.findByRole("button", { name: `Project actions for ${name}` });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("menuitem", { name: "Open Project" }));
}

/**
 * The sidebar names the person, and their settings hang off that row, so a test
 * that wants Settings opens their row first.
 */
export async function openSettingsFromSidebar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Set your name" }));
  await user.click(await screen.findByRole("button", { name: "Settings" }));
}
