import { describe, expect, it } from "vitest";
import {
  MAX_SIDEBAR_WIDTH,
  MAX_SPLIT_RATIO,
  MIN_SIDEBAR_WIDTH,
  MIN_SPLIT_RATIO,
  decodeEnvironmentCompactIdentity,
  decodeEnvironmentPresentationState,
  decodeEnvironmentTabPresentation,
  decodeShellBootstrap,
  decodeShellCommand,
  decodeShellCommandResult,
  decodeShellFailure,
  decodeShellSettings,
  decodeShellSettingsReplaced,
  decodeWindowWorkspace,
  decodeWorkspaceContextKey,
  decodeWorkspaceLayoutReplaced,
  decodeWorkspaceSurfaceCatalog,
  decodeWorkspaceTab,
} from "./shell";
import { MAX_AVATAR_IMAGE_CHARACTERS } from "./userProfile";

const ids = {
  window: "11111111-1111-4111-8111-111111111111",
  chatNode: "22222222-2222-4222-8222-222222222222",
  chatPane: "33333333-3333-4333-8333-333333333333",
  chatTab: "44444444-4444-4444-8444-444444444444",
  workNode: "55555555-5555-4555-8555-555555555555",
  workPane: "66666666-6666-4666-8666-666666666666",
  workTab: "77777777-7777-4777-8777-777777777777",
  codeSplit: "88888888-8888-4888-8888-888888888888",
  codeNodeA: "99999999-9999-4999-8999-999999999999",
  codePaneA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  codeTabA: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  codeNodeB: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  codePaneB: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  codeTabB: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  newNode: "12121212-1212-4212-8212-121212121212",
  newPane: "13131313-1313-4313-8313-131313131313",
  newTab: "14141414-1414-4414-8414-141414141414",
  newPaneNode: "15151515-1515-4515-8515-151515151515",
  project: "16161616-1616-4616-8616-161616161616",
  thread: "17171717-1717-4717-8717-171717171717",
} as const;

const settings = {
  chatEnabled: true,
  workEnabled: false,
  sidebarWidth: 280,
  contextSidebarWidth: 360,
  lastContextSurface: "project-memory",
  sidebarMaterial: "system",
  modeSwitcherPresentation: "dropdown",
  projectViewSwitcherPresentation: "dropdown",
  sidebarBackground: {
    kind: "none",
    overlayColor: "#1a1a1c",
    overlayOpacity: 100,
    vibrancyMode: "off",
  },
  environmentPresentationByMode: { chat: "hidden", work: "floating", code: "floating" },
  firstRunOnboarding: "pending",
  automaticUpdateChecks: true,
  navigatorAssistant: {},
  userProfile: { accent: "indigo", avatar: { kind: "initials" } },
} as const;

const pane = (nodeId: string, paneId: string, surface: object) => ({
  kind: "pane",
  nodeId,
  paneId,
  surface,
});

const workspace = {
  windowId: ids.window,
  activeMode: "code",
  layouts: {
    chat: pane(ids.chatNode, ids.chatPane, {
      kind: "welcome",
      id: ids.chatTab,
      mode: "chat",
      title: "Chat",
    }),
    work: pane(ids.workNode, ids.workPane, {
      kind: "welcome",
      id: ids.workTab,
      mode: "work",
      title: "Work",
    }),
    code: {
      kind: "split",
      nodeId: ids.codeSplit,
      orientation: "horizontal",
      ratio: 0.5,
      first: pane(ids.codeNodeA, ids.codePaneA, {
        kind: "welcome",
        id: ids.codeTabA,
        mode: "code",
        title: "Code",
      }),
      second: pane(ids.codeNodeB, ids.codePaneB, {
        kind: "settings",
        id: ids.codeTabB,
        title: "Settings",
      }),
    },
  },
  activePaneIds: {
    chat: ids.chatPane,
    work: ids.workPane,
    code: ids.codePaneA,
  },
  contextByMode: {
    chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
    work: { host: "local", mode: "work", projectId: null, boundRoot: null },
    code: { host: "local", mode: "code", projectId: null, boundRoot: null },
  },
  focusedPaneId: ids.codePaneA,
  version: 7,
} as const;

