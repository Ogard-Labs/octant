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
  decodePersistedWindowWorkspace,
  UNAVAILABLE_PERSISTED_TAB_REASON,
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
    chat: group("1", "chat"),
    work: group("2", "work"),
    code: group("3", "code"),
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
});

function group(prefix: string, mode: "chat" | "work" | "code") {
  return {
    kind: "group" as const,
    nodeId: `${prefix}0000000-0000-4000-8000-000000000001`,
    groupId: `${prefix}0000000-0000-4000-8000-000000000002`,
    tabs: [
      {
        kind: "welcome" as const,
        id: `${prefix}0000000-0000-4000-8000-000000000003`,
        mode,
        title: `Welcome to ${mode}`,
      },
    ],
    activeTabId: `${prefix}0000000-0000-4000-8000-000000000003`,
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
  it("restores persisted Project tabs without downgrading them to unavailable", () => {
    const code = workspace.layouts.code;
    if (code.kind !== "group") throw new Error("fixture code layout must be a group");
    const projectTab = {
      kind: "project" as const,
      id: code.tabs[0]!.id,
      projectId: "60000000-0000-4000-8000-000000000020",
      mode: "code" as const,
      title: "Octant",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, code: { ...code, tabs: [projectTab] } },
      }).layouts.code,
    ).toMatchObject({ tabs: [projectTab] });
  });

  it("restores persisted Chat thread tabs without downgrading them to unavailable", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "group") throw new Error("fixture chat layout must be a group");
    const chatThreadTab = {
      kind: "chat-thread" as const,
      id: chat.tabs[0]!.id,
      threadId: "70000000-0000-4000-8000-000000000021",
      mode: "chat" as const,
      title: "Planning",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, chat: { ...chat, tabs: [chatThreadTab] } },
      }).layouts.chat,
    ).toMatchObject({ tabs: [chatThreadTab] });
  });

  it("restores persisted Code tabs without downgrading them to unavailable", () => {
    const code = workspace.layouts.code;
    if (code.kind !== "group") throw new Error("fixture Code layout must be a group");
    const codeTab = {
      kind: "code-file" as const,
      id: code.tabs[0]!.id,
      threadId: "70000000-0000-4000-8000-000000000022",
      mode: "code" as const,
      title: "code.ts",
      relativePath: "packages/contracts/src/code.ts",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, code: { ...code, tabs: [codeTab] } },
      }).layouts.code,
    ).toMatchObject({ tabs: [codeTab] });
  });

  it("restores a Side Chat tab with its sidecar identity intact", () => {
    const work = workspace.layouts.work;
    if (work.kind !== "group") throw new Error("fixture Work layout must be a group");
    const sideChatTab = {
      kind: "side-chat" as const,
      id: work.tabs[0]!.id,
      mode: "work" as const,
      title: "Side Chat about Release notes",
      sourceThreadId: "70000000-0000-4000-8000-000000000041",
      sidecarThreadId: "70000000-0000-4000-8000-000000000042",
    };

    expect(
      decodePersistedWindowWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, work: { ...work, tabs: [sideChatTab] } },
      }).layouts.work,
    ).toMatchObject({ tabs: [sideChatTab] });
  });

  it("fails a Side Chat tab closed when it names no sidecar to restore", () => {
    const work = workspace.layouts.work;
    if (work.kind !== "group") throw new Error("fixture Work layout must be a group");
    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        work: {
          ...work,
          tabs: [
            {
              kind: "side-chat",
              id: work.tabs[0]!.id,
              mode: "work",
              title: "Side Chat",
            },
          ],
        },
      },
    }).layouts.work;
    if (restored.kind !== "group") throw new Error("restored Work layout must be a group");
    expect(restored.tabs[0]).toMatchObject({
      kind: "unavailable",
      title: "Side Chat",
      reason: UNAVAILABLE_PERSISTED_TAB_REASON,
    });
  });

  it("preserves draft-thread and work-thread tabs when mode matches", () => {
    const code = workspace.layouts.code;
    const work = workspace.layouts.work;
    if (code.kind !== "group") throw new Error("fixture Code layout must be a group");
    if (work.kind !== "group") throw new Error("fixture Work layout must be a group");

    const draftTab = {
      kind: "draft-thread" as const,
      id: code.tabs[0]!.id,
      mode: "code" as const,
      title: "New Code thread",
      projectId: "10000000-0000-4000-8000-000000000001",
    };
    const workThreadTab = {
      kind: "work-thread" as const,
      id: work.tabs[0]!.id,
      threadId: "70000000-0000-4000-8000-000000000031",
      mode: "work" as const,
      title: "Brief draft",
    };

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        code: { ...code, tabs: [draftTab], activeTabId: draftTab.id },
        work: { ...work, tabs: [workThreadTab], activeTabId: workThreadTab.id },
      },
    });
    const restoredCode = restored.layouts.code;
    const restoredWork = restored.layouts.work;
    if (restoredCode.kind !== "group") throw new Error("restored Code layout must be a group");
    if (restoredWork.kind !== "group") throw new Error("restored Work layout must be a group");
    expect(restoredCode.tabs[0]).toEqual(draftTab);
    expect(restoredWork.tabs[0]).toEqual(workThreadTab);
  });

  it("recovers thread tabs found outside their mode layouts", () => {
    const chat = workspace.layouts.chat;
    const code = workspace.layouts.code;
    if (chat.kind !== "group") throw new Error("fixture Chat layout must be a group");
    if (code.kind !== "group") throw new Error("fixture Code layout must be a group");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        chat: {
          ...chat,
          tabs: [
            {
              kind: "draft-thread",
              id: chat.tabs[0]!.id,
              mode: "code",
              title: "New Code thread",
            },
          ],
        },
        code: {
          ...code,
          tabs: [
            {
              kind: "work-thread",
              id: code.tabs[0]!.id,
              threadId: "70000000-0000-4000-8000-000000000031",
              mode: "work",
              title: "Brief draft",
            },
          ],
        },
      },
    });
    const restoredChat = restored.layouts.chat;
    const restoredCode = restored.layouts.code;
    if (restoredChat.kind !== "group") throw new Error("restored Chat layout must be a group");
    if (restoredCode.kind !== "group") throw new Error("restored Code layout must be a group");
    expect(restoredChat.tabs[0]).toMatchObject({
      kind: "unavailable",
      title: "New Code thread",
    });
    expect(restoredCode.tabs[0]).toMatchObject({
      kind: "unavailable",
      title: "Brief draft",
    });
  });

  it("recovers malformed thread tabs through the unavailable-tab path", () => {
    const work = workspace.layouts.work;
    if (work.kind !== "group") throw new Error("fixture Work layout must be a group");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        work: {
          ...work,
          tabs: [
            {
              kind: "work-thread",
              id: work.tabs[0]!.id,
              mode: "work",
              title: "Missing thread identity",
            },
          ],
        },
      },
    });
    const restoredWork = restored.layouts.work;
    if (restoredWork.kind !== "group") throw new Error("restored Work layout must be a group");
    expect(restoredWork.tabs[0]).toMatchObject({
      kind: "unavailable",
      title: "Missing thread identity",
    });
  });

  it("recovers a persisted Code tab found outside the Code layout", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "group") throw new Error("fixture Chat layout must be a group");
    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        chat: {
          ...chat,
          tabs: [
            {
              kind: "code-overview",
              id: chat.tabs[0]!.id,
              threadId: "70000000-0000-4000-8000-000000000022",
              mode: "code",
              title: "Overview",
            },
          ],
        },
      },
    });
    const restoredChat = restored.layouts.chat;
    if (restoredChat.kind !== "group") throw new Error("restored Chat layout must be a group");
    expect(restoredChat.tabs[0]).toMatchObject({ kind: "unavailable", title: "Overview" });
  });

  it("recovers a malformed persisted Chat thread tab through the unavailable-tab path", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "group") throw new Error("fixture chat layout must be a group");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        chat: {
          ...chat,
          tabs: [
            {
              kind: "chat-thread",
              id: chat.tabs[0]!.id,
              mode: "chat",
              title: "Planning",
              legacyTranscript: "must not enter renderer state",
            },
          ],
        },
      },
    });
    const restoredChat = restored.layouts.chat;
    if (restoredChat.kind !== "group") throw new Error("restored Chat layout must be a group");
    expect(restoredChat.tabs[0]).toEqual({
      kind: "unavailable",
      id: chat.tabs[0]!.id,
      title: "Planning",
      reason: "This tab type is unavailable in this version of Octant.",
    });
  });

  it("recovers a persisted Chat thread tab found outside the Chat layout", () => {
    const code = workspace.layouts.code;
    if (code.kind !== "group") throw new Error("fixture Code layout must be a group");

    const restored = decodePersistedWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        code: {
          ...code,
          tabs: [
            {
              kind: "chat-thread",
              id: code.tabs[0]!.id,
              threadId: "70000000-0000-4000-8000-000000000021",
              mode: "chat",
              title: "Planning",
            },
          ],
        },
      },
    });
    const restoredCode = restored.layouts.code;
    if (restoredCode.kind !== "group") throw new Error("restored Code layout must be a group");
    expect(restoredCode.tabs[0]).toMatchObject({
      kind: "unavailable",
      id: code.tabs[0]!.id,
      title: "Planning",
    });
  });

  it("replays a valid Chat thread tab through the durable shell projection", () => {
    const chat = workspace.layouts.chat;
    if (chat.kind !== "group") throw new Error("fixture chat layout must be a group");
    const chatThreadTab = {
      kind: "chat-thread" as const,
      id: chat.tabs[0]!.id,
      threadId: "70000000-0000-4000-8000-000000000021",
      mode: "chat" as const,
      title: "Planning",
    };
    const durableWorkspace = decodeWindowWorkspace({
      ...workspace,
      layouts: { ...workspace.layouts, chat: { ...chat, tabs: [chatThreadTab] } },
    });
    const connection = openConnection();

    appendShellEvents(connection, durableWorkspace);

    expect(readWindowWorkspace(connection, ids.window)?.workspace.layouts.chat).toMatchObject({
      tabs: [chatThreadTab],
    });
    connection.close();
  });

  it("upcasts legacy workspaces with one deterministic active group per mode", () => {
    const { activeGroupIds: _activeGroupIds, ...legacy } = workspace;

    expect(decodePersistedWindowWorkspace(legacy).activeGroupIds).toEqual({
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
          presentation: "pinned",
          pinnedWidth: 360,
        },
      ],
      byMode: { chat: "hidden", work: "floating", code: "pinned" },
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
      presentation,
      aggregateVersion: 1,
    });
    connection.close();
  });

  it("applies environment presentation events idempotently by aggregate version", () => {
    const connection = openConnection();
    const projection = new ShellProjection();
    const presentation = decodeEnvironmentPresentationState({
      byTab: [],
      byMode: { chat: "hidden", work: "floating", code: "pinned" },
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
      code: "pinned",
    });
    expect(restored?.presentation.byTab).toEqual([]);
    connection.close();
  });

  it("rebuilds the final atomic docked layout without an intermediate projection", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const dockedWorkspace = decodeWindowWorkspace({
      ...workspace,
      layouts: {
        ...workspace.layouts,
        code: {
          kind: "split",
          nodeId: "60000000-0000-4000-8000-000000000001",
          orientation: "vertical",
          ratio: 0.5,
          first: group("4", "code"),
          second: group("5", "code"),
        },
      },
      version: 1,
    });
    journal.append({
      aggregate: { aggregateType: "window-workspace", aggregateId: ids.window },
      expectedVersion: 0,
      events: [
        pending(ids.workspaceEvent, "workspace.layout-replaced", { workspace: dockedWorkspace }),
      ],
    });
    const projection = runtime.projections.get("shell")!;

    projection.reset(connection);
    rebuildProjection({ connection, journal, projection, clock: () => now });

    expect(readWindowWorkspace(connection, ids.window)).toEqual({
      workspace: dockedWorkspace,
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
            modeSwitcherPresentation: "buttons",
            sidebarBackground: {
              kind: "none",
              overlayColor: "#1a1a1c",
              overlayOpacity: 100,
              vibrancyMode: "off",
            },
            environmentPresentationByMode: {
              chat: "hidden",
              work: "floating",
              code: "pinned",
            },
          },
        },
      },
    ]);
    rebuildProjection({ connection, journal, projection, clock: () => now });

    expect(readShellSettings(connection)).toEqual({
      settings: {
        ...legacyPayload.settings,
        contextSidebarWidth: 360,
        lastContextSurface: null,
        modeSwitcherPresentation: "buttons",
        sidebarBackground: {
          kind: "none",
          overlayColor: "#1a1a1c",
          overlayOpacity: 100,
          vibrancyMode: "off",
        },
        environmentPresentationByMode: {
          chat: "hidden",
          work: "floating",
          code: "pinned",
        },
        // A pre-onboarding store already finished its first run; the upcast
        // stamps `completed` so an upgrade never re-runs the walkthrough.
        firstRunOnboarding: "completed",
        // A store persisted before Navigator shipped decodes to the empty
        // section: both roles absent, so Navigator reports unconfigured.
        navigatorAssistant: {},
        projectViewSwitcherPresentation: "dropdown",
      },
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

    expect(readWindowWorkspace(connection, ids.window)?.workspace.layouts.code).toMatchObject({
      kind: "group",
      tabs: [
        {
          kind: "unavailable",
          id: unsupported.layouts.code.tabs[0]!.id,
          title: "Recovered editor",
          reason: "This tab type is unavailable in this version of Octant.",
        },
      ],
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
      kind: "group",
      tabs: [
        {
          kind: "unavailable",
          id: unsupported.layouts.code.tabs[0]!.id,
          title: "Recovered editor",
        },
      ],
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
      settings: {
        ...legacy,
        contextSidebarWidth: 360,
        lastContextSurface: null,
        modeSwitcherPresentation: "buttons",
        sidebarBackground: {
          kind: "none",
          overlayColor: "#1a1a1c",
          overlayOpacity: 100,
          vibrancyMode: "off",
        },
        environmentPresentationByMode: {
          chat: "hidden",
          work: "floating",
          code: "pinned",
        },
        // A pre-onboarding store already finished its first run; the upcast
        // stamps `completed` so an upgrade never re-runs the walkthrough.
        firstRunOnboarding: "completed",
        // A store persisted before Navigator shipped decodes to the empty
        // section: both roles absent, so Navigator reports unconfigured.
        navigatorAssistant: {},
        projectViewSwitcherPresentation: "dropdown",
      },
      aggregateVersion: 1,
    });
    expect(
      connection
        .prepare("SELECT settings_json FROM shell_settings_projection WHERE projection_key = ?")
        .get("shell-settings"),
    ).toEqual({ settings_json: JSON.stringify(legacy) });
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
        settings: { ...current, modeSwitcherPresentation: "buttons" },
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
      { ...legacySettings(), contextSidebarWidth: 641, lastContextSurface: null },
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
  ])("rejects an unsupported projected tab with a %s title", (_name, titleFields) => {
    const connection = openConnection();
    appendShellEvents(connection);
    connection
      .prepare("UPDATE window_workspace_projection SET workspace_json = ? WHERE window_id = ?")
      .run(JSON.stringify(workspaceWithUnsupportedCodeTab(titleFields)), ids.window);

    expect(() => readWindowWorkspace(connection, ids.window)).toThrow();
    connection.close();
  });

  it("decodes persisted rows instead of silently recovering invalid JSON", () => {
    const connection = openConnection();
    appendShellEvents(connection);
    connection
      .prepare("UPDATE shell_settings_projection SET settings_json = ?")
      .run(JSON.stringify({ ...settings, sidebarWidth: 999 }));
    connection
      .prepare("UPDATE window_workspace_projection SET workspace_json = ? WHERE window_id = ?")
      .run(JSON.stringify({ ...workspace, activeMode: "invalid" }), ids.window);

    expect(() => readShellSettings(connection)).toThrow();
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

function workspaceWithUnsupportedCodeTab(
  titleFields: Readonly<Record<string, unknown>> = { title: "Recovered editor" },
) {
  const code = workspace.layouts.code;
  if (code.kind !== "group") throw new Error("fixture code layout must be a group");
  return {
    ...workspace,
    layouts: {
      ...workspace.layouts,
      code: {
        ...code,
        tabs: [
          {
            kind: "editor-v2",
            id: code.tabs[0]!.id,
            ...titleFields,
            documentId: "future-document",
          },
        ],
      },
    },
  } as const;
}
