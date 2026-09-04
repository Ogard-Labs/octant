import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEnvironmentPresentationState,
  decodeShellSettings,
  decodeWindowId,
  decodeWindowWorkspace,
  type EventEnvelope,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { ProjectionQuarantined, rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import {
  decodePersistedShellSettings,
  decodePersistedWindowWorkspace,
} from "./shellPersistenceSchema";
import {
  ShellProjection,
  readEnvironmentPresentation,
  readShellSettings,
  readWindowWorkspace,
  readWindowWorkspaces,
} from "./shellProjection";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";
const ids = {
  actor: "00000000-0000-4000-8000-000000000101",
  correlation: "00000000-0000-4000-8000-000000000102",
  settingsAggregate: "00000000-0000-4000-8000-000000000001",
  settingsEvent: "00000000-0000-4000-8000-000000000104",
  workspaceEvent: "00000000-0000-4000-8000-000000000105",
  window: decodeWindowId("00000000-0000-4000-8000-000000000106"),
} as const;

const settings = decodeShellSettings({
  chatEnabled: false,
  workEnabled: true,
  sidebarWidth: 320,
  contextSidebarWidth: 360,
  lastContextSurface: "project-memory",
  sidebarMaterial: "opaque",
  modeSwitcherPresentation: "dropdown",
});

const workspace = decodeWindowWorkspace({
  windowId: ids.window,
  activeMode: "code",
  layouts: {
    chat: pane("1", "chat"),
    work: pane("2", "work"),
    code: pane("3", "code"),
  },
  activePaneIds: {
    chat: "10000000-0000-4000-8000-000000000002",
    work: "20000000-0000-4000-8000-000000000002",
    code: "30000000-0000-4000-8000-000000000002",
  },
  contextByMode: {
    chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
    work: { host: "local", mode: "work", projectId: null, boundRoot: null },
    code: { host: "local", mode: "code", projectId: null, boundRoot: null },
  },
  version: 1,
});

function pane(prefix: string, mode: "chat" | "work" | "code") {
  return {
    kind: "pane" as const,
    nodeId: `${prefix}0000000-0000-4000-8000-000000000001`,
    paneId: `${prefix}0000000-0000-4000-8000-000000000002`,
    surface: {
      kind: "welcome" as const,
      id: `${prefix}0000000-0000-4000-8000-000000000003`,
      mode,
      title: `Welcome to ${mode}`,
    },
  };
}

// The tab-group shape a pre-pane journal persisted; migration collapses it to
// one pane showing the group's active tab.
function legacyGroup(
  prefix: string,
  mode: "chat" | "work" | "code",
  tabs?: ReadonlyArray<Record<string, unknown>>,
  activeTabId?: string,
) {
  return {
    kind: "group" as const,
    nodeId: `${prefix}0000000-0000-4000-8000-000000000001`,
    groupId: `${prefix}0000000-0000-4000-8000-000000000002`,
    tabs: tabs ?? [
      {
        kind: "welcome" as const,
        id: `${prefix}0000000-0000-4000-8000-000000000003`,
        mode,
        title: `Welcome to ${mode}`,
      },
    ],
    activeTabId: activeTabId ?? `${prefix}0000000-0000-4000-8000-000000000003`,
  };
}

function legacyGroupWorkspace() {
  return {
    windowId: ids.window,
    activeMode: "code",
    layouts: {
      chat: legacyGroup("1", "chat"),
      work: legacyGroup("2", "work"),
      code: legacyGroup("3", "code"),
    },
    activeGroupIds: {
      chat: "10000000-0000-4000-8000-000000000002",
      work: "20000000-0000-4000-8000-000000000002",
      code: "30000000-0000-4000-8000-000000000002",
    },
    contextByMode: {
      chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
      work: { host: "local", mode: "work", projectId: null, boundRoot: null },
      code: { host: "local", mode: "code", projectId: null, boundRoot: null },
    },
    version: 1,
  };
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-shell-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function appendShellEvents(connection: SqliteConnection, workspaceValue = workspace) {
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  journal.append({
    aggregate: { aggregateType: "shell-settings", aggregateId: ids.settingsAggregate },
    expectedVersion: 0,
    events: [pending(ids.settingsEvent, "shell.settings-replaced", { settings })],
  });
  journal.append({
    aggregate: { aggregateType: "window-workspace", aggregateId: ids.window },
    expectedVersion: 0,
    events: [
      pending(ids.workspaceEvent, "workspace.layout-replaced", { workspace: workspaceValue }),
    ],
  });
  return { journal, projection: runtime.projections.get("shell")! };
}

function pending(eventId: string, eventName: string, payload: unknown) {
  return {
    eventId,
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
    payload,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ShellProjection", () => {
  it("restores persisted Project surfaces without downgrading them", () => {
    const code = workspace.layouts.code;
    if (code.kind !== "pane") throw new Error("fixture code layout must be a pane");
    const projectSurface = {
      kind: "project" as const,
      id: code.surface.id,
      projectId: "60000000-0000-4000-8000-000000000020",
      mode: "code" as const,
      title: "Octant",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, code: { ...code, surface: projectSurface } },
      }).layouts.code,
    ).toMatchObject({ surface: projectSurface });
  });

  it("restores persisted Chat thread surfaces without downgrading them", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "pane") throw new Error("fixture chat layout must be a pane");
    const chatThreadSurface = {
      kind: "chat-thread" as const,
      id: chat.surface.id,
      threadId: "70000000-0000-4000-8000-000000000021",
      mode: "chat" as const,
      title: "Planning",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, chat: { ...chat, surface: chatThreadSurface } },
      }).layouts.chat,
    ).toMatchObject({ surface: chatThreadSurface });
  });

  it("restores persisted Code surfaces without downgrading them", () => {
    const code = workspace.layouts.code;
    if (code.kind !== "pane") throw new Error("fixture Code layout must be a pane");
    const codeSurface = {
      kind: "code-file" as const,
      id: code.surface.id,
      threadId: "70000000-0000-4000-8000-000000000022",
      mode: "code" as const,
      title: "code.ts",
      relativePath: "packages/contracts/src/code.ts",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, code: { ...code, surface: codeSurface } },
      }).layouts.code,
    ).toMatchObject({ surface: codeSurface });
  });

  it("restores a Side Chat surface with its sidecar identity intact", () => {
    const work = workspace.layouts.work;
    if (work.kind !== "pane") throw new Error("fixture Work layout must be a pane");
    const sideChatSurface = {
      kind: "side-chat" as const,
      id: work.surface.id,
      mode: "work" as const,
      title: "Side Chat about Release notes",
      sourceThreadId: "70000000-0000-4000-8000-000000000041",
      sidecarThreadId: "70000000-0000-4000-8000-000000000042",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, work: { ...work, surface: sideChatSurface } },
      }).layouts.work,
    ).toMatchObject({ surface: sideChatSurface });
  });

  it("restores a Side Chat surface that names no sidecar as the mode welcome surface", () => {
    const work = workspace.layouts.work;
    if (work.kind !== "pane") throw new Error("fixture Work layout must be a pane");
    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        work: {
          ...work,
          surface: {
            kind: "side-chat",
            id: work.surface.id,
            mode: "work",
            title: "Side Chat",
          },
        },
      },
    }).layouts.work;
    if (restored.kind !== "pane") throw new Error("restored Work layout must be a pane");
    expect(restored.surface).toEqual({
      kind: "welcome",
      id: work.surface.id,
      mode: "work",
      title: "Welcome to Work",
    });
  });

  it("preserves draft-thread and work-thread surfaces when mode matches", () => {
    const code = workspace.layouts.code;
    const work = workspace.layouts.work;
    if (code.kind !== "pane") throw new Error("fixture Code layout must be a pane");
    if (work.kind !== "pane") throw new Error("fixture Work layout must be a pane");

    const draftSurface = {
      kind: "draft-thread" as const,
      id: code.surface.id,
      mode: "code" as const,
      title: "New Code thread",
      projectId: "10000000-0000-4000-8000-000000000001",
    };
    const workThreadSurface = {
      kind: "work-thread" as const,
      id: work.surface.id,
      threadId: "70000000-0000-4000-8000-000000000031",
      mode: "work" as const,
      title: "Brief draft",
    };

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        code: { ...code, surface: draftSurface },
        work: { ...work, surface: workThreadSurface },
      },
    });
    const restoredCode = restored.layouts.code;
    const restoredWork = restored.layouts.work;
    if (restoredCode.kind !== "pane") throw new Error("restored Code layout must be a pane");
    if (restoredWork.kind !== "pane") throw new Error("restored Work layout must be a pane");
    expect(restoredCode.surface).toEqual(draftSurface);
    expect(restoredWork.surface).toEqual(workThreadSurface);
  });

  it("recovers thread surfaces found outside their mode layouts as welcome surfaces", () => {
    const chat = workspace.layouts.chat;
    const code = workspace.layouts.code;
    if (chat.kind !== "pane") throw new Error("fixture Chat layout must be a pane");
    if (code.kind !== "pane") throw new Error("fixture Code layout must be a pane");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        chat: {
          ...chat,
          surface: {
            kind: "draft-thread",
            id: chat.surface.id,
            mode: "code",
            title: "New Code thread",
          },
        },
        code: {
          ...code,
          surface: {
            kind: "work-thread",
            id: code.surface.id,
            threadId: "70000000-0000-4000-8000-000000000031",
            mode: "work",
            title: "Brief draft",
          },
        },
      },
    });
    const restoredChat = restored.layouts.chat;
    const restoredCode = restored.layouts.code;
    if (restoredChat.kind !== "pane") throw new Error("restored Chat layout must be a pane");
    if (restoredCode.kind !== "pane") throw new Error("restored Code layout must be a pane");
    expect(restoredChat.surface).toMatchObject({ kind: "welcome", mode: "chat" });
    expect(restoredCode.surface).toMatchObject({ kind: "welcome", mode: "code" });
  });

  it("recovers malformed thread surfaces through the welcome-in-place path", () => {
    const work = workspace.layouts.work;
    if (work.kind !== "pane") throw new Error("fixture Work layout must be a pane");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        work: {
          ...work,
          surface: {
            kind: "work-thread",
            id: work.surface.id,
            mode: "work",
            title: "Missing thread identity",
          },
        },
      },
    });
    const restoredWork = restored.layouts.work;
    if (restoredWork.kind !== "pane") throw new Error("restored Work layout must be a pane");
    expect(restoredWork.surface).toMatchObject({
      kind: "welcome",
      id: work.surface.id,
      mode: "work",
    });
  });

  it("recovers a persisted Code surface found outside the Code layout", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "pane") throw new Error("fixture Chat layout must be a pane");
    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        chat: {
          ...chat,
          surface: {
            kind: "code-overview",
            id: chat.surface.id,
            threadId: "70000000-0000-4000-8000-000000000022",
            mode: "code",
            title: "Overview",
          },
        },
      },
    });
    const restoredChat = restored.layouts.chat;
    if (restoredChat.kind !== "pane") throw new Error("restored Chat layout must be a pane");
    expect(restoredChat.surface).toMatchObject({ kind: "welcome", mode: "chat" });
  });

  it("turns a restored full-window Code diff into the thread so Review can open beside it", () => {
    const code = workspace.layouts.code;
    if (code.kind !== "pane") throw new Error("fixture Code layout must be a pane");
    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        code: {
          ...code,
          surface: {
            kind: "code-diff",
            id: code.surface.id,
            threadId: "70000000-0000-4000-8000-000000000022",
            mode: "code",
            title: "README.md changes",
            relativePath: "README.md",
          },
        },
      },
    });
    const restoredCode = restored.layouts.code;
    if (restoredCode.kind !== "pane") throw new Error("restored Code layout must be a pane");
    expect(restoredCode.surface).toMatchObject({
      kind: "code-overview",
      id: code.surface.id,
      threadId: "70000000-0000-4000-8000-000000000022",
      mode: "code",
    });
    expect(restoredCode.surface).not.toHaveProperty("relativePath");
  });

  it("recovers a malformed persisted Chat thread surface through the welcome-in-place path", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "pane") throw new Error("fixture chat layout must be a pane");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        chat: {
          ...chat,
          surface: {
            kind: "chat-thread",
            id: chat.surface.id,
            mode: "chat",
            title: "Planning",
            legacyTranscript: "must not enter renderer state",
          },
        },
      },
    });
    const restoredChat = restored.layouts.chat;
    if (restoredChat.kind !== "pane") throw new Error("restored Chat layout must be a pane");
    expect(restoredChat.surface).toEqual({
      kind: "welcome",
      id: chat.surface.id,
      mode: "chat",
      title: "Welcome to Chat",
    });
  });

  it("recovers a persisted Chat thread surface found outside the Chat layout", () => {
    const code = workspace.layouts.code;
    if (code.kind !== "pane") throw new Error("fixture Code layout must be a pane");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        code: {
          ...code,
          surface: {
            kind: "chat-thread",
            id: code.surface.id,
            threadId: "70000000-0000-4000-8000-000000000021",
            mode: "chat",
            title: "Planning",
          },
        },
      },
    });
    const restoredCode = restored.layouts.code;
    if (restoredCode.kind !== "pane") throw new Error("restored Code layout must be a pane");
    expect(restoredCode.surface).toMatchObject({
      kind: "welcome",
      id: code.surface.id,
      mode: "code",
    });
  });

  it("replays a valid Chat thread surface through the durable shell projection", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "pane") throw new Error("fixture chat layout must be a pane");
    const chatThreadSurface = {
      kind: "chat-thread" as const,
      id: chat.surface.id,
      threadId: "70000000-0000-4000-8000-000000000021",
      mode: "chat" as const,
      title: "Planning",
    };
    const durableWorkspace = decodeWindowWorkspace({
      ...workspace,
      layouts: { ...workspace.layouts, chat: { ...chat, surface: chatThreadSurface } },
    });
    const connection = openConnection();

    appendShellEvents(connection, durableWorkspace);

    expect(readWindowWorkspace(connection, ids.window)?.workspace.layouts.chat).toMatchObject({
      surface: chatThreadSurface,
    });
    connection.close();
  });

  it("collapses a legacy tab group to one pane showing its active tab, dropping the rest", () => {
    const legacy = legacyGroupWorkspace();
    const activeTab = {
      kind: "code-overview" as const,
      id: "30000000-0000-4000-8000-000000000004",
      threadId: "70000000-0000-4000-8000-000000000022",
      mode: "code" as const,
      title: "Overview",
    };
    legacy.layouts.code = legacyGroup(
      "3",
      "code",
      [
        {
          kind: "welcome",
          id: "30000000-0000-4000-8000-000000000003",
          mode: "code",
          title: "Welcome to code",
        },
        activeTab,
      ],
      activeTab.id,
    );

    const restored = decodePersistedWindowWorkspace(legacy);

    // Background tabs are deliberately lost; the group's id survives as the
    // pane's so the renamed active-pane pointer still resolves.
    expect(restored.layouts.code).toEqual({
      kind: "pane",
      nodeId: "30000000-0000-4000-8000-000000000001",
      paneId: "30000000-0000-4000-8000-000000000002",
      surface: activeTab,
    });
    expect(restored.activePaneIds).toEqual({
      chat: "10000000-0000-4000-8000-000000000002",
      work: "20000000-0000-4000-8000-000000000002",
      code: "30000000-0000-4000-8000-000000000002",
    });
  });

  it("carries a legacy focused group and stowed active group forward under pane names", () => {
    const legacy = {
      ...legacyGroupWorkspace(),
      focusedGroupId: "30000000-0000-4000-8000-000000000002",
      stowedLayouts: [
        {
          context: { host: "local", mode: "code", projectId: null, boundRoot: null },
          layout: legacyGroup("4", "code"),
          activeGroupId: "40000000-0000-4000-8000-000000000002",
        },
      ],
    };

    const restored = decodePersistedWindowWorkspace(legacy);

    expect(restored.focusedPaneId).toBe("30000000-0000-4000-8000-000000000002");
    expect(restored.stowedLayouts?.[0]).toMatchObject({
      layout: { kind: "pane", paneId: "40000000-0000-4000-8000-000000000002" },
      activePaneId: "40000000-0000-4000-8000-000000000002",
    });
  });

  it("upcasts legacy workspaces with one deterministic active pane per mode", () => {
    const { activeGroupIds: _activeGroupIds, ...legacy } = legacyGroupWorkspace();

    expect(decodePersistedWindowWorkspace(legacy).activePaneIds).toEqual({
      chat: "10000000-0000-4000-8000-000000000002",
      work: "20000000-0000-4000-8000-000000000002",
      code: "30000000-0000-4000-8000-000000000002",
    });
  });

  it("returns undefined when no settings or workspace event has been projected", () => {
    const connection = openConnection();

    expect(readShellSettings(connection)).toBeUndefined();
    expect(readWindowWorkspace(connection, ids.window)).toBeUndefined();
    expect(readWindowWorkspaces(connection)).toEqual([]);
    connection.close();
  });

  it("restores a same-authority split of two thread panes after replay", () => {
    const connection = openConnection();
    const projection = new ShellProjection();
    const splitWorkspace = decodeWindowWorkspace({
      ...workspace,
      activeMode: "chat",
      layouts: {
        ...workspace.layouts,
        chat: {
          kind: "split",
          nodeId: "10000000-0000-4000-8000-000000000010",
          orientation: "horizontal",
          ratio: 0.5,
          first: {
            kind: "pane",
            nodeId: "10000000-0000-4000-8000-000000000011",
            paneId: "10000000-0000-4000-8000-000000000012",
            surface: {
              kind: "chat-thread",
              id: "10000000-0000-4000-8000-000000000013",
              threadId: "10000000-0000-4000-8000-000000000014",
              mode: "chat",
              title: "First",
            },
          },
          second: {
            kind: "pane",
            nodeId: "10000000-0000-4000-8000-000000000015",
            paneId: "10000000-0000-4000-8000-000000000016",
            surface: {
              kind: "chat-thread",
              id: "10000000-0000-4000-8000-000000000017",
              threadId: "10000000-0000-4000-8000-000000000018",
              mode: "chat",
              title: "Second",
            },
          },
        },
      },
      activePaneIds: {
        ...workspace.activePaneIds,
        chat: "10000000-0000-4000-8000-000000000016",
      },
      version: 1,
    });
    projection.apply(connection, workspaceEnvelope({ payload: { workspace: splitWorkspace } }));

    expect(readWindowWorkspace(connection, ids.window)).toEqual({
      workspace: splitWorkspace,
      aggregateVersion: 1,
    });
    connection.close();
  });

  it("stores schema-versioned JSON and aggregate versions for both shell events", () => {
    const connection = openConnection();

    appendShellEvents(connection);

    expect(readShellSettings(connection)).toEqual({ settings, aggregateVersion: 1 });
    expect(readWindowWorkspace(connection, ids.window)).toEqual({
      workspace,
      aggregateVersion: 1,
    });
    expect(readWindowWorkspaces(connection)).toEqual([{ workspace, aggregateVersion: 1 }]);
    expect(
      connection
        .prepare(
          "SELECT schema_version, aggregate_version FROM shell_settings_projection WHERE projection_key = ?",
        )
        .get("shell-settings"),
    ).toEqual({ schema_version: 1, aggregate_version: 1 });
    expect(
      connection
        .prepare(
          "SELECT schema_version, aggregate_version FROM window_workspace_projection WHERE window_id = ?",
        )
        .get(ids.window),
    ).toEqual({ schema_version: 1, aggregate_version: 1 });
    connection.close();
  });

  it("applies idempotently by aggregate version and ignores unrelated events", () => {
    const connection = openConnection();
    const projection = new ShellProjection();
    const settingsEvent = envelope({
      aggregateVersion: 2,
      eventName: "shell.settings-replaced",
      payload: { settings },
    });

    projection.apply(connection, settingsEvent);
    projection.apply(connection, {
      ...settingsEvent,
      aggregateVersion: 1 as EventEnvelope["aggregateVersion"],
      payload: { settings: { ...settings, sidebarWidth: 220 } },
    });
    projection.apply(connection, {
      ...settingsEvent,
      eventName: "fixture.recorded" as EventEnvelope["eventName"],
    });

    expect(readShellSettings(connection)).toEqual({ settings, aggregateVersion: 2 });
    connection.close();
  });

  it.each([
    ["aggregate type", { aggregateType: "wrong-shell-settings" }],
    ["singleton aggregate ID", { aggregateId: "00000000-0000-4000-8000-000000000199" }],
  ])("rejects shell settings events with the wrong %s before writing", (_name, override) => {
    const connection = openConnection();
    const projection = new ShellProjection();

    expect(() =>
      projection.apply(
        connection,
        envelope({
          aggregateVersion: 1,
          eventName: "shell.settings-replaced",
          payload: { settings },
          ...override,
        }),
      ),
    ).toThrow();

    expect(readShellSettings(connection)).toBeUndefined();
    connection.close();
  });

  it.each([
    ["aggregate type", { aggregateType: "wrong-window-workspace" }],
    ["aggregate ID", { aggregateId: "00000000-0000-4000-8000-000000000199" }],
    ["aggregate version", { aggregateVersion: 2 }],
  ])("rejects workspace events with the wrong %s before writing", (_name, override) => {
    const connection = openConnection();
    const projection = new ShellProjection();

    expect(() => projection.apply(connection, workspaceEnvelope(override))).toThrow();

    expect(readWindowWorkspace(connection, ids.window)).toBeUndefined();
    connection.close();
  });

  it("applies workspace events idempotently and does not overwrite newer aggregate versions", () => {
    const connection = openConnection();
    const projection = new ShellProjection();
    const newerWorkspace = decodeWindowWorkspace({
      ...workspace,
      activeMode: "work",
      version: 2,
    });
    const newerEvent = workspaceEnvelope({
      aggregateVersion: 2,
      payload: { workspace: newerWorkspace },
    });

    projection.apply(connection, newerEvent);
    projection.apply(connection, newerEvent);
    projection.apply(connection, workspaceEnvelope());

    expect(readWindowWorkspace(connection, ids.window)).toEqual({
      workspace: newerWorkspace,
      aggregateVersion: 2,
    });
    connection.close();
  });

  it("replays pre-contextByMode workspace events by upcasting the missing context", () => {
    const connection = openConnection();
    const projection = new ShellProjection();
    // Simulate a pre-contextByMode journal payload: strip contextByMode so the
    // event looks like one saved before the schema change.
    const { contextByMode: _stripped, ...legacyWorkspace } = workspace as Record<string, unknown>;
    const legacyEvent = workspaceEnvelope({
      payload: { workspace: legacyWorkspace },
    });
    projection.apply(connection, legacyEvent);
    const restored = readWindowWorkspace(connection, ids.window);
    expect(restored?.workspace.contextByMode.chat.projectId).toBeNull();
    expect(restored?.workspace.contextByMode.work.projectId).toBeNull();
    expect(restored?.workspace.contextByMode.code.projectId).toBeNull();
    connection.close();
  });

  it("reset clears both projections and rebuild reproduces journal state", () => {
    const connection = openConnection();
    const { journal, projection } = appendShellEvents(connection);

    projection.reset(connection);
    expect(readShellSettings(connection)).toBeUndefined();
    expect(readWindowWorkspace(connection, ids.window)).toBeUndefined();

    rebuildProjection({ connection, journal, projection, clock: () => now });

    expect(readShellSettings(connection)).toEqual({ settings, aggregateVersion: 1 });
    expect(readWindowWorkspace(connection, ids.window)).toEqual({
      workspace,
      aggregateVersion: 1,
    });
    connection.close();
  });

  it("projects and reads environment presentation overrides keyed by window", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const presentation = decodeEnvironmentPresentationState({
      byTab: [
        {
          tabId: "30000000-0000-4000-8000-000000000003",
          presentation: "hidden",
        },
      ],
      byMode: { chat: "hidden", work: "floating", code: "floating" },
    });

    journal.append({
      aggregate: { aggregateType: "environment-presentation", aggregateId: ids.window },
      expectedVersion: 0,
      events: [
        pending("00000000-0000-4000-8000-000000000110", "shell.environment-presentation-replaced", {
          presentation,
        }),
      ],
    });

    expect(readEnvironmentPresentation(connection, ids.window)).toEqual({
      presentation: {
        byTab: [],
        byMode: { chat: "hidden", work: "floating", code: "floating" },
      },
      aggregateVersion: 1,
    });
    connection.close();
  });

  it("applies environment presentation events idempotently by aggregate version", () => {
    const connection = openConnection();
    const projection = new ShellProjection();
    const presentation = decodeEnvironmentPresentationState({
      byTab: [],
      byMode: { chat: "hidden", work: "floating", code: "floating" },
    });
    const event = envelope({
      aggregateVersion: 2,
      eventName: "shell.environment-presentation-replaced",
      payload: { presentation },
      aggregateType: "environment-presentation",
      aggregateId: ids.window,
    });

    projection.apply(connection, event);
    projection.apply(connection, event);
    projection.apply(connection, {
      ...event,
      aggregateVersion: 1 as EventEnvelope["aggregateVersion"],
    });

    expect(readEnvironmentPresentation(connection, ids.window)?.aggregateVersion).toBe(2);
    connection.close();
  });

  it("upcasts a legacy presentation payload missing byTab and byMode during replay", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const projection = runtime.projections.get("shell")!;
    insertJournalEvent(
      connection,
      envelope({
        aggregateVersion: 1,
        eventName: "shell.environment-presentation-replaced",
        payload: { presentation: {} },
        aggregateType: "environment-presentation",
        aggregateId: ids.window,
      }),
    );

    rebuildProjection({ connection, journal, projection, clock: () => now });

    const restored = readEnvironmentPresentation(connection, ids.window);
    expect(restored?.presentation.byMode).toEqual({
      chat: "hidden",
      work: "floating",
      code: "floating",
    });
    expect(restored?.presentation.byTab).toEqual([]);
    connection.close();
  });

  it("drops stored floating, pinned, or hidden environment presentation at the persistence seam", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const projection = runtime.projections.get("shell")!;
    insertJournalEvent(
      connection,
      envelope({
        aggregateVersion: 1,
        eventName: "shell.environment-presentation-replaced",
        payload: {
          presentation: {
            byTab: [
              {
                tabId: "30000000-0000-4000-8000-000000000003",
                presentation: "pinned",
                pinnedWidth: 440,
              },
              { tabId: "30000000-0000-4000-8000-000000000004", presentation: "hidden" },
            ],
            byMode: { chat: "hidden", work: "pinned", code: "pinned" },
          },
        },
        aggregateType: "environment-presentation",
        aggregateId: ids.window,
      }),
    );

    rebuildProjection({ connection, journal, projection, clock: () => now });

    const restored = readEnvironmentPresentation(connection, ids.window);
    expect(restored?.presentation.byMode).toEqual({
      chat: "hidden",
      work: "floating",
      code: "floating",
    });
    expect(restored?.presentation.byTab).toEqual([]);
    connection.close();
  });

  it("rebuilds the final atomic split layout without an intermediate projection", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const splitWorkspace = decodeWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        code: {
          kind: "split",
          nodeId: "60000000-0000-4000-8000-000000000001",
          orientation: "vertical",
          ratio: 0.5,
          first: pane("4", "code"),
          second: pane("5", "code"),
        },
      },
      activePaneIds: {
        ...workspace.activePaneIds,
        code: "40000000-0000-4000-8000-000000000002",
      },
      version: 1,
    });
    journal.append({
      aggregate: { aggregateType: "window-workspace", aggregateId: ids.window },
      expectedVersion: 0,
      events: [
        pending(ids.workspaceEvent, "workspace.layout-replaced", { workspace: splitWorkspace }),
      ],
    });
    const projection = runtime.projections.get("shell")!;

    projection.reset(connection);
    rebuildProjection({ connection, journal, projection, clock: () => now });

    expect(readWindowWorkspace(connection, ids.window)).toEqual({
      workspace: splitWorkspace,
      aggregateVersion: 1,
    });
    expect(journal.replay({ afterSequence: 0, limit: 10 } as never)).toHaveLength(1);
    connection.close();
  });

  it("upcasts an exact legacy settings event during replay without rewriting the journal", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const projection = runtime.projections.get("shell")!;
    const legacyPayload = { settings: legacySettings() };
    insertJournalEvent(
      connection,
      envelope({
        aggregateVersion: 1,
        eventName: "shell.settings-replaced",
        payload: legacyPayload,
      }),
    );

    expect(journal.replay({ afterSequence: 0, limit: 100 } as never)).toMatchObject([
      {
        payload: {
          settings: {
            ...legacyPayload.settings,
            contextSidebarWidth: 360,
            lastContextSurface: null,
            modeSwitcherPresentation: "dropdown",
            sidebarBackground: {
              kind: "none",
              overlayColor: "#1a1a1c",
              overlayOpacity: 100,
              vibrancyMode: "off",
            },
            environmentPresentationByMode: {
              chat: "hidden",
              work: "floating",
              code: "floating",
            },
          },
        },
      },
    ]);
    rebuildProjection({ connection, journal, projection, clock: () => now });

    expect(readShellSettings(connection)).toEqual({
      settings: decodePersistedShellSettings(legacyPayload.settings),
      aggregateVersion: 1,
    });
    expect(connection.prepare("SELECT payload_json FROM event_journal").get()).toEqual({
      payload_json: JSON.stringify(legacyPayload),
    });
    connection.close();
  });

  it("upcasts unsupported persisted tab kinds while replaying the journal", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const projection = runtime.projections.get("shell")!;
    const unsupported = workspaceWithUnsupportedCodeTab();
    insertJournalEvent(connection, workspaceEnvelope({ payload: { workspace: unsupported } }));

    rebuildProjection({ connection, journal, projection, clock: () => now });

    // The unknown kind renders welcome in place: the pane survives, the
    // persisted title never enters renderer state.
    expect(readWindowWorkspace(connection, ids.window)?.workspace.layouts.code).toMatchObject({
      kind: "pane",
      surface: {
        kind: "welcome",
        id: unsupported.layouts.code.tabs[0]!.id,
        mode: "code",
        title: "Welcome to Code",
      },
    });
    connection.close();
  });

  it("upcasts unsupported tab kinds already stored in the workspace projection", () => {
    const connection = openConnection();
    appendShellEvents(connection);
    const unsupported = workspaceWithUnsupportedCodeTab();
    connection
      .prepare("UPDATE window_workspace_projection SET workspace_json = ? WHERE window_id = ?")
      .run(JSON.stringify(unsupported), ids.window);

    expect(readWindowWorkspace(connection, ids.window)?.workspace.layouts.code).toMatchObject({
      kind: "pane",
      surface: {
        kind: "welcome",
        id: unsupported.layouts.code.tabs[0]!.id,
        mode: "code",
      },
    });
    connection.close();
  });

  it("upcasts an exact legacy schema-v1 settings row without rewriting it", () => {
    const connection = openConnection();
    appendShellEvents(connection);
    const legacy = legacySettings();
    connection
      .prepare("UPDATE shell_settings_projection SET settings_json = ?")
      .run(JSON.stringify(legacy));

    expect(readShellSettings(connection)).toEqual({
      settings: decodePersistedShellSettings(legacy),
      aggregateVersion: 1,
    });
    expect(
      connection
        .prepare("SELECT settings_json FROM shell_settings_projection WHERE projection_key = ?")
        .get("shell-settings"),
    ).toEqual({ settings_json: JSON.stringify(legacy) });
    connection.close();
  });

  it("drops stored environment presentation defaults from a settings row", () => {
    const connection = openConnection();
    appendShellEvents(connection);
    connection.prepare("UPDATE shell_settings_projection SET settings_json = ?").run(
      JSON.stringify({
        ...settings,
        environmentPresentationByMode: { chat: "hidden", work: "pinned", code: "pinned" },
      }),
    );

    expect(readShellSettings(connection)?.settings.environmentPresentationByMode).toEqual({
      chat: "hidden",
      work: "floating",
      code: "floating",
    });
    connection.close();
  });

  it.each([
    [280, null],
    [640, "project-memory"],
    [360, "code-environment"],
  ] as const)(
    "preserves a current schema-v1 settings row with width %s and surface %s",
    (contextSidebarWidth, lastContextSurface) => {
      const connection = openConnection();
      appendShellEvents(connection);
      const { modeSwitcherPresentation: _modeSwitcherPresentation, ...preSwitcherSettings } =
        settings;
      const current = { ...preSwitcherSettings, contextSidebarWidth, lastContextSurface };
      connection
        .prepare("UPDATE shell_settings_projection SET settings_json = ?")
        .run(JSON.stringify(current));

      expect(readShellSettings(connection)).toEqual({
        settings: { ...current, modeSwitcherPresentation: "dropdown" },
        aggregateVersion: 1,
      });
      connection.close();
    },
  );

  it("preserves an explicit dropdown preference across projection rebuild", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const projection = runtime.projections.get("shell")!;
    const dropdownSettings = { ...settings, modeSwitcherPresentation: "dropdown" } as const;

    journal.append({
      aggregate: { aggregateType: "shell-settings", aggregateId: ids.settingsAggregate },
      expectedVersion: 0,
      events: [
        pending(ids.settingsEvent, "shell.settings-replaced", { settings: dropdownSettings }),
      ],
    });
    projection.reset(connection);
    rebuildProjection({ connection, journal, projection, clock: () => now });

    expect(readShellSettings(connection)).toEqual({
      settings: dropdownSettings,
      aggregateVersion: 1,
    });
    connection.close();
  });

  it.each([
    ["an excess legacy property", { ...legacySettings(), future: true }],
    ["only the current width field", { ...legacySettings(), contextSidebarWidth: 360 }],
    ["only the current surface field", { ...legacySettings(), lastContextSurface: null }],
    ["a malformed legacy value", { ...legacySettings(), sidebarWidth: 999 }],
    [
      "a malformed current width",
      { ...legacySettings(), contextSidebarWidth: 961, lastContextSurface: null },
    ],
    [
      "a fabricated current surface",
      {
        ...legacySettings(),
        contextSidebarWidth: 360,
        lastContextSurface: "browser",
      },
    ],
    [
      "an invalid mode-switcher presentation",
      {
        ...legacySettings(),
        contextSidebarWidth: 360,
        lastContextSurface: null,
        modeSwitcherPresentation: "tabs",
      },
    ],
  ])("rejects a schema-v1 settings row with %s", (_name, persistedSettings) => {
    const connection = openConnection();
    appendShellEvents(connection);
    connection
      .prepare("UPDATE shell_settings_projection SET settings_json = ?")
      .run(JSON.stringify(persistedSettings));

    expect(() => readShellSettings(connection)).toThrow();
    connection.close();
  });

  it.each([
    ["missing", {}],
    ["numeric", { title: 42 }],
    ["empty", { title: "" }],
    ["whitespace-padded", { title: " Recovered editor " }],
  ])(
    "recovers an unsupported projected tab with a %s title as the mode welcome surface",
    (_name, titleFields) => {
      const connection = openConnection();
      appendShellEvents(connection);
      connection
        .prepare("UPDATE window_workspace_projection SET workspace_json = ? WHERE window_id = ?")
        .run(JSON.stringify(workspaceWithUnsupportedCodeTab(titleFields)), ids.window);

      // The welcome surface carries canonical copy, so a garbage persisted
      // title can never enter renderer state.
      expect(readWindowWorkspace(connection, ids.window)?.workspace.layouts.code).toMatchObject({
        kind: "pane",
        surface: { kind: "welcome", title: "Welcome to Code" },
      });
      connection.close();
    },
  );

  it("decodes persisted settings rows instead of silently recovering invalid JSON", () => {
    const connection = openConnection();
    appendShellEvents(connection);
    connection
      .prepare("UPDATE shell_settings_projection SET settings_json = ?")
      .run(JSON.stringify({ ...settings, sidebarWidth: 999 }));

    expect(() => readShellSettings(connection)).toThrow();
    connection.close();
  });

  it("restores an unreadable workspace row as the default welcome workspace at its projected version", () => {
    const connection = openConnection();
    appendShellEvents(connection);
    connection
      .prepare("UPDATE window_workspace_projection SET workspace_json = ? WHERE window_id = ?")
      .run(JSON.stringify({ ...workspace, activeMode: "invalid" }), ids.window);

    const restored = readWindowWorkspace(connection, ids.window);
    expect(restored?.workspace.windowId).toBe(ids.window);
    expect(restored?.workspace.layouts.code).toMatchObject({
      kind: "pane",
      surface: { kind: "welcome" },
    });
    // The projected version survives the fallback so the next command does
    // not conflict against the journal.
    expect(restored?.workspace.version).toBe(1);
    expect(restored?.aggregateVersion).toBe(1);
    connection.close();
  });

  it("still refuses a workspace row whose window identity is unreadable", () => {
    const connection = openConnection();
    appendShellEvents(connection);
    connection
      .prepare("UPDATE window_workspace_projection SET workspace_json = ? WHERE window_id = ?")
      .run(JSON.stringify({ activeMode: "invalid" }), ids.window);

    expect(() => readWindowWorkspace(connection, ids.window)).toThrow();
    connection.close();
  });

  it.each([
    ["aggregate type", { aggregateType: "wrong-window-workspace" }],
    ["aggregate ID", { aggregateId: "00000000-0000-4000-8000-000000000199" }],
    ["aggregate version", { aggregateVersion: 2 }],
  ])("quarantines a replayed workspace event with the wrong %s", (_name, override) => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const projection = runtime.projections.get("shell")!;
    insertJournalEvent(connection, workspaceEnvelope(override));

    expect(() => rebuildProjection({ connection, journal, projection, clock: () => now })).toThrow(
      ProjectionQuarantined,
    );

    expect(readWindowWorkspace(connection, ids.window)).toBeUndefined();
    expect(
      connection
        .prepare(
          "SELECT projection_name, global_sequence, reason FROM event_quarantine WHERE projection_name = ?",
        )
        .get("shell"),
    ).toEqual({
      projection_name: "shell",
      global_sequence: 1,
      reason: "projection-application-failed",
    });
    connection.close();
  });
});