const presentationState = {
  byTab: [{ tabId: ids.codeTabA, presentation: "hidden" }],
  byMode: { chat: "hidden", work: "floating", code: "floating" },
} as const;

describe("shell bootstrap contracts", () => {
  it("accepts only supported mode-switcher presentations", () => {
    expect(decodeShellSettings({ ...settings, modeSwitcherPresentation: "buttons" })).toMatchObject(
      { modeSwitcherPresentation: "buttons" },
    );
    expect(decodeShellSettings(settings).modeSwitcherPresentation).toBe("dropdown");
    expect(() => decodeShellSettings({ ...settings, modeSwitcherPresentation: "tabs" })).toThrow();
    const { projectViewSwitcherPresentation: _omitted, ...withoutProjectViewSwitcher } = settings;
    expect(decodeShellSettings(withoutProjectViewSwitcher).projectViewSwitcherPresentation).toBe(
      "dropdown",
    );
    expect(
      decodeShellSettings({ ...settings, projectViewSwitcherPresentation: "inline" })
        .projectViewSwitcherPresentation,
    ).toBe("inline");
    expect(() =>
      decodeShellSettings({ ...settings, projectViewSwitcherPresentation: "tabs" }),
    ).toThrow();
    expect(() => decodeShellSettings({ ...settings, future: true })).toThrow();
  });

  it("defaults first-run onboarding to pending and rejects fabricated states", () => {
    const { firstRunOnboarding: _omitted, ...withoutOnboarding } = settings;

    // A clean host has never written the field, so its absence must decode as
    // a real first run rather than as a silently completed one (BOOT-01).
    expect(decodeShellSettings(withoutOnboarding).firstRunOnboarding).toBe("pending");
    expect(decodeShellSettings({ ...settings, firstRunOnboarding: "skipped" })).toMatchObject({
      firstRunOnboarding: "skipped",
    });
    expect(() => decodeShellSettings({ ...settings, firstRunOnboarding: "dismissed" })).toThrow();
  });

  it("decodes a store without the Navigator section to both roles absent", () => {
    const { navigatorAssistant: _omitted, ...withoutNavigatorAssistant } = settings;

    // A store persisted before Navigator shipped must decode as honestly
    // unconfigured, never as some invented default model.
    const decoded = decodeShellSettings(withoutNavigatorAssistant).navigatorAssistant;
    expect(decoded.defaultProvider).toBeUndefined();
    expect(decoded.visionReviewer).toBeUndefined();

    const configured = decodeShellSettings({
      ...settings,
      navigatorAssistant: {
        defaultProvider: {
          providerInstanceId: "00000000-0000-4000-8000-00000000a001",
          modelId: "gpt-test",
        },
      },
    });
    expect(configured.navigatorAssistant.defaultProvider?.modelId).toBe("gpt-test");
    expect(configured.navigatorAssistant.visionReviewer).toBeUndefined();
    expect(() =>
      decodeShellSettings({
        ...settings,
        navigatorAssistant: { defaultProvider: { modelId: "gpt-test" } },
      }),
    ).toThrow();
    expect(() =>
      decodeShellSettings({ ...settings, navigatorAssistant: { fallback: "any" } }),
    ).toThrow();
  });

  it("decodes a store without the profile section to an empty profile", () => {
    const { userProfile: _omitted, ...withoutProfile } = settings;

    // A store persisted before profiles shipped was never asked who is using
    // it, so it must decode to no name and no address rather than to a name
    // guessed from the OS account.
    const decoded = decodeShellSettings(withoutProfile).userProfile;
    expect(decoded.displayName).toBeUndefined();
    expect(decoded.email).toBeUndefined();
    expect(decoded.accent).toBe("indigo");
    expect(decoded.avatar).toEqual({ kind: "initials" });
  });

  it("rejects a profile that cannot be honoured", () => {
    const withProfile = (userProfile: unknown) => () =>
      decodeShellSettings({ ...settings, userProfile });

    expect(
      decodeShellSettings({
        ...settings,
        userProfile: { displayName: "Ada Lovelace", email: "ada@example.com", accent: "teal" },
      }).userProfile,
    ).toMatchObject({ displayName: "Ada Lovelace", accent: "teal" });

    expect(withProfile({ email: "not-an-address" })).toThrow();
    expect(withProfile({ accent: "chartreuse" })).toThrow();
    expect(withProfile({ displayName: "   " })).toThrow();
    // An avatar has to be a picture the surface can actually draw offline: a
    // remote URL would make the profile depend on a network the host may not
    // have, and an oversized image would grow every replay of these settings.
    expect(
      withProfile({ avatar: { kind: "image", source: "upload", dataUrl: "https://x/y.png" } }),
    ).toThrow();
    expect(
      withProfile({
        avatar: {
          kind: "image",
          source: "upload",
          dataUrl: `data:image/png;base64,${"A".repeat(MAX_AVATAR_IMAGE_CHARACTERS)}`,
        },
      }),
    ).toThrow();
    expect(
      withProfile({ avatar: { kind: "gravatar-link", url: "https://gravatar.com/x" } }),
    ).toThrow();
  });

  it.each(["context", "project-memory", "code-environment"] as const)(
    "accepts bounded contextual layout for the real %s surface",
    (lastContextSurface) => {
      const contextualSettings = {
        ...settings,
        contextSidebarWidth: 360,
        lastContextSurface,
      } as const;

      expect(decodeShellSettings(contextualSettings)).toEqual(contextualSettings);
    },
  );

  it("rejects out-of-range contextual layout and fabricated surface identities", () => {
    const contextualSettings = { ...settings, contextSidebarWidth: 360 } as const;

    expect(() =>
      decodeShellSettings({ ...contextualSettings, contextSidebarWidth: 279 }),
    ).toThrow();
    expect(() =>
      decodeShellSettings({ ...contextualSettings, contextSidebarWidth: 641 }),
    ).toThrow();
    expect(() =>
      decodeShellSettings({ ...contextualSettings, lastContextSurface: "browser" }),
    ).toThrow();
  });

  it("decodes a valid bootstrap with recursive pane and split layouts", () => {
    const bootstrap = decodeShellBootstrap({
      settings,
      workspace,
      availableSurfaces: {
        chat: [{ kind: "thread", label: "Thread", available: true }],
        work: [{ kind: "thread", label: "Thread", available: true }],
        code: [{ kind: "thread", label: "Thread", available: true }],
      },
      environmentPresentation: presentationState,
      connectionStatus: "connected",
      settingsVersion: 3,
      workspaceVersion: 7,
      presentationVersion: 1,
    });

    expect(bootstrap.workspace.layouts.code.kind).toBe("split");
    expect(bootstrap.settings.sidebarWidth).toBe(280);
    expect(bootstrap.environmentPresentation.byMode.code).toBe("floating");
  });

  it("rejects invalid UUIDs and excess properties", () => {
    expect(() => decodeWindowWorkspace({ ...workspace, windowId: "not-a-uuid" })).toThrow();
    expect(() => decodeWindowWorkspace({ ...workspace, privateValue: true })).toThrow();
    expect(() =>
      decodeWindowWorkspace({
        ...workspace,
        layouts: {
          ...workspace.layouts,
          chat: { ...workspace.layouts.chat, extra: true },
        },
      }),
    ).toThrow();
  });

  it("defaults stowed Project layouts for persisted workspaces and bounds new entries", () => {
    expect(decodeWindowWorkspace(workspace).stowedLayouts).toEqual([]);

    const stowed = {
      context: { host: "local", mode: "code", projectId: ids.project, boundRoot: "/home/repo" },
      layout: pane(ids.newPaneNode, ids.newPane, {
        kind: "welcome",
        id: ids.newTab,
        mode: "code",
        title: "Code",
      }),
      activePaneId: ids.newPane,
    } as const;
    const decoded = decodeWindowWorkspace({ ...workspace, stowedLayouts: [stowed] });
    expect(decoded.stowedLayouts).toHaveLength(1);
    expect(decoded.stowedLayouts[0]?.context.projectId).toBe(ids.project);

    expect(() =>
      decodeWindowWorkspace({ ...workspace, stowedLayouts: Array(13).fill(stowed) }),
    ).toThrow();
    expect(() =>
      decodeWindowWorkspace({ ...workspace, stowedLayouts: [{ ...stowed, extra: true }] }),
    ).toThrow();
  });

  it("rejects out-of-range sidebar widths and split ratios", () => {
    for (const sidebarWidth of [MIN_SIDEBAR_WIDTH - 1, MAX_SIDEBAR_WIDTH + 1]) {
      expect(() =>
        decodeShellBootstrap({
          settings: { ...settings, sidebarWidth },
          workspace,
          environmentPresentation: presentationState,
          connectionStatus: "connected",
          settingsVersion: 3,
          workspaceVersion: 7,
          presentationVersion: 1,
        }),
      ).toThrow();
    }

    for (const ratio of [MIN_SPLIT_RATIO - 0.01, MAX_SPLIT_RATIO + 0.01]) {
      expect(() =>
        decodeWindowWorkspace({
          ...workspace,
          layouts: {
            ...workspace.layouts,
            code: { ...workspace.layouts.code, ratio },
          },
        }),
      ).toThrow();
    }
  });
});

