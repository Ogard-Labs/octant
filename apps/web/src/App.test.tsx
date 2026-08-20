import {
  decodeWorkThread,
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
  type ProjectSummary,
  type ProviderInstance,
  type ProviderModel,
  type ProviderObservedState,
  type ProviderRegistryCommand,
  type ProviderRegistryCommandResult,
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
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  App,
  activeCodeThreadTabId,
  openLocalCodeThreadIds,
  launchFromLocation,
  resolveWorkProviderChoice,
  resolveDraftProject,
} from "./App";
import { ProjectCreateDialog } from "./projects/ProjectCreateDialog";
import { ProjectMemoryInspectorProvider } from "./projects/ProjectMemoryInspector";
import { ProjectOverview } from "./projects/ProjectOverview";
import { SettingsView } from "./shell/SettingsView";
import { contextFixture } from "./context/contextFixtures";
/**
 * Shell settings for a host that has already resolved first run. These suites
 * exercise the workspace, and the first-run surface is a modal that correctly
 * hides the workspace from assistive technology while it is open.
 */
function settingsPastFirstRun(): ReturnType<typeof defaultShellSettings> {
  return { ...defaultShellSettings(), firstRunOnboarding: "completed" as const };
}

import { SplitWorkspace, type SplitWorkspaceProps } from "./shell/SplitWorkspace";
import type { OctantHostBridge } from "./shell/hostBridge";
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
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import type { AutomationClient } from "@octant/client-runtime";
import {
  automationCodeDraftFixture,
  automationDefinitionFixture,
  automationRunFixture,
  automationSummaryFixture,
} from "./automation/automationTestFixtures";

// The Automation Center ships fully wired. Tests flip this mock to prove the
// complete surface appears when the release gate is on and stays hidden when off.
const automationGate = vi.hoisted(() => ({ enabled: false }));
vi.mock("./automation/automationCenterGate", () => ({
  get AUTOMATION_CENTER_NAVIGATION_ENABLED() {
    return automationGate.enabled;
  },
}));

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000601");
const projectWindowCapability = "C".repeat(43);
const bindingReceipt = `${"R".repeat(42)}A`;
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000801");
const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000802");
const oldChatThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000803");
const createdChatThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000804");
const archivedChatThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000805");
const codeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000805");
const workProjectId = decodeProjectId("00000000-0000-4000-8000-000000000806");
const workThreadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000807");
const styles = [
  readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(
    '@import "./styles/shell.css";',
    "",
  ),
  readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/styles/dock.css"), "utf8"),
].join("\n");

const readyEnvironment: Extract<CodeEnvironmentObservation, { status: "ready" }> = {
  status: "ready",
  projectId,
  projectName: "Octant",
  observedAt: "2026-07-16T09:00:00.000Z" as CodeEnvironmentObservation["observedAt"],
  repositoryRoot: "/Users/example/Dev/Repos/octant",
  worktreeRoot: "/Users/example/Dev/Repos/octant/.agent-worktrees/issue-52-distilled-shell",
  branch: { kind: "named", name: "feature/issue-52-distilled-shell" },
  changes: "dirty",
};