function envelope(input: {
  readonly aggregateVersion: number;
  readonly eventName: string;
  readonly payload: unknown;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
}): EventEnvelope {
  return {
    eventId: ids.settingsEvent,
    globalSequence: 1,
    aggregateType: input.aggregateType ?? "shell-settings",
    aggregateId: input.aggregateId ?? ids.settingsAggregate,
    aggregateVersion: input.aggregateVersion,
    eventName: input.eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
    payload: input.payload,
  } as EventEnvelope;
}

function legacySettings() {
  return {
    chatEnabled: false,
    workEnabled: true,
    sidebarWidth: 320,
    sidebarMaterial: "opaque",
  } as const;
}

function workspaceEnvelope(
  override: Partial<{
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly payload: unknown;
  }> = {},
): EventEnvelope {
  return {
    ...envelope({
      aggregateVersion: override.aggregateVersion ?? 1,
      eventName: "workspace.layout-replaced",
      payload: override.payload ?? { workspace },
      aggregateType: override.aggregateType ?? "window-workspace",
      aggregateId: override.aggregateId ?? ids.window,
    }),
    eventId: ids.workspaceEvent,
  } as EventEnvelope;
}

function insertJournalEvent(connection: SqliteConnection, event: EventEnvelope): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, correlation_id, causation_id, actor_kind,
        actor_id, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      event.globalSequence,
      event.eventId,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.eventName,
      event.eventVersion,
      event.correlationId,
      event.causationId ?? null,
      event.actor.kind,
      event.actor.actorId,
      event.occurredAt,
      JSON.stringify(event.payload),
    );
}

// A legacy tab-group leaf holding a tab kind this version does not know;
// migration collapses the group and renders welcome in the resulting pane.
function workspaceWithUnsupportedCodeTab(
  titleFields: Readonly<Record<string, unknown>> = { title: "Recovered editor" },
) {
  return {
    ...workspace,
    layouts: {
      ...workspace.layouts,
      code: {
        kind: "group",
        nodeId: "30000000-0000-4000-8000-000000000001",
        groupId: "30000000-0000-4000-8000-000000000002",
        tabs: [
          {
            kind: "editor-v2",
            id: "30000000-0000-4000-8000-000000000003",
            ...titleFields,
            documentId: "future-document",
          },
        ],
        activeTabId: "30000000-0000-4000-8000-000000000003",
      },
    },
  } as const;
}