describe("shell command contracts", () => {
  const operations = [
    {
      kind: "open-surface",
      mode: "code",
      paneId: ids.codePaneA,
      surface: { kind: "settings", id: ids.newTab, title: "Settings" },
    },
    {
      kind: "switch-project-surface",
      mode: "code",
      surface: {
        kind: "project",
        id: ids.newTab,
        projectId: ids.project,
        mode: "code",
        title: "Octant",
      },
    },
    {
      kind: "replace-pane-surface",
      mode: "code",
      paneId: ids.codePaneA,
      surface: { kind: "settings", id: ids.newTab, title: "Settings" },
    },
    {
      kind: "split-pane",
      mode: "code",
      targetPaneId: ids.codePaneA,
      surface: { kind: "settings", id: ids.newTab, title: "Settings" },
      splitNodeId: ids.newNode,
      newPaneNodeId: ids.newPaneNode,
      newPaneId: ids.newPane,
      orientation: "vertical",
      placement: "after",
      ratio: 0.5,
    },
    { kind: "close-pane", mode: "code", paneId: ids.codePaneA },
    { kind: "resize-split", mode: "code", splitNodeId: ids.codeSplit, ratio: 0.6 },
    { kind: "focus-pane", mode: "code", paneId: ids.codePaneA },
    { kind: "unfocus-pane", mode: "code" },
    { kind: "reset-mode", mode: "code" },
    { kind: "set-active-mode", mode: "chat" },
    {
      kind: "set-side-chat-sidecar",
      mode: "work",
      paneId: ids.workPane,
      sidecarThreadId: ids.thread,
    },
  ] as const;

  it("decodes complete settings replacement", () => {
    expect(
      decodeShellCommand({
        kind: "replace-settings",
        windowId: ids.window,
        expectedVersion: 3,
        settings,
      }),
    ).toMatchObject({ kind: "replace-settings", windowId: ids.window, settings });
    expect(() =>
      decodeShellCommand({ kind: "replace-settings", expectedVersion: 3, settings }),
    ).toThrow();
  });

  it("keeps new settings replacement commands strict", () => {
    const { contextSidebarWidth: _contextSidebarWidth, ...missingContextSidebarWidth } = settings;
    const { lastContextSurface: _lastContextSurface, ...missingLastContextSurface } = settings;
    const {
      modeSwitcherPresentation: _modeSwitcherPresentation,
      ...missingModeSwitcherPresentation
    } = settings;

    for (const incompleteSettings of [
      missingContextSidebarWidth,
      missingLastContextSurface,
      missingModeSwitcherPresentation,
    ]) {
      expect(() =>
        decodeShellCommand({
          kind: "replace-settings",
          windowId: ids.window,
          expectedVersion: 3,
          settings: incompleteSettings,
        }),
      ).toThrow();
    }
  });

  it.each(operations)("decodes workspace operation $kind", (operation) => {
    expect(
      decodeShellCommand({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 7,
        operation,
      }),
    ).toMatchObject({ kind: "apply-workspace-operation", operation: { kind: operation.kind } });
  });

  it("keeps atomic split-pane operations strict and bounded", () => {
    const operation = operations.find((candidate) => candidate.kind === "split-pane");
    expect(operation).toBeDefined();

    expect(() =>
      decodeShellCommand({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 7,
        operation: { ...operation, extra: true },
      }),
    ).toThrow();
    expect(() =>
      decodeShellCommand({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 7,
        operation: { ...operation, ratio: 0.1 },
      }),
    ).toThrow();
  });

  it("requires and decodes a separate layout node ID for a split's new pane", () => {
    const operation = {
      kind: "split-pane",
      mode: "code",
      targetPaneId: ids.codePaneA,
      surface: { kind: "settings", id: ids.newTab, title: "Settings" },
      splitNodeId: ids.newNode,
      newPaneNodeId: ids.newPaneNode,
      newPaneId: ids.newPane,
      orientation: "vertical",
      placement: "after",
      ratio: 0.5,
    } as const;

    expect(
      decodeShellCommand({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 7,
        operation,
      }),
    ).toMatchObject({ operation: { newPaneNodeId: ids.newPaneNode } });

    const { newPaneNodeId: _, ...missingNewPaneNodeId } = operation;
    expect(() =>
      decodeShellCommand({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 7,
        operation: missingNewPaneNodeId,
      }),
    ).toThrow();
  });

  it("rejects excess command properties", () => {
    expect(() =>
      decodeShellCommand({
        kind: "replace-settings",
        windowId: ids.window,
        expectedVersion: 3,
        settings,
        extra: true,
      }),
    ).toThrow();
  });
});