afterEach(() => {
  automationGate.enabled = false;
  vi.unstubAllGlobals();
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

function credentialHostOperations() {
  return {
    clearProviderCredential: vi.fn(),
    providerCredentialStatus: vi.fn(async () => "missing" as const),
    setProviderCredential: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

function projectBootstrap(): ProjectBootstrap {
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

function projects(value = projectBootstrap()): ProjectClient {
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

function bootstrap(): ShellBootstrap {
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

function chatShellBootstrap(): ShellBootstrap {
  const value = bootstrap();
  return {
    ...value,
    workspace: applyWorkspaceOperation(value.workspace, { kind: "set-active-mode", mode: "chat" }),
  };
}

function splitChatShellBootstrap(): ShellBootstrap {
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

function codeShellBootstrap(): ShellBootstrap {
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

function chats(options: { readonly threadProjectId?: string } = {}): ChatClient {
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
function archivedChatThread(): ChatThread {
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

function codes(): CodeClient {
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
      version: 2 as const,
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

function client(value: ShellBootstrap = codeShellBootstrap()) {
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

function providers(): ProviderClient {
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

function providersWithToolModel(): ProviderClient {
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
function providersWithChatOnlyModel(): ProviderClient {
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

function computerUseClientWithSession(): ComputerUseClient {
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

function workProjects(
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

function workShellBootstrap(): ShellBootstrap {
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

function workDraftShellBootstrap(): ShellBootstrap {
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
function codeDraftShellBootstrap(draftProjectId: ProjectId): ShellBootstrap {
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
function projectsWithArchivedCodeProject(): ProjectClient {
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
function codesRecordingCreates() {
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

function hostClient() {
  return {
    list: vi.fn(async () => []),
  };
}

function contextClient(): ContextClient {
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

function openAiProvider(id: string, displayName: string): ProviderInstance {
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

function providerModel(input: {
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

function observedProvider(
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

function splitLayout(
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

function splitCallbacks(): Omit<SplitWorkspaceProps, "layout" | "renderTab"> {
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

function emptyCanvasInventoryResponse(projectId: string = "00000000-0000-4000-8000-000000000806") {
  return new Response(JSON.stringify({ projectId, entries: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function canvasFetchPassthrough(url: string): Response | undefined {
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

async function openSidebarProject(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = await screen.findByRole("button", { name: `Project actions for ${name}` });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("menuitem", { name: "Open Project" }));
}

/**
 * The sidebar names the person, and their settings hang off that row, so a test
 * that wants Settings opens their row first.
 */
async function openSettingsFromSidebar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Set your name" }));
  await user.click(await screen.findByRole("button", { name: "Settings" }));
}

describe("App", () => {
  it("falls back to an available Work provider when the saved selection is stale", () => {
    const available = {
      instanceId: "90000000-0000-4000-8000-000000000001" as never,
      modelId: "gpt-5" as never,
      label: "OpenAI Compatible — GPT-5",
    };

    expect(
      resolveWorkProviderChoice(
        [available],
        "80000000-0000-4000-8000-000000000001" as never,
        "chat-only" as never,
      ),
    ).toEqual(available);
  });

  /**
   * An explicitly chosen Project is authoritative. A draft whose Project was
   * archived or deleted while it stayed open must refuse rather than silently
   * retarget the active Project — that would start work in another repository.
   */
  it("refuses a draft whose chosen Project no longer resolves instead of substituting the active one", () => {
    const active = { id: projectId, name: "Octant" };
    const other = { id: otherProjectId, name: "Retired repo" };

    expect(
      resolveDraftProject({
        draftProjectId: other.id,
        candidates: [active],
        activeProject: active,
      }),
    ).toEqual({ kind: "unresolved-selection" });
    expect(
      resolveDraftProject({
        draftProjectId: other.id,
        candidates: [active, other],
        activeProject: active,
      }),
    ).toEqual({ kind: "project", project: other });
  });

  /**
   * Split view: focusing the Browser pane must not unload the Code thread
   * shown in the sibling pane. A utility tab has no thread of its own, so the
   * visible Code thread stays active; a Welcome tab still yields none.
   */
  it("keeps the sibling pane's Code thread active while a utility tab is focused", () => {
    const threadId = "00000000-0000-4000-8000-000000000701";
    const browserGroupId = "00000000-0000-4000-8000-000000000622";
    const layout = (activeTabId: string) =>
      decodeWorkspaceLayoutNode({
        kind: "split",
        nodeId: "00000000-0000-4000-8000-000000000610",
        orientation: "horizontal",
        ratio: 0.5,
        first: {
          kind: "group",
          nodeId: "00000000-0000-4000-8000-000000000611",
          groupId: "00000000-0000-4000-8000-000000000612",
          tabs: [
            {
              kind: "code-overview",
              id: "00000000-0000-4000-8000-000000000613",
              threadId,
              mode: "code",
              title: "Thread",
            },
          ],
          activeTabId: "00000000-0000-4000-8000-000000000613",
        },
        second: {
          kind: "group",
          nodeId: "00000000-0000-4000-8000-000000000621",
          groupId: browserGroupId,
          tabs: [
            {
              kind: "browser",
              id: "00000000-0000-4000-8000-000000000623",
              mode: "code",
              title: "Browser",
            },
            {
              kind: "welcome",
              id: "00000000-0000-4000-8000-000000000624",
              mode: "code",
              title: "Welcome",
            },
          ],
          activeTabId,
        },
      });

    expect(
      activeCodeThreadTabId(
        layout("00000000-0000-4000-8000-000000000623"),
        browserGroupId as never,
      ),
    ).toBe(threadId);
    expect(
      activeCodeThreadTabId(
        layout("00000000-0000-4000-8000-000000000624"),
        browserGroupId as never,
      ),
    ).toBeUndefined();
  });

  it("collects every open Code thread once, however many surfaces it has open", () => {
    const threadA = "00000000-0000-4000-8000-000000000631";
    const threadB = "00000000-0000-4000-8000-000000000632";
    const layout = {
      kind: "split",
      nodeId: "00000000-0000-4000-8000-000000000633",
      orientation: "horizontal",
      ratio: 0.5,
      first: {
        kind: "group",
        nodeId: "00000000-0000-4000-8000-000000000634",
        groupId: "00000000-0000-4000-8000-000000000635",
        activeTabId: "00000000-0000-4000-8000-000000000636",
        tabs: [
          {
            kind: "code-overview",
            id: "00000000-0000-4000-8000-000000000636",
            threadId: threadA,
            mode: "code",
            title: "Overview",
          },
          {
            kind: "code-terminal",
            id: "00000000-0000-4000-8000-000000000637",
            threadId: threadA,
            mode: "code",
            title: "Terminal",
          },
          {
            kind: "apple-workbench",
            id: "00000000-0000-4000-8000-000000000638",
            threadId: threadB,
            mode: "code",
            title: "Apple workbench",
            projectPath: "Fixture.xcodeproj",
          },
        ],
      },
      second: {
        kind: "group",
        nodeId: "00000000-0000-4000-8000-000000000639",
        groupId: "00000000-0000-4000-8000-000000000640",
        activeTabId: "00000000-0000-4000-8000-000000000641",
        tabs: [
          {
            kind: "code-diff",
            id: "00000000-0000-4000-8000-000000000641",
            threadId: threadB,
            mode: "code",
            title: "Changes",
            relativePath: "README.md",
          },
          {
            kind: "browser",
            id: "00000000-0000-4000-8000-000000000642",
            mode: "code",
            title: "Browser",
          },
        ],
      },
    } as never;

    expect(openLocalCodeThreadIds(layout).map(String)).toEqual([threadA, threadB]);
  });

  it("uses the active Project only for a draft that named no Project", () => {
    const active = { id: projectId, name: "Octant" };

    expect(
      resolveDraftProject({
        draftProjectId: undefined,
        candidates: [],
        activeProject: active,
      }),
    ).toEqual({ kind: "project", project: active });
    expect(
      resolveDraftProject({
        draftProjectId: undefined,
        candidates: [],
        activeProject: undefined,
      }),
    ).toEqual({ kind: "project", project: undefined });
  });

  it("tells the user why a Code draft bound to a vanished Project cannot start, and creates nothing", async () => {
    const user = userEvent.setup();
    const codeApi = codesRecordingCreates();
    render(
      <App
        codeClient={codeApi}
        contextClient={contextClient()}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectsWithArchivedCodeProject()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client(codeDraftShellBootstrap(otherProjectId))}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "First message" });
    await user.type(prompt, "Fix the parser");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(
      await screen.findByText(
        "The folder this draft was started in is no longer available. Choose another folder before starting the thread.",
      ),
    ).toBeVisible();
    // The active "Octant" Project must never stand in for the archived one.
    for (const [command] of codeApi.execute.mock.calls) {
      expect(String((command as { readonly kind: string }).kind)).not.toMatch(/^create-/);
    }
  });

  /**
   * A ready provider that reports only chat-only models offers no usable Code
   * model. The Code create paths must say so instead of falling back to the
   * first picker entry — which the picker itself marks unusable — and failing
   * only after the work exists.
   */
  it("reports no usable Code model instead of starting a turn on a chat-only model", async () => {
    const user = userEvent.setup();
    const codeApi = codesRecordingCreates();
    render(
      <App
        codeClient={codeApi}
        contextClient={contextClient()}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithChatOnlyModel()}
        shellClient={client(codeDraftShellBootstrap(projectId))}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "First message" });
    await user.type(prompt, "Refactor the parser");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(
      await screen.findByText(
        "No provider is available. Configure a provider before starting a Code thread.",
      ),
    ).toBeVisible();
    for (const [command] of codeApi.execute.mock.calls) {
      expect(String((command as { readonly kind: string }).kind)).not.toMatch(/^create-/);
    }
  });

  it("renders the authoritative Code overview and thread navigation", async () => {
    const codeApi = codes();
    render(
      <App
        chatClient={chats()}
        codeClient={codeApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    expect(
      within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", {
        name: /Controller foundation/,
      }),
    ).toBeVisible();
    expect(codeApi.thread).toHaveBeenCalledWith(codeThreadId);
    expect(codeApi.subscribe).toHaveBeenCalledWith(codeThreadId, 0, expect.any(AbortSignal));
  });

  it("hides the sidebar from its own control and brings it back from the window chrome", async () => {
    const user = userEvent.setup();
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Octant sidebar" })).not.toBeInTheDocument();
    expect(globalThis.localStorage.getItem("octant.shell.sidebar-collapsed.v1")).toBe("true");
    // The activated control is unmounted by its own state change, so focus
    // moves to the control that replaced it instead of the document body.
    expect(screen.getByRole("button", { name: "Show sidebar" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(screen.getByRole("complementary", { name: "Octant sidebar" })).toBeVisible();
    expect(globalThis.localStorage.getItem("octant.shell.sidebar-collapsed.v1")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveFocus();
  });

  it("keeps Automations hidden when the release gate is off and overlays implemented rail placeholders", async () => {
    const user = userEvent.setup();
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pull requests" }));

    expect(screen.getByRole("heading", { name: "Pull requests" })).toBeVisible();
    expect(document.querySelector(".rail-placeholder")).toBeVisible();
    expect(document.querySelector(".workspace")).toHaveAttribute("hidden");
    expect(styles).toMatch(/\.rail-placeholder\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
  });

  it("sends Plugins to the Settings destination that actually exists", async () => {
    const user = userEvent.setup();
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Plugins" }));

    // Skills and extensions have a real Settings section, so the entry opens it
    // rather than a placeholder explaining where the surface would be.
    expect(await screen.findByRole("navigation", { name: "Settings sections" })).toBeVisible();
    expect(document.querySelector(".rail-placeholder")).toBeNull();
  });

  it("opens the complete Automation Center from the sidebar once the release gate flips", async () => {
    automationGate.enabled = true;
    const user = userEvent.setup();
    const definition = automationDefinitionFixture(automationCodeDraftFixture());
    const run = automationRunFixture(definition, {
      lifecycle: "completed",
      threadId: String(codeThreadId),
    });
    const summary = automationSummaryFixture({
      id: definition.id,
      displayName: definition.displayName,
      mode: "code",
      projectId: definition.projectId,
      latestRunLifecycle: "completed",
    });
    const automationApi = {
      list: vi.fn(async () => ({ items: [summary] })),
      get: vi.fn(async () => ({ automation: definition, runs: [run] })),
      history: vi.fn(async () => ({ runs: [run] })),
      execute: vi.fn(),
    } as unknown as AutomationClient;
    const codeApi = codes();
    render(
      <App
        automationClient={automationApi}
        chatClient={chats()}
        codeClient={codeApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Automations" }));

    expect(await screen.findByRole("heading", { name: "Automation Center" })).toBeVisible();
    expect(document.querySelector(".workspace")).toHaveAttribute("hidden");
    expect(await screen.findByRole("button", { name: "Nightly build check" })).toBeVisible();

    // Close and reopen: the sidebar action and the explicit close both work.
    await user.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(screen.queryByRole("heading", { name: "Automation Center" })).not.toBeInTheDocument();
    expect(document.querySelector(".workspace")).not.toHaveAttribute("hidden");
    await user.click(screen.getByRole("button", { name: "Automations" }));

    // Run rows with a thread receipt navigate to the ordinary thread.
    await user.click(await screen.findByRole("button", { name: "Nightly build check" }));
    expect(await screen.findByRole("heading", { name: "Nightly build check" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Open thread" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Automation Center" })).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".workspace")).not.toHaveAttribute("hidden");
    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
  });

  it("dismisses a rail placeholder when the user changes modes", async () => {
    const user = userEvent.setup();
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pull requests" }));
    expect(screen.getByRole("heading", { name: "Pull requests" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Chat" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Pull requests" })).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".workspace")).not.toHaveAttribute("hidden");
  });

  it("authenticates a browser session by exchanging a launch token from the URL fragment", async () => {
    const launchToken = `${"A".repeat(42)}A`;
    const browserCapability = `${"C".repeat(42)}A`;
    const originalHref = window.location.href;
    window.location.hash = `launchToken=${launchToken}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/shell/launch-session")) {
        return new Response(JSON.stringify({ windowId, capability: browserCapability }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const canvasResponse = canvasFetchPassthrough(url);
      if (canvasResponse !== undefined) {
        return canvasResponse;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const codeApi = codes();
      render(
        <App
          chatClient={chats()}
          codeClient={codeApi}
          projectClient={projects()}
          providerClient={providers()}
          shellClient={client(codeShellBootstrap())}
        />,
      );
      expect(
        await screen.findByRole("banner", {
          name: "Workspace actions for Controller foundation",
        }),
      ).toBeVisible();
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("/api/shell/launch-session", window.location.origin),
        expect.objectContaining({ method: "POST" }),
      );
      expect(window.location.hash).toBe("");
    } finally {
      vi.unstubAllGlobals();
      window.history.replaceState(null, "", originalHref);
    }
  });

  it("derives the host URL from the browser origin when only a launch token fragment is present", () => {
    const launchToken = `${"A".repeat(42)}A`;
    const href = `http://127.0.0.1:13773/#launchToken=${launchToken}`;
    const launch = launchFromLocation(href);
    expect(launch).toEqual({ serverUrl: "http://127.0.0.1:13773/", windowId: undefined });
  });

  it("launchFromLocation returns undefined when neither serverUrl nor a launch token fragment is present", () => {
    expect(launchFromLocation("http://127.0.0.1:13773/")).toBeUndefined();
  });

  it("launchFromLocation prefers an explicit serverUrl query param over the origin", () => {
    const href = `http://127.0.0.1:13773/?serverUrl=${encodeURIComponent("http://localhost:9999")}&windowId=${windowId}`;
    const launch = launchFromLocation(href);
    expect(launch?.serverUrl).toBe("http://localhost:9999/");
    expect(launch?.windowId).toBe(windowId);
  });

  it("recognizes an explicit development web bootstrap launch without a token", () => {
    const href = `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent("http://127.0.0.1:13773")}&developmentWebBootstrap=1`;
    expect(launchFromLocation(href)).toEqual({
      serverUrl: "http://127.0.0.1:13773/",
      developmentWebBootstrap: true,
    });
  });

  it("renders independent authoritative Chat sessions in every visible split pane", async () => {
    const chatApi = chats();

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(splitChatShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Older chat" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Exact created chat" })).toBeVisible();
    await waitFor(() => {
      expect(chatApi.subscribe).toHaveBeenCalledWith(oldChatThreadId, 0, expect.any(AbortSignal));
      expect(chatApi.subscribe).toHaveBeenCalledWith(
        createdChatThreadId,
        0,
        expect.any(AbortSignal),
      );
    });
  });

  it("opens one App-level command palette that runs a host-derived navigation command", async () => {
    const user = userEvent.setup();
    const shellApi = client(chatShellBootstrap());

    render(
      <App
        chatClient={chats()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );
    await screen.findByRole("region", { name: "Chat welcome" });

    await user.keyboard("{Control>}k{/Control}");

    const search = await screen.findByRole("combobox", { name: "Search commands" });
    // The dialog moves focus into the search field on a later frame.
    await waitFor(() => expect(search).toHaveFocus());
    // Exactly one palette exists for the window, mounted at the App level.
    expect(screen.getAllByRole("combobox", { name: "Search commands" })).toHaveLength(1);

    await user.keyboard("work");
    expect(screen.getByRole("option", { name: /Switch to Work/ })).toBeVisible();
    await user.keyboard("{Enter}");

    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "set-active-mode", mode: "work" }),
      }),
    );
    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
  });

  it("opens the exact thread returned by the authoritative New chat command", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const shellApi = client(chatShellBootstrap());

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.type(within(welcome).getByRole("textbox", { name: "First message" }), "New chat");
    await user.click(within(welcome).getByRole("button", { name: "Start chat" }));

    expect(chatApi.execute).toHaveBeenCalledWith({
      kind: "create-chat-thread",
      title: "New chat",
    });
    expect(chatApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "send-chat-turn",
        threadId: createdChatThreadId,
        prompt: "New chat",
      }),
    );
    expect(await screen.findByRole("tab", { name: "Exact created chat" })).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-tab",
          tab: expect.objectContaining({
            kind: "chat-thread",
            threadId: createdChatThreadId,
          }),
        }),
      }),
    );
    const sendCallOrder = vi
      .mocked(chatApi.execute)
      .mock.invocationCallOrder.find(
        (_, index) => vi.mocked(chatApi.execute).mock.calls[index]?.[0].kind === "send-chat-turn",
      );
    const openCallOrder = shellApi.execute.mock.invocationCallOrder.find(
      (_, index) =>
        shellApi.execute.mock.calls[index]?.[0].kind === "apply-workspace-operation" &&
        shellApi.execute.mock.calls[index]?.[0].operation.kind === "open-tab" &&
        shellApi.execute.mock.calls[index]?.[0].operation.tab.kind === "chat-thread",
    );
    expect(sendCallOrder).toBeDefined();
    expect(openCallOrder).toBeDefined();
    expect(sendCallOrder!).toBeLessThan(openCallOrder!);
  });

  it("creates a Project-scoped Chat thread through the authoritative quick start", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const chatProject = {
      id: projectId,
      type: "chat",
      name: "Launch planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z",
    } as never;
    const projectApi = projects({
      active: [chatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(async () => ({ projectId, active: [], history: [] }) as never);
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const projectWorkspace = applyWorkspaceOperation(initial.workspace, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000890" as never,
        projectId,
        mode: "chat",
        title: "Launch planning",
      },
    });
    const shellApi = client({
      ...initial,
      workspace: {
        ...projectWorkspace,
        contextByMode: {
          ...projectWorkspace.contextByMode,
          chat: {
            ...projectWorkspace.contextByMode.chat,
            projectId: otherProjectId,
          },
        },
      },
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const quickStart = await screen.findByRole("region", { name: "Chat quick start" });
    await user.type(
      within(quickStart).getByRole("textbox", { name: "Start a new Chat thread" }),
      "Prepare launch brief",
    );
    await user.click(within(quickStart).getByRole("button", { name: "Start thread" }));

    expect(chatApi.execute).toHaveBeenCalledWith({
      kind: "create-chat-thread",
      projectId,
      title: "Prepare launch brief",
    });
    expect(chatApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "send-chat-turn",
        threadId: createdChatThreadId,
        prompt: "Prepare launch brief",
      }),
    );
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "apply-workspace-operation",
          operation: expect.objectContaining({
            kind: "switch-project-tab",
            mode: "chat",
            tab: expect.objectContaining({
              kind: "chat-thread",
              threadId: createdChatThreadId,
            }),
          }),
        }),
      ),
    );
  });

  it("opens the created Project Chat thread when its first turn cannot be dispatched", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const execute = vi.mocked(chatApi.execute);
    const baseExecute = execute.getMockImplementation()!;
    execute.mockImplementation(async (command) => {
      if (command.kind === "send-chat-turn") throw new Error("Provider is unavailable.");
      return await baseExecute(command);
    });
    const chatProject = {
      id: projectId,
      type: "chat",
      name: "Launch planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z",
    } as never;
    const projectApi = projects({
      active: [chatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(async () => ({ projectId, active: [], history: [] }) as never);
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const shellApi = client({
      ...initial,
      workspace: applyWorkspaceOperation(initial.workspace, {
        kind: "open-tab",
        mode: "chat",
        groupId: layout.groupId,
        tab: {
          kind: "project",
          id: "00000000-0000-4000-8000-000000000891" as never,
          projectId,
          mode: "chat",
          title: "Launch planning",
        },
      }),
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const quickStart = await screen.findByRole("region", { name: "Chat quick start" });
    await user.type(
      within(quickStart).getByRole("textbox", { name: "Start a new Chat thread" }),
      "Prepare launch brief",
    );
    await user.click(within(quickStart).getByRole("button", { name: "Start thread" }));

    expect(await screen.findByRole("tab", { name: "Exact created chat" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The first message could not be sent. Retry from the open thread.",
    );
  });

  it("applies the selected Chat provider and model before starting the first turn", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const execute = vi.mocked(chatApi.execute);
    const baseExecute = execute.getMockImplementation()!;
    execute.mockImplementation(async (command) => {
      if (command.kind === "change-chat-provider") {
        return decodeChatCommandResult({
          kind: "thread-updated",
          thread: {
            id: createdChatThreadId,
            title: "Exact created chat",
            lifecycle: "active",
            providerInstanceId: command.providerInstanceId,
            modelId: command.modelId,
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be calm.",
            version: 2,
            createdAt: "2026-07-20T08:00:00.000Z",
            updatedAt: "2026-07-20T08:00:01.000Z",
          },
        });
      }
      return await baseExecute(command);
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.click(within(welcome).getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "GPT-5" }));
    await user.type(within(welcome).getByRole("textbox", { name: "First message" }), "Use GPT-5");
    await user.click(within(welcome).getByRole("button", { name: "Start chat" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "change-chat-provider",
      threadId: createdChatThreadId,
      expectedVersion: 1,
      providerInstanceId: "90000000-0000-4000-8000-000000000001",
      modelId: "gpt-5",
    });
    expect(execute).toHaveBeenCalledWith({
      kind: "send-chat-turn",
      threadId: createdChatThreadId,
      expectedVersion: 2,
      prompt: "Use GPT-5",
    });
    const commands = execute.mock.calls.map(([command]) => command.kind);
    expect(commands.indexOf("change-chat-provider")).toBeLessThan(
      commands.indexOf("send-chat-turn"),
    );
  });

  it("ignores a draft provider selection that became unselectable before create", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const instanceA = openAiProvider("90000000-0000-4000-8000-000000000001", "Primary Gateway");
    const instanceB = openAiProvider("90000000-0000-4000-8000-000000000002", "Backup Gateway");
    let primaryEnabled = true;
    const providerApi = {
      bootstrap: vi.fn(async () => ({
        instances: [{ ...instanceA, enabled: primaryEnabled }, instanceB],
        defaults: { permissionPersistence: "current-session" as const, version: 0 as never },
        observedStates: [
          observedProvider(instanceA.id, [
            providerModel({
              id: "gpt-5",
              displayName: "GPT-5",
              toolCalling: "supported",
              evidence: "supported",
            }),
          ]),
          observedProvider(instanceB.id, [
            providerModel({
              id: "backup-1",
              displayName: "Backup 1",
              toolCalling: "supported",
              evidence: "supported",
            }),
          ]),
        ],
      })),
      execute: vi.fn(
        async (command: ProviderRegistryCommand): Promise<ProviderRegistryCommandResult> => {
          if (command.kind === "set-provider-enabled") {
            primaryEnabled = command.enabled;
            return {
              kind: "provider-updated",
              instance: { ...instanceA, enabled: primaryEnabled },
            };
          }
          throw new Error(`Unexpected provider command ${command.kind}.`);
        },
      ),
      probe: vi.fn(),
    };
    const execute = vi.mocked(chatApi.execute);

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providerApi}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.click(within(welcome).getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "Primary Gateway" }));
    await user.click(screen.getByRole("option", { name: "GPT-5" }));

    await openSettingsFromSidebar(user);
    fireEvent.click(await screen.findByRole("button", { name: "Providers & Models" }));
    await user.click(await screen.findByRole("button", { name: "Details for Primary Gateway" }));
    await user.click(await screen.findByRole("button", { name: "Disable Primary Gateway" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Enable Primary Gateway" })).toBeVisible(),
    );
    await user.click(screen.getByRole("button", { name: "Back to app" }));

    const freshWelcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.type(within(freshWelcome).getByRole("textbox", { name: "First message" }), "Hi");
    await user.click(within(freshWelcome).getByRole("button", { name: "Start chat" }));

    await waitFor(() =>
      expect(execute.mock.calls.some(([command]) => command.kind === "send-chat-turn")).toBe(true),
    );
    expect(execute.mock.calls.some(([command]) => command.kind === "change-chat-provider")).toBe(
      false,
    );
  });

  it("opens a newly created chat while its first provider turn is still pending", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const shellApi = client(chatShellBootstrap());
    const execute = vi.mocked(chatApi.execute);
    const baseExecute = execute.getMockImplementation();
    let resolveSend: ((value: Awaited<ReturnType<ChatClient["execute"]>>) => void) | undefined;
    execute.mockImplementation((command) => {
      if (command.kind !== "send-chat-turn") return baseExecute!(command);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    const createProject = screen.getByRole("button", { name: "New Chat Project" });
    expect(createProject).toHaveClass("project-section__add");
    expect(createProject).not.toHaveTextContent("New Chat Project");
    await user.type(within(welcome).getByRole("textbox", { name: "First message" }), "Open now");
    await user.click(within(welcome).getByRole("button", { name: "Start chat" }));

    expect(await screen.findByRole("tab", { name: "Exact created chat" })).toBeVisible();
    expect(resolveSend).toBeDefined();
    resolveSend!(
      decodeChatCommandResult({
        kind: "thread-created",
        thread: {
          id: createdChatThreadId,
          title: "Exact created chat",
          lifecycle: "active",
          providerInstanceId: "10000000-0000-4000-8000-000000000001",
          modelId: "model-a",
          researchEnabled: false,
          researchRouting: "automatic",
          personalityInstructions: "Be calm.",
          version: 1,
          createdAt: "2026-07-20T08:00:00.000Z",
          updatedAt: "2026-07-20T08:00:00.000Z",
        },
      }),
    );
  });

  it("enables overview Start thread and opens the created Work thread", async () => {
    const user = userEvent.setup();
    const shellApi = client(workShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => ({
        kind: "thread-created" as const,
        thread: decodeWorkThread({
          id: workThreadId,
          projectId: workProjectId,
          title: "Draft brief",
          lifecycle: "active",
          providerInstanceId: "90000000-0000-4000-8000-000000000001" as never,
          modelId: "gpt-5" as never,
          bindingRevisionId: "30000000-0000-4000-8000-000000000001" as never,
          workingDirectory: "." as never,
          version: 1,
          createdAt: "2026-07-26T09:30:00.000Z" as never,
          updatedAt: "2026-07-26T09:30:00.000Z" as never,
        }),
      })),
    };
    const workTurnClient = {
      startFirstTurn: vi.fn(async () => ({
        kind: "accepted",
        turn: {
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          threadId: workThreadId,
          turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          projectId: workProjectId,
          authority: {
            hostId: "local",
            projectId: workProjectId,
            bindingRevisionId: "30000000-0000-4000-8000-000000000001",
            workingDirectory: ".",
            confinementPosture: "project-root-confined",
            providerInstanceId: "90000000-0000-4000-8000-000000000001",
            modelId: "gpt-5",
          },
          status: "accepted",
          prompt: "Draft brief",
          transcript: [{ role: "user", text: "Draft brief" }],
          capabilities: {
            workspace: "project-backed",
            confinement: "project-root-confined",
            shell: "denied",
            git: "denied",
            worktree: "denied",
            pullRequest: "denied",
            code: "denied",
          },
          version: 1,
          acceptedAt: "2026-07-26T09:45:00.000Z",
          updatedAt: "2026-07-26T09:45:00.000Z",
        },
      })),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/work/overview")) {
          return new Response(
            JSON.stringify({
              projectId: workProjectId,
              filesAndArtifacts: [],
              workflowsAndThreads: [],
              approvals: [],
              versions: [],
              validation: [],
              exports: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const canvasResponse = canvasFetchPassthrough(url);
        if (canvasResponse !== undefined) {
          return canvasResponse;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "Start a new Work thread" });
    await user.type(prompt, "Draft brief");
    const start = screen.getByRole("button", { name: "Start thread" });
    expect(start).toBeEnabled();
    await user.click(start);

    expect(workThreadClient.execute).toHaveBeenCalledWith({
      kind: "create-work-thread",
      threadId: expect.any(String),
      projectId: workProjectId,
      title: "Draft brief",
      providerInstanceId: "90000000-0000-4000-8000-000000000001",
      modelId: "gpt-5",
      hostId: "local",
      bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      workingDirectory: ".",
    });
    expect(workTurnClient.startFirstTurn).toHaveBeenCalledWith({
      kind: "start-work-thread-turn",
      requestId: expect.any(String),
      threadId: workThreadId,
      turnId: expect.any(String),
      prompt: "Draft brief",
      authority: {
        hostId: "local",
        projectId: workProjectId,
        bindingRevisionId: "30000000-0000-4000-8000-000000000001",
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: "90000000-0000-4000-8000-000000000001",
        modelId: "gpt-5",
      },
    });
    expect(await screen.findByRole("tab", { name: "Draft brief" })).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-tab",
          mode: "work",
          tab: expect.objectContaining({
            kind: "work-thread",
            threadId: workThreadId,
          }),
        }),
      }),
    );
  });

  it("preserves the Work overview draft when authoritative create fails", async () => {
    const user = userEvent.setup();
    const shellApi = client(workShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => {
        throw new Error("Work Project is unavailable for this window.");
      }),
    };
    const workTurnClient = {
      startFirstTurn: vi.fn(),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/work/overview")) {
          return new Response(
            JSON.stringify({
              projectId: workProjectId,
              filesAndArtifacts: [],
              workflowsAndThreads: [],
              approvals: [],
              versions: [],
              validation: [],
              exports: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const canvasResponse = canvasFetchPassthrough(url);
        if (canvasResponse !== undefined) {
          return canvasResponse;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "Start a new Work thread" });
    await user.type(prompt, "Keep this overview draft");
    await user.click(screen.getByRole("button", { name: "Start thread" }));

    expect(workThreadClient.execute).toHaveBeenCalled();
    expect(workTurnClient.startFirstTurn).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("Keep this overview draft");
    expect(screen.queryByRole("tab", { name: "Keep this overview draft" })).toBeNull();
  });

  it("creates a Work thread from a draft tab and opens the authoritative thread tab", async () => {
    const user = userEvent.setup();
    const shellApi = client(workDraftShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => ({
        kind: "thread-created" as const,
        thread: decodeWorkThread({
          id: workThreadId,
          projectId: workProjectId,
          title: "Release checklist",
          lifecycle: "active",
          providerInstanceId: "90000000-0000-4000-8000-000000000001" as never,
          modelId: "gpt-5" as never,
          bindingRevisionId: "30000000-0000-4000-8000-000000000001" as never,
          workingDirectory: "." as never,
          version: 1,
          createdAt: "2026-07-26T09:45:00.000Z" as never,
          updatedAt: "2026-07-26T09:45:00.000Z" as never,
        }),
      })),
    };

    const workTurnClient = {
      startFirstTurn: vi.fn(async () => ({ kind: "accepted", turn: { status: "accepted" } })),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    await user.type(
      await screen.findByRole("textbox", { name: "First message" }),
      "Release checklist",
    );
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(workThreadClient.execute).toHaveBeenCalledWith({
      kind: "create-work-thread",
      threadId: expect.any(String),
      projectId: workProjectId,
      title: "Release checklist",
      providerInstanceId: "90000000-0000-4000-8000-000000000001",
      modelId: "gpt-5",
      hostId: "local",
      bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      workingDirectory: ".",
    });
    expect(workTurnClient.startFirstTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "start-work-thread-turn",
        threadId: workThreadId,
        prompt: "Release checklist",
        authority: expect.objectContaining({
          hostId: "local",
          projectId: workProjectId,
          bindingRevisionId: "30000000-0000-4000-8000-000000000001",
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: "90000000-0000-4000-8000-000000000001",
          modelId: "gpt-5",
        }),
      }),
    );
    expect(await screen.findByRole("tab", { name: "Release checklist" })).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-tab",
          mode: "work",
          tab: expect.objectContaining({
            kind: "work-thread",
            threadId: workThreadId,
          }),
        }),
      }),
    );
  });

  it("preserves the Work draft tab when create fails before a first turn", async () => {
    const user = userEvent.setup();
    const shellApi = client(workDraftShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => {
        throw new Error("Selected provider is unavailable.");
      }),
    };
    const workTurnClient = {
      startFirstTurn: vi.fn(),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "First message" });
    await user.type(prompt, "Do not lose this Work draft");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(workThreadClient.execute).toHaveBeenCalled();
    expect(workTurnClient.startFirstTurn).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("Do not lose this Work draft");
    expect(
      await screen.findByText(
        /The thread could not be created\. Selected provider is unavailable\./,
      ),
    ).toBeVisible();
  });

  it("follows the active Project with the live Context client and renders the authoritative inspector", async () => {
    const user = userEvent.setup();
    const contextApi: ContextClient = {
      inspect: vi.fn(async ({ subject }) => {
        const snapshot = contextFixture();
        return {
          ...snapshot,
          subject,
          displayLabel: "Octant",
          next: {
            ...snapshot.next,
            manifest: { ...snapshot.next.manifest, subject },
          },
          latestSent: {
            ...snapshot.latestSent!,
            manifest: { ...snapshot.latestSent!.manifest, subject },
          },
          capacity: { ...snapshot.capacity!, subject },
        } as never;
      }),
      execute: vi.fn(),
    };
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" }],
    });

    render(
      <App
        contextClient={contextApi}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await openSidebarProject(user, "Octant");
    await waitFor(() =>
      expect(contextApi.inspect).toHaveBeenCalledWith(
        {
          subject: { aggregateType: "project", aggregateId: projectId },
        },
        expect.any(AbortSignal),
      ),
    );
    expect(
      screen.getByRole("button", { name: /Open context inspector for Octant/i }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Context" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).getByRole("heading", { name: "Context inspector" })).toBeVisible();
    expect(within(dock).getByText("Safe input budget")).toBeVisible();
    expect(within(dock).getByText("Provider capacity")).toBeVisible();
  });

  it("keeps a context warning visible after its Project tab loses focus", async () => {
    const user = userEvent.setup();
    const contextApi: ContextClient = {
      inspect: vi.fn(async ({ subject }) => {
        const snapshot = contextFixture();
        return {
          ...snapshot,
          subject,
          next: {
            ...snapshot.next,
            manifest: { ...snapshot.next.manifest, subject },
            plan: { ...snapshot.next.plan, health: "watch" },
          },
          latestSent: {
            ...snapshot.latestSent!,
            manifest: { ...snapshot.latestSent!.manifest, subject },
          },
          capacity: { ...snapshot.capacity!, subject },
        } as never;
      }),
      execute: vi.fn(),
    };
    const value = projectBootstrap();
    const secondProject = { ...value.active[0]!, id: otherProjectId, name: "Other Repository" };

    render(
      <App
        contextClient={contextApi}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects({
          ...value,
          active: [...value.active, secondProject],
          availability: [
            { ...value.availability[0]!, status: "available" },
            { ...value.availability[0]!, projectId: otherProjectId, status: "available" },
          ],
        })}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await openSidebarProject(user, "Octant");
    expect(
      await screen.findByRole("button", {
        name: "Octant: Watch. Open context inspector.",
      }),
    ).toBeVisible();
    await openSidebarProject(user, "Other Repository");

    const warning = screen.getByRole("button", {
      name: "Octant: Watch. Open context inspector.",
    });
    expect(warning).toBeVisible();
    expect(screen.getByRole("tab", { name: "Octant" })).toHaveAttribute("aria-selected", "false");
    await user.click(warning);
    expect(await screen.findByRole("heading", { name: "Context inspector" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Octant" })).toHaveAttribute("aria-selected", "true");
  });

  it("previews and authoritatively commits a wide left-sidebar resize", async () => {
    const shellApi = client();
    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={shellApi}
      />,
    );
    expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
    const separator = screen.getByRole("separator", { name: "Resize navigation sidebar" });
    Object.assign(separator, {
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 232, pointerId: 30 });
    fireEvent.pointerMove(separator, { clientX: 300, pointerId: 30 });
    await waitFor(() =>
      expect(document.querySelector(".shell")).toHaveStyle({ "--octant-sidebar-width": "300px" }),
    );
    expect(shellApi.execute).not.toHaveBeenCalled();

    fireEvent.pointerUp(separator, { clientX: 300, pointerId: 30 });
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "replace-settings",
          settings: expect.objectContaining({ sidebarWidth: 300 }),
        }),
      ),
    );
    expect(document.querySelector(".shell")).toHaveStyle({ "--octant-sidebar-width": "300px" });
  });

  it("keeps the committed desktop width and omits horizontal resizing when responsive", async () => {
    render(
      <App
        isNarrow
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client({
          ...codeShellBootstrap(),
          settings: { ...settingsPastFirstRun(), sidebarWidth: 320 },
        })}
      />,
    );

    expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
    expect(screen.queryByRole("separator", { name: "Resize navigation sidebar" })).toBeNull();
    expect(document.querySelector(".shell")).toHaveStyle({ "--octant-sidebar-width": "320px" });
  });

  it("uses one validated Right Utility Dock host for the Project's own surfaces", async () => {
    const user = userEvent.setup();
    const value = projectBootstrap();
    const secondProject = { ...value.active[0]!, id: otherProjectId, name: "Other Repository" };
    const projectApi = projects({
      ...value,
      active: [...value.active, secondProject],
      availability: [
        { ...value.availability[0]!, status: "available" as const },
        { ...value.availability[0]!, projectId: otherProjectId, status: "available" as const },
      ],
    });
    const shellApi = client({
      ...codeShellBootstrap(),
      settings: { ...settingsPastFirstRun(), lastContextSurface: "project-memory" },
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    vi.mocked(projectApi.memory).mockResolvedValue({
      projectId,
      active: [
        {
          id: "00000000-0000-4000-8000-000000000882",
          projectId,
          kind: "fact",
          content: "Keep this Project's memory visible.",
          provenance: { kind: "user-authored" },
          author: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000881" },
          status: "active",
          version: 1,
          createdAt: "2026-08-11T09:00:00.000Z",
          updatedAt: "2026-08-11T09:00:00.000Z",
        },
      ],
      history: [],
    } as never);

    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={shellApi}
      />,
    );

    await openSidebarProject(user, "Octant");

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(await within(dock).findByText("Keep this Project's memory visible.")).toBeVisible();
    expect(document.querySelectorAll("#right-utility-dock")).toHaveLength(1);
    expect(document.querySelector("#environment-hub, #context-sidebar")).toBeNull();
    // The dock answers for a Project, so it never repeats the thread's own
    // environment: that lives beside the thread it describes.
    expect(within(dock).queryByText(readyEnvironment.repositoryRoot)).toBeNull();
    expect(within(dock).queryByRole("button", { name: "Code environment" })).toBeNull();
    expect(projectApi.memory).toHaveBeenCalledWith(projectId);

    await openSidebarProject(user, "Other Repository");
    expect(screen.getByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(screen.getByText("Keep this Project's memory visible.")).toBeVisible();
    expect(projectApi.memory).toHaveBeenCalledTimes(1);
  });

  it("opens memory for the invoking Chat Project instead of the globally active split", async () => {
    const user = userEvent.setup();
    const betaMemory = deferred<Awaited<ReturnType<ProjectClient["memory"]>>>();
    const firstChatProject = {
      id: projectId,
      type: "chat",
      name: "Project Alpha",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-08-11T09:00:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
    } as ProjectBootstrap["active"][number];
    const secondChatProject = {
      ...firstChatProject,
      id: otherProjectId,
      name: "Project Beta",
      rank: "1/1" as ProjectBootstrap["active"][number]["rank"],
    };
    const projectApi = projects({
      active: [firstChatProject, secondChatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn((requestedProjectId) => {
      if (String(requestedProjectId) === String(otherProjectId)) return betaMemory.promise;
      return Promise.resolve({
        projectId: requestedProjectId,
        active: Array.from({ length: 9 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          projectId: requestedProjectId,
          kind: "fact",
          content: `Memory ${index + 1}`,
          provenance: { kind: "user-authored" },
          author: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000801" },
          status: "active",
          version: 1,
          createdAt: "2026-08-11T09:00:00.000Z",
          updatedAt: "2026-08-11T09:00:00.000Z",
        })),
        history: [],
      } as never);
    });
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const withFirstProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000883" as never,
        projectId,
        mode: "chat",
        title: "Project Alpha",
      },
    });
    const withBothProjects = applyWorkspaceOperation(withFirstProject, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000884" as never,
        projectId: otherProjectId,
        mode: "chat",
        title: "Project Beta",
      },
    });
    const splitProjects = applyWorkspaceOperation(withBothProjects, {
      kind: "split-group",
      mode: "chat",
      groupId: layout.groupId,
      tabId: "00000000-0000-4000-8000-000000000884" as never,
      splitNodeId: "00000000-0000-4000-8000-000000000885" as never,
      newGroupNodeId: "00000000-0000-4000-8000-000000000886" as never,
      newGroupId: "00000000-0000-4000-8000-000000000887" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });

    render(
      <App
        chatClient={chats()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client({
          ...initial,
          workspace: splitProjects,
          workspaceVersion: splitProjects.version,
        })}
      />,
    );

    const alphaOverview = await screen.findByDisplayValue("Project Alpha");
    const alphaProject = alphaOverview.closest(".project-overview");
    if (!(alphaProject instanceof HTMLElement)) throw new Error("Expected Project Alpha overview.");
    const reviewAlphaMemory = await within(alphaProject).findByRole("button", {
      name: "Review memory",
    });
    vi.mocked(projectApi.memory).mockClear();
    await user.click(reviewAlphaMemory);

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(await within(dock).findByText("Project Alpha")).toBeVisible();
    await waitFor(() => expect(projectApi.memory).toHaveBeenCalledWith(projectId));

    const betaOverview = screen.getByDisplayValue("Project Beta").closest(".project-overview");
    if (!(betaOverview instanceof HTMLElement)) throw new Error("Expected Project Beta overview.");
    await user.click(within(betaOverview).getByRole("button", { name: "Review memory" }));

    expect(await within(dock).findByText("Project Beta")).toBeVisible();
    expect(within(dock).getByRole("button", { name: "Add memory" })).toBeDisabled();
    expect(within(dock).queryByText("Memory 1")).not.toBeInTheDocument();

    betaMemory.resolve({ projectId: otherProjectId, active: [], history: [] } as never);
    await waitFor(() =>
      expect(within(dock).getByRole("button", { name: "Add memory" })).toBeEnabled(),
    );
  });

  it("shows a Chat Project one threads list in its Overview and opens a thread from it", async () => {
    const user = userEvent.setup();
    const chatProject = {
      id: projectId,
      type: "chat",
      name: "Project Alpha",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-08-11T09:00:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
    } as ProjectBootstrap["active"][number];
    const projectApi = projects({
      active: [chatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(async (requestedProjectId) => ({
      projectId: requestedProjectId,
      active: [],
      history: [],
    }));
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const withProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000888" as never,
        projectId,
        mode: "chat",
        title: "Project Alpha",
      },
    });

    render(
      <App
        chatClient={chats({ threadProjectId: String(projectId) })}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client({
          ...initial,
          workspace: withProject,
          workspaceVersion: withProject.version,
        })}
      />,
    );

    // Chat Projects already carry their own threads list, which can create a
    // thread and expand the full list, so the shared section stands down and
    // the overview shows exactly one list rather than the same threads twice.
    const threads = await screen.findByRole("region", { name: "Active threads" });
    expect(
      screen.queryByRole("region", { name: /Threads and recent activity/ }),
    ).not.toBeInTheDocument();
    await user.click(within(threads).getByRole("button", { name: /Older chat/ }));

    expect(await screen.findByRole("tab", { name: "Older chat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps the owning Code Project active while a Code thread tab is selected", async () => {
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    const shell = codeShellBootstrap();

    render(
      <App
        codeClient={codes()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client({
          ...shell,
          settings: { ...shell.settings, lastContextSurface: "project-memory" },
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Controller foundation" }, { timeout: 5_000 }),
    ).toBeVisible();
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(
      await within(dock).findByRole("button", { name: "Project memory", pressed: true }),
    ).toBeVisible();
    expect(projectApi.memory).toHaveBeenCalledWith(projectId);
  });

  it("restores the saved dock surface for the active Project after restart", async () => {
    const user = userEvent.setup();
    const initial = codeShellBootstrap().workspace;
    const code = initial.layouts.code;
    if (code.kind !== "group") throw new Error("Default Code layout must be a group.");
    const restoredWorkspace = applyWorkspaceOperation(initial, {
      kind: "open-tab",
      mode: "code",
      groupId: code.groupId,
      tab: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000630" as never,
        projectId,
        mode: "code",
        title: "Octant",
      },
    });
    const value = projectBootstrap();
    const projectApi = projects({
      ...value,
      availability: [{ ...value.availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    const shellApi = client({
      ...bootstrap(),
      settings: { ...settingsPastFirstRun(), lastContextSurface: "project-memory" },
      workspace: restoredWorkspace,
      workspaceVersion: restoredWorkspace.version,
    });

    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={shellApi}
      />,
    );

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(
      await within(dock).findByRole("button", { name: "Project memory", pressed: true }),
    ).toBeVisible();
    expect(projectApi.memory).toHaveBeenCalledWith(projectId);
    await user.click(screen.getByRole("button", { name: "Close Project memory" }));
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "replace-settings",
          settings: expect.objectContaining({ lastContextSurface: null }),
        }),
      ),
    );
  });

  it("keeps Project context and the Right Utility Dock on the active split group", async () => {
    const initial = codeShellBootstrap().workspace;
    const code = initial.layouts.code;
    if (code.kind !== "group") throw new Error("Default Code layout must be a group.");
    const projectTabId = "00000000-0000-4000-8000-000000000631" as never;
    const withProject = applyWorkspaceOperation(initial, {
      kind: "open-tab",
      mode: "code",
      groupId: code.groupId,
      tab: {
        kind: "project",
        id: projectTabId,
        projectId,
        mode: "code",
        title: "Octant",
      },
    });
    const withSplitProject = applyWorkspaceOperation(withProject, {
      kind: "split-group",
      mode: "code",
      groupId: code.groupId,
      tabId: projectTabId,
      splitNodeId: "00000000-0000-4000-8000-000000000632" as never,
      newGroupNodeId: "00000000-0000-4000-8000-000000000633" as never,
      newGroupId: "00000000-0000-4000-8000-000000000634" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });
    const projectApi = projects();
    vi.mocked(projectApi.memory).mockResolvedValue({ projectId, active: [], history: [] });

    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client({
          ...codeShellBootstrap(),
          workspace: withSplitProject,
          workspaceVersion: withSplitProject.version,
        })}
      />,
    );

    expect(await screen.findByRole("button", { name: "Open Context" })).toBeVisible();
    expect(screen.getByRole("banner", { name: "Workspace actions for Octant" })).toBeVisible();
  });

  it("uses one narrow modal dock and restores focus through Escape dismissal", async () => {
    const user = userEvent.setup();
    const projectApi = projects();
    vi.mocked(projectApi.memory).mockResolvedValue({ projectId, active: [], history: [] });
    render(
      <App
        isNarrow
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await openSidebarProject(user, "Octant");
    const opener = screen.getByRole("button", { name: "Review Project memory" });
    await user.click(opener);

    expect(await screen.findByRole("dialog", { name: "Project memory" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(document.querySelectorAll(".octant-dialog__backdrop")).toHaveLength(1);
    expect(document.querySelectorAll(".octant-dialog__viewport")).toHaveLength(1);
    expect(document.querySelectorAll(".octant-dialog__popup")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Project memory" })).toBeNull();
  });

  it("does not disclose Code environment for Chat, Work, or no active Project", async () => {
    const user = userEvent.setup();
    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
    await openSidebarProject(user, "Octant");
    expect(screen.getByRole("button", { name: "Open Context" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Code environment" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review Project memory" }));
    expect(await screen.findByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Code environment" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Code environment/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.queryByRole("button", { name: /Code environment/i })).not.toBeInTheDocument();
  });

  it("treats the native minimum width as compact desktop chrome", async () => {
    const originalMatchMedia = window.matchMedia;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn(() => ({
      matches: true,
      media: "(max-width: 960px)",
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      render(
        <App
          launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
          projectClient={projects()}
          projectWindowCapability={projectWindowCapability}
          shellClient={client()}
        />,
      );

      expect(await screen.findByRole("button", { name: "More window actions" })).toBeVisible();
      expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 960px)");
      expect(document.querySelector(".shell")).toHaveStyle({
        "--octant-sidebar-width": "232px",
      });
      expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("integrates host-resolved material and honest top chrome actions", async () => {
    const user = userEvent.setup();
    let resolveMaterial: ((material: "translucent" | "opaque") => void) | undefined;
    const setSidebarMaterialPreference = vi.fn();
    const subscribeResolvedMaterial = vi.fn(
      (listener: (material: "translucent" | "opaque") => void) => {
        resolveMaterial = listener;
        return () => undefined;
      },
    );
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability: "C".repeat(43),
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference,
      subscribeResolvedMaterial,
    };
    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        shellClient={client(bootstrap())}
      />,
    );

    expect(await screen.findByRole("banner")).toHaveClass("window-chrome--material-opaque");
    expect(document.querySelector(".shell")).toHaveClass("shell--material-opaque");
    expect(
      screen.getByRole("status", { name: /^Host: This Mac · (Connected|Connecting)$/ }),
    ).toBeVisible();
    expect(document.querySelector(".window-chrome__identity")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Welcome to Chat" })).toBeVisible();
    expect(screen.getByRole("banner")).toHaveAccessibleName(
      "Workspace actions for Welcome to Chat",
    );

    await waitFor(() => expect(subscribeResolvedMaterial).toHaveBeenCalledOnce());
    expect(setSidebarMaterialPreference).toHaveBeenLastCalledWith("system");
    expect(subscribeResolvedMaterial.mock.invocationCallOrder[0]).toBeLessThan(
      setSidebarMaterialPreference.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER,
    );
    resolveMaterial?.("translucent");
    await waitFor(() =>
      expect(document.querySelector(".shell")).toHaveClass("shell--material-translucent"),
    );

    await openSettingsFromSidebar(user);
    expect(document.querySelector(".shell")).toHaveClass(
      "shell-frame--standalone",
      "shell--material-translucent",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Appearance" }));
    await user.click(screen.getByRole("switch", { name: "Translucent sidebar" }));
    await waitFor(() => expect(setSidebarMaterialPreference).toHaveBeenLastCalledWith("opaque"));
    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(document.querySelector(".shell")).toHaveClass("shell--material-opaque");

    await openSettingsFromSidebar(user);
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Reset native window bounds" }));
    expect(hostBridge.resetBounds).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
        "Native window bounds reset.",
      ),
    );
  });

  it("uses the CSS translucent sidebar fallback when no native host is available", async () => {
    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await screen.findByRole("button", { name: "Set your name" });
    await waitFor(() =>
      expect(document.querySelector(".shell")).toHaveClass("shell--material-translucent"),
    );
  });

  it("applies reduced transparency to the native sidebar material", async () => {
    const setSidebarVibrancyMode = vi.fn();
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      getHostCapabilities: () => ({ sidebarVibrancySupported: true }),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      setSidebarVibrancyMode,
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
    const themeClient = {
      bootstrap: vi.fn(async () => ({
        settings: {
          ...DEFAULT_THEME_SETTINGS,
          reducedTransparency: true,
          sidebarBackground: {
            kind: "preset" as const,
            presetId: "gradient-aurora" as never,
            overlayColor: "#0d0d0f" as never,
            overlayOpacity: 40 as never,
            vibrancyMode: "subtle" as const,
          },
        },
        version: 1 as never,
      })),
      execute: vi.fn(),
    };

    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(bootstrap())}
        themeClient={themeClient as never}
      />,
    );

    await waitFor(() => expect(themeClient.bootstrap).toHaveBeenCalledOnce());
    await waitFor(() => expect(setSidebarVibrancyMode).toHaveBeenLastCalledWith("off"));
    expect(document.querySelector("[data-octant-sidebar-background]")).not.toBeInTheDocument();
  });

  it("applies increased contrast to the rendered sidebar overlay", async () => {
    const themeClient = {
      bootstrap: vi.fn(async () => ({
        settings: {
          ...DEFAULT_THEME_SETTINGS,
          increasedContrast: true,
          sidebarBackground: {
            kind: "preset" as const,
            presetId: "gradient-aurora" as never,
            overlayColor: "#0d0d0f" as never,
            overlayOpacity: 20 as never,
            vibrancyMode: "subtle" as const,
          },
        },
        version: 1 as never,
      })),
      execute: vi.fn(),
    };

    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(bootstrap())}
        themeClient={themeClient as never}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector("[data-octant-sidebar-overlay]")).toHaveStyle({
        opacity: "0.8",
      }),
    );
  });

  it("routes menu-bar Start new agent through the ordinary workspace composer", async () => {
    let startNewAgent: (() => void) | undefined;
    const subscribeStartNewAgent = vi.fn((listener: () => void) => {
      startNewAgent = listener;
      return () => undefined;
    });
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
      subscribeStartNewAgent,
    };
    const shellApi = client(chatShellBootstrap());
    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        shellClient={shellApi}
      />,
    );

    await screen.findByRole("tab", { name: "Welcome to Chat" });
    await waitFor(() => expect(subscribeStartNewAgent).toHaveBeenCalled());
    await act(async () => startNewAgent?.());
    await waitFor(() =>
      expect(
        shellApi.execute.mock.calls.some(
          ([command]) =>
            command.kind === "apply-workspace-operation" &&
            command.operation.kind === "open-tab" &&
            command.operation.mode === "chat" &&
            command.operation.tab.kind === "draft-thread",
        ),
      ).toBe(true),
    );
  });

  it("consumes an Electron Project-window target once after Project bootstrap", async () => {
    const shellApi = client(bootstrap());
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      initialProjectTarget: { kind: "project", projectId: String(projectId) },
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      openInNewWindow: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };

    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        shellClient={shellApi}
      />,
    );

    await waitFor(() =>
      expect(
        shellApi.execute.mock.calls.some(
          ([command]) =>
            command.kind === "apply-workspace-operation" &&
            command.operation.kind === "open-tab" &&
            command.operation.tab.kind === "project" &&
            String(command.operation.tab.projectId) === String(projectId),
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      shellApi.execute.mock.calls.filter(
        ([command]) =>
          command.kind === "apply-workspace-operation" &&
          command.operation.kind === "open-tab" &&
          command.operation.tab.kind === "project",
      ),
    ).toHaveLength(1);
  });

  it("opens the exact Code thread carried by an Electron Project-window target", async () => {
    const shellApi = client(bootstrap());
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      initialProjectTarget: {
        kind: "project-thread",
        projectId: String(projectId),
        mode: "code",
        threadId: String(codeThreadId),
      },
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      openInNewWindow: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };

    render(
      <App
        codeClient={codes()}
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        shellClient={shellApi}
      />,
    );

    await waitFor(() =>
      expect(
        shellApi.execute.mock.calls.some(
          ([command]) =>
            command.kind === "apply-workspace-operation" &&
            command.operation.kind === "open-tab" &&
            command.operation.tab.kind === "code-overview" &&
            String(command.operation.tab.threadId) === String(codeThreadId),
        ),
      ).toBe(true),
    );
  });

  it("does not consume a Project-window target whose canonical thread belongs elsewhere", async () => {
    const shellApi = client(bootstrap());
    const available = projectBootstrap();
    const projectApi = projects({
      ...available,
      active: [
        ...available.active,
        { ...available.active[0]!, id: otherProjectId, name: "Other repository" },
      ],
    });
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      initialProjectTarget: {
        kind: "project-thread",
        projectId: String(otherProjectId),
        mode: "code",
        threadId: String(codeThreadId),
      },
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      openInNewWindow: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };

    render(
      <App
        codeClient={codes()}
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        shellClient={shellApi}
      />,
    );

    await waitFor(() => expect(projectApi.bootstrap).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      shellApi.execute.mock.calls.some(
        ([command]) =>
          command.kind === "apply-workspace-operation" &&
          command.operation.kind === "open-tab" &&
          command.operation.tab.kind === "code-overview" &&
          String(command.operation.tab.threadId) === String(codeThreadId),
      ),
    ).toBe(false);
  });

  it("bootstraps the durable shell and exposes the honest Project hierarchy", async () => {
    const user = userEvent.setup();
    const codeApi = codes();
    const readyCodeBootstrap = await codeApi.bootstrap();
    const readyCodeThread = await codeApi.thread(codeThreadId);
    const codeBootstrap = deferred<Awaited<ReturnType<CodeClient["bootstrap"]>>>();
    const codeThread = deferred<Awaited<ReturnType<CodeClient["thread"]>>>();
    codeApi.bootstrap = vi.fn(() => codeBootstrap.promise);
    codeApi.thread = vi.fn(() => codeThread.promise);
    const projectApi = projects();
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(async () => ({
        kind: "selected" as const,
        receiptId: bindingReceipt,
        displayName: "Documents",
      })),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
    render(
      <App
        codeClient={codeApi}
        hostBridge={hostBridge}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        shellClient={client()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading Octant workspace");
    expect(await screen.findByRole("button", { name: "Code" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.querySelector(".shell")).toHaveStyle({
      "--octant-sidebar-width": "232px",
    });
    expect(document.querySelector(".shell")?.getAttribute("style")).not.toMatch(
      /grid-template-columns/i,
    );
    const sidebar = screen.getByRole("complementary");
    expect(sidebar).toHaveClass("sidebar");
    expect(document.querySelectorAll(".shell-frame")).toHaveLength(1);
    expect(document.querySelector(".shell-frame")?.children[0]).toBe(screen.getByRole("banner"));
    expect(document.querySelector(".shell-frame")?.children[1]).toBe(sidebar);
    expect(document.querySelector(".shell-frame")?.children[2]).toHaveClass(
      "shell-frame__sidebar-resize",
    );
    expect(document.querySelector(".shell-frame")?.children[3]).toHaveClass("workspace-layer");
    expect(sidebar).not.toHaveClass("window-drag-region");
    expect(sidebar.querySelector(".sidebar__drag-surface")).toHaveClass("window-drag-region");
    expect(sidebar.querySelector(".sidebar__content")).toHaveClass("window-no-drag");
    expect(within(sidebar).getByRole("group", { name: "Workspace mode" })).toHaveClass(
      "window-no-drag",
    );
    expect(within(sidebar).getByRole("button", { name: "Search" })).toHaveClass("window-no-drag");
    expect(within(sidebar).getByRole("button", { name: "Search" })).toHaveClass(
      "shell-icon-button",
    );
    expect(within(sidebar).getByRole("button", { name: "Set your name" })).toHaveClass(
      "window-no-drag",
    );
    expect(within(sidebar).getByRole("button", { name: "Set your name" })).toHaveClass(
      "sidebar-profile__trigger",
    );
    for (const button of within(sidebar).getAllByRole("button")) {
      expect(button).toHaveClass("window-no-drag");
    }
    expect(await screen.findByRole("button", { name: "Project actions for Octant" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New thread" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Plugins" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Thread board" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Pull requests" })).toBeVisible();
    const addFolder = screen.getByRole("button", { name: "Add folder" });
    expect(addFolder).toHaveClass("project-section__add");
    expect(addFolder).not.toHaveTextContent("Add folder");
    expect(
      addFolder.compareDocumentPosition(screen.getByRole("heading", { name: "Projects" })),
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    screen.getByRole("button", { name: "Project actions for Octant" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");
    expect(screen.getByText("Relink required")).toBeVisible();
    await act(async () => {
      codeBootstrap.resolve(readyCodeBootstrap);
      codeThread.resolve(readyCodeThread);
    });
    expect(await screen.findByRole("button", { name: /Pull requests/i })).toBeVisible();
    expect(await screen.findByRole("button", { name: "New thread" })).toBeVisible();
    expect(
      await screen.findByPlaceholderText("Ask for follow-up changes…", {}, { timeout: 5_000 }),
    ).toBeVisible();

    await openSidebarProject(user, "Octant");
    expect(await screen.findByRole("tab", { name: "Octant" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Relink required");
    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(hostBridge.selectProjectRoot).toHaveBeenCalledWith("code");
    expect(projectApi.executeProject).toHaveBeenCalledWith({
      kind: "relink-project",
      projectId,
      expectedVersion: 1,
      receiptId: bindingReceipt,
    });
    expect(document.body).not.toHaveTextContent("/private/unvalidated-selection");

    // Search is now the mode-scoped thread overlay, not Project search:
    // it names the active mode so a user can never mistake which set is listed.
    await user.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("dialog", { name: "Search Code threads" });
    expect(search).toBeVisible();
    expect(within(search).getByRole("combobox", { name: "Search Code threads" })).toBeVisible();
    expect(
      within(search).getByRole("listbox", { name: "Code thread results" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search Code threads" })).toBeNull();
  }, 15_000);

  it("lists an archived Chat thread the host search reports in the Archived group", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    vi.mocked(chatApi.search).mockResolvedValue([archivedChatThread()]);
    render(
      <App
        chatClient={chatApi}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Search" }));
    await user.type(screen.getByRole("combobox", { name: "Search Chat threads" }), "Retired");

    // The Chat bootstrap is deliberately active-only, so the Archived group can
    // only ever be filled by the host's own lifecycle-spanning thread search.
    const archived = await screen.findByRole("group", { name: "Archived" });
    expect(within(archived).getByRole("option", { name: /Retired chat/ })).toBeVisible();
    expect(chatApi.search).toHaveBeenCalledWith("Retired");
  });

  it("never reports a loading or unavailable archived listing as an empty Archived group", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const pending = deferred<ReadonlyArray<ChatThread>>();
    vi.mocked(chatApi.search).mockReturnValue(pending.promise);
    render(
      <App
        chatClient={chatApi}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Search" }));
    await user.type(screen.getByRole("combobox", { name: "Search Chat threads" }), "Retired");

    expect(
      await screen.findByText(
        "Archived threads are still loading, so the Archived group may be incomplete.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();

    await act(async () => {
      pending.reject(new Error("Chat search is unavailable."));
      await Promise.resolve();
    });

    expect(
      await screen.findByText(
        "Archived threads are unavailable, so no Archived group can be shown.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();
  });

  it("opens a search hit from a non-active Project with the thread's own Project", async () => {
    const user = userEvent.setup();
    const bound = codeShellBootstrap();
    const shellApi = client({
      ...bound,
      workspace: {
        ...bound.workspace,
        contextByMode: {
          ...bound.workspace.contextByMode,
          code: { ...bound.workspace.contextByMode.code, projectId: otherProjectId },
        },
      },
    });
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Search" }));
    await user.type(screen.getByRole("combobox", { name: "Search Code threads" }), "Controller");
    await user.click(await screen.findByRole("option", { name: /Controller foundation/ }));

    // The hit's thread lives in "Octant" while this window's Code context is
    // bound to another Project, so the open must carry the thread's Project and
    // dispatch the Project switch rather than a plain open the server-side
    // workspace policy would reject.
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: "switch-project-tab",
            mode: "code",
            tab: expect.objectContaining({ threadId: codeThreadId }),
          }),
        }),
      ),
    );
  });

  it("opens a palette thread command from a non-active Project with the thread's own Project", async () => {
    const user = userEvent.setup();
    const bound = codeShellBootstrap();
    const shellApi = client({
      ...bound,
      workspace: {
        ...bound.workspace,
        contextByMode: {
          ...bound.workspace.contextByMode,
          code: { ...bound.workspace.contextByMode.code, projectId: otherProjectId },
        },
      },
    });
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );
    await screen.findByRole("heading", { name: "Controller foundation" });

    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("Controller");
    await user.click(await screen.findByRole("option", { name: /Open Controller foundation/ }));

    // The palette entry keeps the thread's own Project exactly like a search
    // hit, so the cross-Project open dispatches the Project switch instead of
    // a plain open the server-side workspace policy would reject.
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: "switch-project-tab",
            mode: "code",
            tab: expect.objectContaining({ threadId: codeThreadId }),
          }),
        }),
      ),
    );
  });

  it("fails closed when the renderer Project capability is missing", () => {
    render(
      <App launch={{ serverUrl: "http://127.0.0.1:13773", windowId }} shellClient={client()} />,
    );
    expect(
      screen.getByRole("heading", { name: /Project authority is unavailable/i }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Code" })).not.toBeInTheDocument();
  });

  it("keeps native picker cancellation and raw paths out of Project creation state", async () => {
    const user = userEvent.setup();
    const projectApi = projects();
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(async () => ({ kind: "cancelled" as const })),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        shellClient={client()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Add folder" }));

    await waitFor(() => expect(hostBridge.selectProjectRoot).toHaveBeenCalledWith("code"));
    expect(projectApi.executeProject).not.toHaveBeenCalled();
    expect(screen.getByText("Project creation cancelled.")).toBeVisible();
    expect(document.body).not.toHaveTextContent("/private/unvalidated-selection");
  });

  it("renders an unavailable placeholder restored by the server bootstrap", async () => {
    const restored = codeShellBootstrap();
    const code = restored.workspace.layouts.code;
    if (code.kind !== "group") throw new Error("default code layout must be a group");
    const recoveredTab = {
      kind: "unavailable" as const,
      id: code.tabs[0]!.id,
      title: "Recovered editor",
      reason: "This tab type is unavailable in this version of Octant.",
    };
    const recovered: ShellBootstrap = {
      ...restored,
      workspace: {
        ...restored.workspace,
        layouts: {
          ...restored.workspace.layouts,
          code: { ...code, tabs: [recoveredTab], activeTabId: recoveredTab.id },
        },
      },
    };

    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(recovered)}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Recovered editor" })).toBeVisible();
    expect(
      screen.getByText("This tab type is unavailable in this version of Octant."),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Recovered editor" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens implemented settings and deep-links search results to focused controls", async () => {
    const user = userEvent.setup();
    const providerApi = providers();
    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providerApi}
        shellClient={client()}
      />,
    );

    const activeTabId = (await screen.findByRole("tab", { selected: true })).getAttribute(
      "data-workspace-tab-id",
    );
    await openSettingsFromSidebar(user);
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Settings sidebar" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Welcome to Chat" })).not.toBeInTheDocument();
    expect(document.querySelector(".settings-view")).toBeVisible();
    // General is the default section; Chat/Work toggles are visible there.
    expect(screen.getByRole("switch", { name: "Enable Chat" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Enable Work" })).toBeVisible();
    expect(providerApi.bootstrap).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.queryByRole("region", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-workspace-tab-id",
      activeTabId,
    );

    await openSettingsFromSidebar(user);
    await screen.findByRole("searchbox", { name: "Search settings" });

    // Search is navigation: typing "material" shows a result list, and
    // selecting the Translucent sidebar result deep-links to Appearance.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "material");
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(screen.getByRole("switch", { name: "Translucent sidebar" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Enable Chat" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("listbox", { name: "Settings search results" }),
    ).not.toBeInTheDocument();

    // Search "mode switcher" and deep-link to the control, then mutate it.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "mode switcher");
    const modeListbox = screen.getByRole("listbox", { name: "Settings search results" });
    modeListbox.focus();
    fireEvent.keyDown(modeListbox, { key: "ArrowDown" });
    fireEvent.keyDown(modeListbox, { key: "Enter" });
    await user.selectOptions(screen.getByLabelText("Mode switcher"), "dropdown");
    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(await screen.findByRole("button", { name: "Workspace mode, Code" })).toBeVisible();
    await openSettingsFromSidebar(user);
    await screen.findByRole("searchbox", { name: "Search settings" });

    // Search "providers" and deep-link to the Providers & Models section.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "providers");
    const providersListbox = screen.getByRole("listbox", { name: "Settings search results" });
    providersListbox.focus();
    fireEvent.keyDown(providersListbox, { key: "ArrowDown" });
    fireEvent.keyDown(providersListbox, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Providers" })).toBeVisible();
    expect(screen.getByLabelText("Permission persistence")).toHaveValue("current-session");

    // Keyword search still routes to the Providers section.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "OpenCode");
    const openCodeListbox = screen.getByRole("listbox", { name: "Settings search results" });
    openCodeListbox.focus();
    fireEvent.keyDown(openCodeListbox, { key: "ArrowDown" });
    fireEvent.keyDown(openCodeListbox, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Providers" })).toBeVisible();
  }, 15_000);

  it("renders recovery-required separately from a disconnected shell", async () => {
    const recoveryClient = client();
    recoveryClient.bootstrap.mockRejectedValueOnce({
      category: "recovery-required",
      message: "Storage recovery is required.",
    });
    const { rerender } = render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={recoveryClient}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Storage recovery required" })).toBeVisible();

    const disconnectedClient = client();
    disconnectedClient.bootstrap.mockRejectedValueOnce({
      category: "unavailable",
      message: "Shell unavailable.",
    });
    rerender(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={disconnectedClient}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Octant is disconnected" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Shell unavailable.");
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry connection" })).toHaveClass(
      "shell-state__action",
    );
  });

  it("renders orientation and preview ratio as geometry and commits resize only on release", () => {
    const callbacks = splitCallbacks();
    const { rerender } = render(
      <SplitWorkspace {...callbacks} layout={splitLayout()} renderTab={(tab) => tab.title} />,
    );
    const horizontal = screen.getByRole("group", { name: "horizontal workspace split" });
    expect(horizontal).toHaveStyle({
      display: "grid",
      gridTemplateColumns: "minmax(0, 0.3fr) auto minmax(0, 0.7fr)",
      height: "100%",
      minHeight: "0",
      minWidth: "0",
      width: "100%",
    });

    const resize = screen.getByRole("slider", { name: "Resize split" });
    expect(resize).toHaveClass("workspace-split__resize-input");
    expect(resize.closest("label")).toHaveClass("workspace-split__resize");
    fireEvent.change(resize, { target: { value: "0.7" } });
    expect(callbacks.onPreviewResize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000610",
      0.7,
    );
    expect(callbacks.onCommitResize).not.toHaveBeenCalled();

    rerender(
      <SplitWorkspace
        {...callbacks}
        layout={splitLayout("vertical", 0.6)}
        renderTab={(tab) => tab.title}
      />,
    );
    const vertical = screen.getByRole("group", { name: "vertical workspace split" });
    expect(vertical).toHaveStyle({
      display: "grid",
      gridTemplateRows: "minmax(0, 0.6fr) auto minmax(0, 0.4fr)",
    });
    Object.assign(vertical, {
      getBoundingClientRect: () => ({ height: 600, left: 0, top: 0, width: 800 }),
    });
    const verticalResize = screen.getByRole("slider", { name: "Resize split" }).closest("label")!;
    fireEvent.pointerDown(verticalResize, { button: 0, clientY: 360, pointerId: 51 });
    fireEvent.pointerMove(verticalResize, { clientY: 420, pointerId: 51 });
    fireEvent.pointerUp(verticalResize, { clientY: 420, pointerId: 51 });
    expect(callbacks.onCommitResize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000610",
      0.7,
    );
  });

  it("wires rendered tab, split, move, resize, focus, and reset controls", async () => {
    const user = userEvent.setup();
    const callbacks = splitCallbacks();
    const { unmount } = render(
      <SplitWorkspace {...callbacks} layout={splitLayout()} renderTab={(tab) => tab.title} />,
    );

    const closeSecond = screen.getByRole("button", { name: "Close Second" });
    expect(screen.getByRole("tab", { name: "Second" })).toHaveClass("workspace-tab");
    expect(closeSecond).toHaveClass("workspace-tab__action");
    expect(screen.queryByRole("button", { name: "Move Second left" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split Second below" })).not.toBeInTheDocument();
    closeSecond.focus();
    await user.keyboard("{Enter}");
    expect(callbacks.onClose).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000612",
      "00000000-0000-4000-8000-000000000614",
    );
    await user.click(screen.getByRole("button", { name: "Tab actions for Second" }));
    await user.click(screen.getByRole("button", { name: "Move Second left" }));
    expect(callbacks.onReorder).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000612",
      "00000000-0000-4000-8000-000000000614",
      0,
    );
    await user.click(screen.getByRole("button", { name: "Tab actions for Second" }));
    await user.click(screen.getByRole("button", { name: "Split Second below" }));
    expect(callbacks.onSplit).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000612",
      "00000000-0000-4000-8000-000000000614",
      "vertical",
      "after",
    );
    await user.click(screen.getByRole("button", { name: "Pane actions for First" }));
    await user.click(screen.getByRole("button", { name: "Move active tab to next group" }));
    expect(callbacks.onMove).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Pane actions for First" }));
    await user.click(screen.getByRole("button", { name: "Focus this group" }));
    expect(callbacks.onFocus).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000612");
    fireEvent.change(screen.getByRole("slider", { name: "Resize split" }), {
      target: { value: "0.6" },
    });
    expect(callbacks.onPreviewResize).toHaveBeenCalled();
    unmount();

    const onResetLayout = vi.fn();
    render(
      <SettingsView
        nativeBoundsAvailable={false}
        onResetLayout={onResetLayout}
        onResetNativeBounds={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        search=""
        settings={settingsPastFirstRun()}
        sidebarVibrancySupported={false}
        visibleSettings={["reset-layout"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Reset active mode layout" }));
    expect(onResetLayout).toHaveBeenCalledOnce();
  });

  it("assigns the settings surface an explicit visual class contract", () => {
    const onSettingsChange = vi.fn();
    render(
      <SettingsView
        nativeBoundsAvailable
        onResetLayout={vi.fn()}
        onResetNativeBounds={vi.fn()}
        onBack={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        search=""
        settings={settingsPastFirstRun()}
        sidebarVibrancySupported={false}
        visibleSettings={[
          "enable-chat",
          "enable-work",
          "sidebar-width",
          "sidebar-material",
          "mode-switcher",
          "reset-layout",
          "reset-window-bounds",
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "Settings" })).toHaveClass("settings-view");
    expect(screen.getByRole("complementary", { name: "Settings sidebar" })).toHaveClass(
      "settings-view__sidebar",
    );
    expect(screen.getByRole("button", { name: "Back to app" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveClass(
      "settings-view__text-input",
    );
    expect(screen.getByRole("switch", { name: "Enable Chat" })).toHaveClass("octant-switch");
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("slider", { name: "Sidebar width" })).toHaveClass(
      "settings-view__range",
    );
    expect(screen.getByRole("switch", { name: "Translucent sidebar" })).toHaveClass(
      "octant-switch",
    );
    expect(screen.getByRole("combobox", { name: "Mode switcher" })).toHaveValue("buttons");
    fireEvent.change(screen.getByRole("combobox", { name: "Mode switcher" }), {
      target: { value: "dropdown" },
    });
    expect(onSettingsChange).toHaveBeenCalledWith({ modeSwitcherPresentation: "dropdown" });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Reset active mode layout" })).toHaveClass(
      "settings-view__action",
    );
    expect(screen.getByRole("button", { name: "Reset native window bounds" })).toHaveClass(
      "settings-view__action",
    );
  });

  it("re-announces the same keyboard action with a monotonically newer live event", async () => {
    const user = userEvent.setup();
    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(bootstrap())}
      />,
    );
    const tab = await screen.findByRole("tab", { name: "Welcome to Chat" });
    tab.focus();
    await user.keyboard("{Enter}");
    const liveRegion = document.querySelector('[aria-live="polite"]');
    await waitFor(() => expect(liveRegion).toHaveAttribute("data-announcement-sequence", "1"));
    expect(liveRegion).toHaveClass("sr-only");
    expect(liveRegion).toHaveStyle({ position: "absolute", width: "1px" });
    expect(liveRegion).toHaveTextContent("Tab activated. Event 1.");
    expect(screen.getByText("Event 1.")).toHaveStyle({ position: "absolute", width: "1px" });

    await user.keyboard("{Enter}");
    await waitFor(() => expect(liveRegion).toHaveAttribute("data-announcement-sequence", "2"));
    expect(liveRegion).toHaveTextContent("Tab activated.");
  });
});

describe("Project renderer flows", () => {
  function hostBridge(selectProjectRoot: OctantHostBridge["selectProjectRoot"]): OctantHostBridge {
    return {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot,
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
  }

  function codeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
    return { ...projectBootstrap().active[0]!, ...overrides } as ProjectSummary;
  }

  it("creates Chat directly without invoking the native picker", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(vi.fn());
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="chat"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByLabelText("Project name"), "Research");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(bridge.selectProjectRoot).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith("chat", "Research", undefined);
    expect(onCreated).toHaveBeenCalledWith(projectId, "chat", "Research");
  });

  it("creates Work with only the native opaque receipt", async () => {
    const bridge = hostBridge(
      vi.fn(async () => ({
        kind: "selected" as const,
        receiptId: bindingReceipt,
        displayName: "Documents",
      })),
    );
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="work"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalledWith("work"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("work", "Documents", bindingReceipt));
    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(JSON.stringify(onCreate.mock.calls)).not.toContain("canonicalRoot");
  });

  it("redacts native picker rejection details", async () => {
    const bridge = hostBridge(
      vi.fn(async () => {
        throw new Error("/private/secret/path desktop-token");
      }),
    );
    const onCreate = vi.fn();
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Project creation could not be completed.")).toBeVisible(),
    );
    expect(document.body).not.toHaveTextContent("/private/secret/path");
    expect(document.body).not.toHaveTextContent("desktop-token");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not submit or open after unmount while the native picker is pending", async () => {
    const selection = deferred<{
      readonly kind: "selected";
      readonly receiptId: string;
      readonly displayName: string;
    }>();
    const bridge = hostBridge(vi.fn(() => selection.promise));
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    const view = render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalled());
    view.unmount();

    await act(async () =>
      selection.resolve({ kind: "selected", receiptId: bindingReceipt, displayName: "Documents" }),
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("keeps Cancel usable while creation is in flight and ignores the late result", async () => {
    const command = deferred<typeof projectId>();
    const bridge = hostBridge(
      vi.fn(async () => ({
        kind: "selected" as const,
        receiptId: bindingReceipt,
        displayName: "Documents",
      })),
    );
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const view = render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={onClose}
        onCreate={vi.fn(() => command.promise)}
        onCreated={onCreated}
      />,
    );
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalled());
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close new Project" })).toBeEnabled();
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => command.resolve(projectId));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows an unavailable archived binding honestly without mutation actions", () => {
    render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectOverview
          availability={projectBootstrap().availability[0]!}
          hostBridge={hostBridge(vi.fn())}
          onArchive={vi.fn()}
          onRelink={vi.fn()}
          onRename={vi.fn()}
          project={codeProject({ lifecycle: "archived" })}
        />
      </ProjectMemoryInspectorProvider>,
    );

    expect(screen.getByText(/Archived Project · read-only/i)).toBeVisible();
    expect(screen.getByText("Repository moved.")).toBeVisible();
    expect(screen.queryByText("Available")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review Project memory" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose new root" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Project" })).not.toBeInTheDocument();
  });

  it("uses compact flat workspace controls without dashboard cards or capability claims", () => {
    const project = codeProject();
    if (project.type !== "code") throw new Error("Expected a Code Project.");
    render(
      <ProjectMemoryInspectorProvider onOpen={vi.fn()}>
        <ProjectOverview
          availability={projectBootstrap().availability[0]!}
          hostBridge={hostBridge(vi.fn())}
          onArchive={vi.fn()}
          onRelink={vi.fn()}
          onRename={vi.fn()}
          project={project}
        />
      </ProjectMemoryInspectorProvider>,
    );

    const overview = document.querySelector<HTMLElement>(".project-overview");
    expect(overview).not.toBeNull();
    expect(overview?.querySelector(".project-overview__toolbar")).toBeInTheDocument();
    expect(overview?.querySelector(".project-overview__context")).toBeInTheDocument();
    expect(overview?.querySelector(".project-overview__actions")).toBeInTheDocument();
    expect(overview?.querySelector(".project-binding")).not.toBeInTheDocument();
    expect(overview?.querySelector('[class*="project-memory-summary"]')).not.toBeInTheDocument();
    expect(overview?.querySelector(".project-empty-state")).not.toBeInTheDocument();
    expect(styles).not.toContain(".project-memory-summary");
    expect(styles).not.toMatch(/\.project-(?:binding|memory-summary|empty-state)(?:\W|$)/);

    expect(within(overview!).getByText("Code Project")).toBeVisible();
    expect(within(overview!).getByText(project.binding.canonicalRoot)).toBeVisible();
    expect(within(overview!).getByText("Relink required")).toBeVisible();
    expect(within(overview!).getByText("Repository moved.")).toBeVisible();
    expect(within(overview!).getByRole("button", { name: "Choose new root" })).toBeVisible();
    expect(within(overview!).getByRole("button", { name: "Review Project memory" })).toBeVisible();
    expect(within(overview!).getByRole("button", { name: "Archive Project" })).toBeVisible();
    for (const heading of within(overview!).getAllByRole("heading")) {
      expect(Number(heading.tagName.slice(1))).toBeLessThanOrEqual(2);
    }
    expect(overview).not.toHaveTextContent(/\b(?:threads?|runtimes?)\b/i);
  });

  it("keeps Project rename in a compact labeled control on submit and blur", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => true);
    render(
      <ProjectOverview
        onArchive={vi.fn()}
        onRelink={vi.fn()}
        onRename={onRename}
        project={codeProject()}
      />,
    );

    const name = screen.getByRole("textbox", { name: "Project name" });
    expect(name).toHaveClass("project-overview__name");
    await user.clear(name);
    await user.type(name, "Compact repository{Enter}");
    expect(onRename).toHaveBeenLastCalledWith(projectId, "Compact repository");

    await user.clear(name);
    await user.type(name, "Blurred repository");
    await user.tab();
    expect(onRename).toHaveBeenLastCalledWith(projectId, "Blurred repository");
    expect(onRename).toHaveBeenCalledTimes(2);
  });

  it("does not relink after cancellation and keeps the Project ID", async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    render(
      <ProjectOverview
        availability={projectBootstrap().availability[0]!}
        hostBridge={hostBridge(vi.fn(async () => ({ kind: "cancelled" as const })))}
        onArchive={vi.fn()}
        onRelink={onRelink}
        onRename={vi.fn()}
        project={codeProject()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(onRelink).not.toHaveBeenCalled();
    expect(screen.getByText("Relink cancelled.")).toBeVisible();
    expect(screen.getByLabelText("Project name")).toHaveAttribute(
      "id",
      `project-name-${projectId}`,
    );
  });

  it("redacts relink picker errors and issues no command", async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    render(
      <ProjectOverview
        availability={projectBootstrap().availability[0]!}
        hostBridge={hostBridge(
          vi.fn(async () => {
            throw new Error("/private/new-root bridge-secret");
          }),
        )}
        onArchive={vi.fn()}
        onRelink={onRelink}
        onRename={vi.fn()}
        project={codeProject()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(screen.getByText("Project root could not be relinked.")).toBeVisible();
    expect(document.body).not.toHaveTextContent("/private/new-root");
    expect(document.body).not.toHaveTextContent("bridge-secret");
    expect(onRelink).not.toHaveBeenCalled();
  });

  it("abandons a pending relink picker when the active Project changes", async () => {
    const user = userEvent.setup();
    const selection = deferred<{
      readonly kind: "selected";
      readonly receiptId: string;
      readonly displayName: string;
    }>();
    const bridge = hostBridge(vi.fn(() => selection.promise));
    const onRelink = vi.fn(async () => true);
    const props = {
      availability: projectBootstrap().availability[0]!,
      hostBridge: bridge,
      onArchive: vi.fn(),
      onRelink,
      onRename: vi.fn(),
    };
    const view = render(<ProjectOverview {...props} project={codeProject()} />);

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    view.rerender(
      <ProjectOverview
        {...props}
        project={codeProject({
          id: decodeProjectId("00000000-0000-4000-8000-000000000898"),
          name: "Different Project",
        })}
      />,
    );
    await act(async () =>
      selection.resolve({ kind: "selected", receiptId: bindingReceipt, displayName: "Documents" }),
    );

    expect(onRelink).not.toHaveBeenCalled();
    expect(screen.queryByText("Project root relinked.")).not.toBeInTheDocument();
    expect(screen.queryByText("Relink cancelled.")).not.toBeInTheDocument();
  });

  it("lets a dispatched relink finish but suppresses abandoned Project status", async () => {
    const user = userEvent.setup();
    const command = deferred<boolean>();
    const onRelink = vi.fn(() => command.promise);
    const props = {
      availability: projectBootstrap().availability[0]!,
      hostBridge: hostBridge(
        vi.fn(async () => ({
          kind: "selected" as const,
          receiptId: bindingReceipt,
          displayName: "Documents",
        })),
      ),
      onArchive: vi.fn(),
      onRelink,
      onRename: vi.fn(),
    };
    const view = render(<ProjectOverview {...props} project={codeProject()} />);

    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(onRelink).toHaveBeenCalledWith(projectId, bindingReceipt);
    view.rerender(
      <ProjectOverview
        {...props}
        project={codeProject({
          id: decodeProjectId("00000000-0000-4000-8000-000000000897"),
          name: "Different Project",
        })}
      />,
    );
    await act(async () => command.resolve(true));

    expect(onRelink).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Project root relinked.")).not.toBeInTheDocument();
    expect(screen.queryByText("Relink cancelled.")).not.toBeInTheDocument();
  });
});