describe("Chat thread workspace tabs", () => {
  it("decodes a strict Chat thread tab", () => {
    const chatThreadTab = {
      kind: "chat-thread",
      id: ids.newTab,
      threadId: ids.thread,
      mode: "chat",
      title: "Hello",
    } as const;

    expect(decodeWorkspaceTab(chatThreadTab).kind).toBe("chat-thread");
    expect(() =>
      decodeWorkspaceTab({
        ...chatThreadTab,
        transcript: "shadow state",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceTab({
        ...chatThreadTab,
        mode: "code",
      }),
    ).toThrow();
  });
});

describe("Code workspace tabs", () => {
  it.each([
    { kind: "code-overview", threadId: ids.thread },
    { kind: "code-file", threadId: ids.thread, relativePath: "src/index.ts" },
    { kind: "code-terminal", threadId: ids.thread },
    { kind: "code-test", threadId: ids.thread },
    { kind: "code-git", threadId: ids.thread },
    { kind: "code-pr", threadId: ids.thread },
    { kind: "code-local-review", threadId: ids.thread },
    {
      kind: "apple-workbench",
      threadId: ids.thread,
      projectPath: "Fixture/Fixture.xcodeproj",
    },
  ] as const)("decodes a strict $kind tab scoped to Code", (specific) => {
    const codeTab = {
      ...specific,
      id: ids.newTab,
      mode: "code",
      title: "Code surface",
    } as const;

    expect(decodeWorkspaceTab(codeTab)).toMatchObject(codeTab);
    expect(() => decodeWorkspaceTab({ ...codeTab, canonicalPath: "/private/repo" })).toThrow();
    expect(() => decodeWorkspaceTab({ ...codeTab, mode: "chat" })).toThrow();
  });
});

describe("Project workspace tabs", () => {
  it("decodes a strict mode-scoped Project tab", () => {
    const projectTab = {
      kind: "project",
      id: ids.newTab,
      projectId: ids.project,
      mode: "code",
      title: "Octant",
    } as const;

    expect(
      decodeShellCommand({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 7,
        operation: {
          kind: "open-surface",
          mode: "code",
          paneId: ids.codePaneA,
          surface: projectTab,
        },
      }),
    ).toMatchObject({ operation: { surface: projectTab } });
    expect(() =>
      decodeShellCommand({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 7,
        operation: {
          kind: "open-surface",
          mode: "code",
          paneId: ids.codePaneA,
          surface: { ...projectTab, root: "/tmp/octant" },
        },
      }),
    ).toThrow();
  });
});

describe("shell results, events, and failures", () => {
  it("decodes both command result tags", () => {
    expect(
      decodeShellCommandResult({ kind: "settings-replaced", settings, version: 4 }),
    ).toMatchObject({ kind: "settings-replaced" });
    expect(
      decodeShellCommandResult({ kind: "workspace-replaced", workspace, version: 8 }),
    ).toMatchObject({ kind: "workspace-replaced" });
  });

  it("decodes both replacement event payloads", () => {
    expect(decodeShellSettingsReplaced({ settings })).toEqual({ settings });
    expect(decodeWorkspaceLayoutReplaced({ workspace })).toEqual({
      workspace: { ...workspace, stowedLayouts: [] },
    });
  });

  it.each([
    { category: "invalid", message: "Invalid command" },
    { category: "unsupported", message: "Unsupported command" },
    { category: "conflict", message: "Version conflict", expectedVersion: 7, actualVersion: 8 },
    { category: "unavailable", message: "Storage unavailable" },
    { category: "recovery-required", message: "Recovery required" },
    {
      category: "cross-context",
      message: "Different Project",
      offerNewWindow: true,
    },
  ] as const)("decodes $category failures", (failure) => {
    expect(decodeShellFailure(failure)).toMatchObject(failure);
  });

  it("rejects a cross-context failure without an explicit new-window offer", () => {
    expect(() =>
      decodeShellFailure({ category: "cross-context", message: "Different Project" }),
    ).toThrow();
  });
});

describe("workspace context and surface catalog", () => {
  it("decodes a workspace context key binding host, mode, Project, and root", () => {
    const key = decodeWorkspaceContextKey({
      host: "local",
      mode: "code",
      projectId: ids.project,
      boundRoot: "/home/octant",
    });
    expect(key.host).toBe("local");
    expect(key.boundRoot).toBe("/home/octant");
  });

  it("rejects a context key with an empty host or bound root", () => {
    expect(() =>
      decodeWorkspaceContextKey({ host: "  ", mode: "chat", projectId: null, boundRoot: null }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceContextKey({
        host: "local",
        mode: "code",
        projectId: null,
        boundRoot: "  ",
      }),
    ).toThrow();
  });

  it("decodes a surface catalog with available and unavailable descriptors", () => {
    const catalog = decodeWorkspaceSurfaceCatalog({
      chat: [
        { kind: "thread", label: "Thread", available: true },
        { kind: "browser", label: "Browser", available: false, unavailableReason: "No Project" },
      ],
      work: [],
      code: [],
    });
    expect(catalog.chat[0]?.kind).toBe("thread");
    expect(catalog.chat[1]?.available).toBe(false);
  });

  it("decodes Browser, Files, and Side Chat tabs in their permitted modes", () => {
    expect(
      decodeWorkspaceTab({
        kind: "browser",
        id: ids.newTab,
        mode: "work",
        title: "Browser",
        threadId: "00000000-0000-4000-8000-000000000777",
      }).kind,
    ).toBe("browser");
    expect(
      decodeWorkspaceTab({ kind: "files", id: ids.newTab, mode: "code", title: "Files" }).kind,
    ).toBe("files");
    expect(
      decodeWorkspaceTab({
        kind: "side-chat",
        id: ids.newTab,
        mode: "chat",
        title: "Side Chat about Release notes",
        sourceThreadId: "00000000-0000-4000-8000-000000000101",
      }).kind,
    ).toBe("side-chat");
  });

  it("keeps the sidecar identity on a Side Chat tab so a restart can reopen it", () => {
    const tab = decodeWorkspaceTab({
      kind: "side-chat",
      id: ids.newTab,
      mode: "work",
      title: "Side Chat about Release notes",
      sourceThreadId: "00000000-0000-4000-8000-000000000101",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
    });
    if (tab.kind !== "side-chat") throw new Error("expected a Side Chat tab");
    expect(String(tab.sourceThreadId)).toBe("00000000-0000-4000-8000-000000000101");
    expect(String(tab.sidecarThreadId)).toBe("00000000-0000-4000-8000-000000000201");
  });

  it("rejects a Side Chat tab that names no source thread", () => {
    expect(() =>
      decodeWorkspaceTab({ kind: "side-chat", id: ids.newTab, mode: "chat", title: "Side Chat" }),
    ).toThrow();
  });

  it("rejects Browser and Files tabs in Chat mode", () => {
    expect(() =>
      decodeWorkspaceTab({ kind: "browser", id: ids.newTab, mode: "chat", title: "Browser" }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceTab({ kind: "files", id: ids.newTab, mode: "chat", title: "Files" }),
    ).toThrow();
  });

  it("decodes a preview tab carrying opaque identity and bounded viewer state", () => {
    const previewTab = {
      kind: "preview",
      id: ids.newTab,
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
      viewerState: {
        targetId: "11111111-2222-4333-8444-555555555555",
        sourceVersion: {
          contentSha256: "a".repeat(64),
          byteSize: 1024,
          observedAt: "2026-07-22T00:00:00.000Z",
        },
        page: 3,
        zoom: 1.5,
      },
    } as const;
    const decoded = decodeWorkspaceTab(previewTab);
    expect(decoded.kind).toBe("preview");
    if (decoded.kind !== "preview") throw new Error("unreachable");
    expect(decoded.targetId).toBe(previewTab.targetId);
    expect(decoded.opaqueRef).toBe(previewTab.opaqueRef);
    expect(decoded.viewerState?.page).toBe(3);
    expect(decoded.boundCodeThreadId).toBeUndefined();
  });

  it("decodes a preview tab without optional viewer state and with a Code thread binding", () => {
    const previewTab = {
      kind: "preview",
      id: ids.newTab,
      mode: "code",
      title: "main.ts",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "main.ts",
      boundCodeThreadId: ids.thread,
    } as const;
    const decoded = decodeWorkspaceTab(previewTab);
    expect(decoded.kind).toBe("preview");
    if (decoded.kind !== "preview") throw new Error("unreachable");
    expect(decoded.viewerState).toBeUndefined();
    expect(decoded.boundCodeThreadId).toBe(ids.thread);
  });

  it("rejects a preview tab that leaks a host path through opaqueRef or displayName", () => {
    const base = {
      kind: "preview",
      id: ids.newTab,
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    } as const;
    expect(() => decodeWorkspaceTab({ ...base, opaqueRef: "/etc/passwd" })).toThrow();
    expect(() => decodeWorkspaceTab({ ...base, opaqueRef: "file:opaque" })).toThrow();
    expect(() => decodeWorkspaceTab({ ...base, displayName: "etc/passwd" })).toThrow();
    expect(() => decodeWorkspaceTab({ ...base, targetKind: "unknown" })).toThrow();
    expect(() => decodeWorkspaceTab({ ...base, extra: true })).toThrow();
  });
});

describe("environment presentation contracts", () => {
  it("decodes an environment presentation state with tab overrides", () => {
    expect(decodeEnvironmentPresentationState(presentationState)).toEqual(presentationState);
  });

  it("rejects a presentation state with duplicate tab overrides", () => {
    expect(() =>
      decodeEnvironmentPresentationState({
        byTab: [
          { tabId: ids.codeTabA, presentation: "hidden" },
          { tabId: ids.codeTabA, presentation: "floating" },
        ],
        byMode: { chat: "hidden", work: "floating", code: "floating" },
      }),
    ).toThrow();
  });

  it("rejects an invalid presentation literal", () => {
    expect(() =>
      decodeEnvironmentTabPresentation({
        tabId: ids.codeTabA,
        presentation: "dock",
      }),
    ).toThrow();
  });

  it("rejects the retired pinned presentation", () => {
    expect(() =>
      decodeEnvironmentTabPresentation({
        tabId: ids.codeTabA,
        presentation: "pinned",
      }),
    ).toThrow();
  });

  it("rejects a tab override carrying the retired pinned width", () => {
    expect(() =>
      decodeEnvironmentTabPresentation({
        tabId: ids.codeTabA,
        presentation: "floating",
        pinnedWidth: 360,
      }),
    ).toThrow();
  });

  it("decodes a compact identity with each status", () => {
    for (const status of [
      "available",
      "unavailable",
      "stale",
      "disconnected",
      "recovery",
    ] as const) {
      const identity = {
        host: "local",
        label: "Local",
        detail: "feature/name",
        status,
      };
      expect(decodeEnvironmentCompactIdentity(identity).status).toBe(status);
    }
  });

  it("rejects a compact identity with an empty detail", () => {
    expect(() =>
      decodeEnvironmentCompactIdentity({
        host: "local",
        label: "Local",
        detail: "  ",
        status: "available",
      }),
    ).toThrow();
  });

  it("decodes shell settings with explicit environment presentation defaults", () => {
    const explicit = {
      ...settings,
      environmentPresentationByMode: { chat: "floating", work: "floating", code: "hidden" },
    };
    expect(decodeShellSettings(explicit).environmentPresentationByMode).toEqual({
      chat: "floating",
      work: "floating",
      code: "hidden",
    });
  });

  it("applies default environment presentation by mode when omitted", () => {
    const { environmentPresentationByMode: _omit, ...withoutPresentation } = settings;
    const decoded = decodeShellSettings(withoutPresentation);
    expect(decoded.environmentPresentationByMode).toEqual({
      chat: "hidden",
      work: "floating",
      code: "floating",
    });
    // The re-encoded struct includes the default, so the shapes differ; verify
    // only the presentation default rather than full equality.
    expect(decoded.sidebarWidth).toBe(280);
  });

  it("decodes a set-environment-presentation command", () => {
    const command = {
      kind: "set-environment-presentation",
      windowId: ids.window,
      expectedVersion: 1,
      presentation: presentationState,
    };
    expect(decodeShellCommand(command).kind).toBe("set-environment-presentation");
  });

  it("decodes an environment-presentation-replaced result", () => {
    const result = {
      kind: "environment-presentation-replaced",
      presentation: presentationState,
      version: 2,
    };
    expect(decodeShellCommandResult(result).kind).toBe("environment-presentation-replaced");
  });
});
