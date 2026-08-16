import {
  decodeEnvironmentPresentationState,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeProjectId,
  decodeRootlessThreadId,
  decodeShellCommand,
  decodeShellSettings,
  decodeWindowId,
  type ShellCommand,
  type Project,
  type WindowWorkspace,
  LOCAL_HOST_ID,
} from "@octant/contracts";
import {
  applyWorkspaceOperation,
  defaultEnvironmentPresentationState,
  defaultShellSettings,
  defaultWindowWorkspace,
  resolveSurfaceDescriptors,
} from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { CanvasProjection } from "./canvas/canvasProjection";
import { ConcurrencyConflict, JournalWriteFailed } from "./persistence/journalErrors";
import type { PersistenceService } from "./persistence/persistenceService";
import { SHELL_SETTINGS_AGGREGATE_ID } from "./persistence/shellProjection";
import { OCTANT_LOCAL_ACTOR_ID, ShellService } from "./shellService";

const ids = {
  correlation: "00000000-0000-4000-8000-000000000201",
  event: "00000000-0000-4000-8000-000000000202",
  window: decodeWindowId("00000000-0000-4000-8000-000000000203"),
  otherWindow: decodeWindowId("00000000-0000-4000-8000-000000000204"),
} as const;
const now = "2026-07-13T12:00:00.000Z";
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000205");

describe("ShellService", () => {
  it("requires an active matching Project before appending a Project tab", () => {
    const workspace = defaultWindowWorkspace(ids.window);
    const codeLayout = workspace.layouts.code;
    if (codeLayout.kind !== "group") throw new Error("expected group");
    const operation = {
      kind: "open-tab" as const,
      mode: "code" as const,
      groupId: codeLayout.groupId,
      tab: {
        kind: "project" as const,
        id: "00000000-0000-4000-8000-000000000206" as never,
        projectId,
        mode: "code" as const,
        title: "Project",
      },
    };
    for (const project of [
      undefined,
      projectFixture("chat"),
      { ...projectFixture("code"), lifecycle: "archived" as const },
    ]) {
      const fixture = persistenceStub({ project });
      const service = new ShellService({
        persistence: fixture.persistence,
        uuid: uuidSequence(),
        clock: () => now,
      });
      service.bootstrap(ids.window);
      expect(() =>
        service.execute({
          kind: "apply-workspace-operation",
          windowId: ids.window,
          expectedVersion: 0,
          operation,
        }),
      ).toThrowError(
        expect.objectContaining({ failure: { category: "invalid", message: expect.any(String) } }),
      );
      expect(fixture.append).not.toHaveBeenCalled();
    }
    const accepted = persistenceStub({ project: projectFixture("code") });
    const service = new ShellService({
      persistence: accepted.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);
    expect(
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 0,
        operation,
      }),
    ).toMatchObject({ kind: "workspace-replaced" });
  });

  it("rejects opening a Project tab bound to a different context with a cross-context failure", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const otherProject = decodeProjectId("00000000-0000-4000-8000-000000000210");
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: {
          host: base.contextByMode.code.host,
          mode: "code",
          projectId: otherProject,
          boundRoot: "/home/other",
        },
      },
    };
    const otherProjectFixture: Project = {
      ...projectFixture("code"),
      id: otherProject,
      binding: { canonicalRoot: "/home/other" },
    } as never;
    const fixture = persistenceStub({
      workspace: { workspace: anchored, aggregateVersion: 1 as never },
      projectFor: (id) =>
        id === otherProject ? (otherProjectFixture as never) : (projectFixture("code") as never),
    });
    const service = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);
    const operation = {
      kind: "open-tab" as const,
      mode: "code" as const,
      groupId: code.groupId,
      tab: {
        kind: "project" as const,
        id: "00000000-0000-4000-8000-000000000211" as never,
        projectId,
        mode: "code" as const,
        title: "Project",
      },
    };
    expect(() =>
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 1,
        operation,
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          category: "cross-context",
          message: expect.any(String),
          offerNewWindow: true,
        }),
      }),
    );
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("atomically switches an existing window to another active Project", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const otherProject = decodeProjectId("00000000-0000-4000-8000-000000000210");
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        ...base.contextByMode,
        code: {
          host: base.contextByMode.code.host,
          mode: "code",
          projectId: otherProject,
          boundRoot: "/home/other",
        },
      },
    };
    const fixture = persistenceStub({
      workspace: { workspace: anchored, aggregateVersion: 1 as never },
      project: projectFixture("code"),
    });
    const service = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);
    const result = service.execute({
      kind: "apply-workspace-operation",
      windowId: ids.window,
      expectedVersion: 1,
      operation: {
        kind: "switch-project-tab",
        mode: "code",
        tab: {
          kind: "project",
          id: "00000000-0000-4000-8000-000000000211" as never,
          projectId,
          mode: "code",
          title: "Project",
        },
      },
    });

    expect(result).toMatchObject({
      kind: "workspace-replaced",
      workspace: { contextByMode: { code: { projectId, boundRoot: "/repo" } } },
    });
    expect(fixture.append).toHaveBeenCalledOnce();
  });

  it("resolves a bound Work thread to its active Project context", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "work" as const };
    const work = base.layouts.work;
    if (work.kind !== "group") throw new Error("expected group");
    const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000212");
    const thread = decodeWorkThread({
      id: threadId,
      projectId,
      title: "Bound Work thread",
      lifecycle: "active",
      providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
      modelId: "model-one",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const fixture = persistenceStub({ project: projectFixture("work") });
    const service = new ShellService({
      persistence: fixture.persistence,
      readWorkThread: (candidate) => (candidate === threadId ? thread : undefined),
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);

    const result = service.execute({
      kind: "apply-workspace-operation",
      windowId: ids.window,
      expectedVersion: 0,
      operation: {
        kind: "open-tab",
        mode: "work",
        groupId: work.groupId,
        tab: {
          kind: "work-thread",
          id: "00000000-0000-4000-8000-000000000213" as never,
          threadId,
          mode: "work",
          title: thread.title,
        },
      },
    });

    expect(result).toMatchObject({
      kind: "workspace-replaced",
      workspace: { contextByMode: { work: { projectId, boundRoot: "/home/folder" } } },
    });
    expect(fixture.append).toHaveBeenCalledTimes(1);
  });

  it("resolves attached rootless Work and Code threads to their authoritative Project", () => {
    for (const [mode, suffix, boundRoot] of [
      ["work", "214", "/home/folder"],
      ["code", "215", "/repo"],
    ] as const) {
      const base = { ...defaultWindowWorkspace(ids.window), activeMode: mode };
      const layout = base.layouts[mode];
      if (layout.kind !== "group") throw new Error("expected group");
      const threadId = decodeRootlessThreadId(`00000000-0000-4000-8000-000000000${suffix}`);
      const fixture = persistenceStub({ project: projectFixture(mode) });
      const service = new ShellService({
        persistence: fixture.persistence,
        readRootlessThread: (candidate) =>
          candidate === threadId
            ? ({
                threadId,
                title: `Attached ${mode}`,
                mode,
                hostId: LOCAL_HOST_ID,
                workspaceKind: "project-backed",
                projectId,
              } as never)
            : undefined,
        uuid: uuidSequence(),
        clock: () => now,
      });
      service.bootstrap(ids.window);

      const result = service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 0,
        operation: {
          kind: "open-tab",
          mode,
          groupId: layout.groupId,
          tab: {
            kind: mode === "work" ? "work-thread" : "code-overview",
            id: `00000000-0000-4000-8000-0000000003${suffix.slice(-2)}`,
            threadId,
            mode,
            title: `Attached ${mode}`,
            hostId: LOCAL_HOST_ID,
          },
        },
      });

      expect(result).toMatchObject({
        kind: "workspace-replaced",
        workspace: { contextByMode: { [mode]: { projectId, boundRoot } } },
      });
    }
  });

  it("keeps an unfiled rootless thread out of a bound Project workspace", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const threadId = decodeRootlessThreadId("00000000-0000-4000-8000-000000000216");
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        ...base.contextByMode,
        code: {
          host: LOCAL_HOST_ID,
          mode: "code",
          projectId,
          boundRoot: "/repo",
        },
      },
    };
    const fixture = persistenceStub({
      project: projectFixture("code"),
      workspace: { workspace: anchored, aggregateVersion: 1 as never },
    });
    const service = new ShellService({
      persistence: fixture.persistence,
      readRootlessThread: () =>
        ({
          threadId,
          title: "Unfiled code",
          mode: "code",
          hostId: LOCAL_HOST_ID,
          workspaceKind: "rootless",
          projectId: null,
        }) as never,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);

    expect(() =>
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 1,
        operation: {
          kind: "open-tab",
          mode: "code",
          groupId: code.groupId,
          tab: {
            kind: "code-overview",
            id: "00000000-0000-4000-8000-000000000317",
            threadId,
            mode: "code",
            title: "Unfiled code",
            hostId: LOCAL_HOST_ID,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ category: "cross-context" }),
      }),
    );
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("fails closed when an attached rootless projection no longer matches its authority", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const threadId = decodeRootlessThreadId("00000000-0000-4000-8000-000000000218");
    for (const scenario of [
      {
        mode: "code" as const,
        hostId: LOCAL_HOST_ID,
        project: { ...projectFixture("code"), lifecycle: "archived" as const } as Project,
      },
      {
        mode: "work" as const,
        hostId: LOCAL_HOST_ID,
        project: projectFixture("code"),
      },
    ]) {
      const fixture = persistenceStub({ project: scenario.project });
      const service = new ShellService({
        persistence: fixture.persistence,
        readRootlessThread: () =>
          ({
            threadId,
            title: "Stale attached code",
            mode: scenario.mode,
            hostId: scenario.hostId,
            workspaceKind: "project-backed",
            projectId,
          }) as never,
        uuid: uuidSequence(),
        clock: () => now,
      });
      service.bootstrap(ids.window);

      expect(() =>
        service.execute({
          kind: "apply-workspace-operation",
          windowId: ids.window,
          expectedVersion: 0,
          operation: {
            kind: "open-tab",
            mode: "code",
            groupId: code.groupId,
            tab: {
              kind: "code-overview",
              id: "00000000-0000-4000-8000-000000000319",
              threadId,
              mode: "code",
              title: "Stale attached code",
              hostId: LOCAL_HOST_ID,
            },
          },
        }),
      ).toThrowError(
        expect.objectContaining({
          failure: expect.objectContaining({ category: "cross-context" }),
        }),
      );
      expect(fixture.append).not.toHaveBeenCalled();
    }
  });

  it("does not grant Code tool surfaces to an attached historical rootless thread", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const threadId = decodeRootlessThreadId("00000000-0000-4000-8000-000000000219");
    const fixture = persistenceStub({ project: projectFixture("code") });
    const service = new ShellService({
      persistence: fixture.persistence,
      readRootlessThread: () =>
        ({
          threadId,
          title: "Attached historical code",
          mode: "code",
          hostId: LOCAL_HOST_ID,
          workspaceKind: "project-backed",
          projectId,
        }) as never,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);

    expect(() =>
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 0,
        operation: {
          kind: "open-tab",
          mode: "code",
          groupId: code.groupId,
          tab: {
            kind: "code-terminal",
            id: "00000000-0000-4000-8000-000000000320",
            threadId,
            mode: "code",
            title: "Terminal",
            hostId: LOCAL_HOST_ID,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ category: "cross-context" }),
      }),
    );
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("keeps archived restored Project tabs but presents missing or mismatched tabs as unavailable", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const restored = {
      ...base,
      layouts: {
        ...base.layouts,
        code: {
          ...code,
          tabs: [
            { kind: "project", id: code.tabs[0]!.id, projectId, mode: "code", title: "Saved" },
          ],
          activeTabId: code.tabs[0]!.id,
        },
      },
    } as never;
    const archivedPersistence = persistenceStub({
      workspace: { workspace: restored, aggregateVersion: 2 as never },
      project: { ...projectFixture("code"), lifecycle: "archived" } as never,
    });
    expect(
      new ShellService({
        persistence: archivedPersistence.persistence,
        uuid: uuidSequence(),
        clock: () => now,
      }).bootstrap(ids.window).workspace.layouts.code,
    ).toMatchObject({ tabs: [{ kind: "project" }] });
    for (const project of [undefined, projectFixture("chat")]) {
      const persistence = persistenceStub({
        workspace: { workspace: restored, aggregateVersion: 2 as never },
        project,
      });
      expect(
        new ShellService({
          persistence: persistence.persistence,
          uuid: uuidSequence(),
          clock: () => now,
        }).bootstrap(ids.window).workspace.layouts.code,
      ).toMatchObject({ tabs: [{ kind: "unavailable", reason: expect.any(String) }] });
      expect(persistence.append).not.toHaveBeenCalled();
    }
  });

  it("keeps restored preview tabs bound to the active Project and quarantines stale ones", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "work" as const };
    const work = base.layouts.work;
    if (work.kind !== "group") throw new Error("expected group");
    const boundPreviewTab = {
      kind: "preview" as const,
      id: work.tabs[0]!.id,
      mode: "work" as const,
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file" as const,
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    };
    const restored = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: {
          host: base.contextByMode.work.host,
          mode: "work" as const,
          projectId,
          boundRoot: "/home/folder",
        },
        code: base.contextByMode.code,
      },
      layouts: {
        ...base.layouts,
        work: { ...work, tabs: [boundPreviewTab], activeTabId: boundPreviewTab.id },
      },
    } as never;
    // Active matching Project: preview tab stays durable so the renderer can
    // reopen it through the existing preview contracts.
    const activeFixture = persistenceStub({
      workspace: { workspace: restored, aggregateVersion: 2 as never },
      project: projectFixture("work") as never,
    });
    const activeBootstrap = new ShellService({
      persistence: activeFixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    const activeTab =
      activeBootstrap.workspace.layouts.work.kind === "group"
        ? activeBootstrap.workspace.layouts.work.tabs[0]
        : undefined;
    expect(activeTab?.kind).toBe("preview");
    expect(activeFixture.append).not.toHaveBeenCalled();
    // Archived/missing Project: preview tab restores as unavailable so the
    // host never guesses a replacement file.
    for (const project of [
      undefined,
      { ...projectFixture("work"), lifecycle: "archived" as const },
    ] as ReadonlyArray<ReturnType<PersistenceService["readProject"]>>) {
      const staleFixture = persistenceStub({
        workspace: { workspace: restored, aggregateVersion: 2 as never },
        project,
      });
      const staleBootstrap = new ShellService({
        persistence: staleFixture.persistence,
        uuid: uuidSequence(),
        clock: () => now,
      }).bootstrap(ids.window);
      const staleTab =
        staleBootstrap.workspace.layouts.work.kind === "group"
          ? staleBootstrap.workspace.layouts.work.tabs[0]
          : undefined;
      expect(staleTab?.kind).toBe("unavailable");
      expect(staleFixture.append).not.toHaveBeenCalled();
    }
  });

  it("keeps restored canvas tabs bound and quarantines missing projection rows", () => {
    const projection = new CanvasProjection();
    const canvasId = "11111111-1111-4111-8111-111111111111" as never;
    projection.applyCreated({
      canvasId,
      version: {
        schemaVersion: 1,
        canvasId,
        versionId: "22222222-2222-4222-8222-222222222222" as never,
        sequence: 1,
        definition: {
          schemaVersion: 1,
          title: "Quarterly summary",
          provenance: {
            mode: "chat",
            hostId: "local" as never,
            projectId,
            threadId: "99999999-9999-4999-8999-999999999999" as never,
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
            modelId: "octant-test-model" as never,
            createdAt: now as never,
          },
          sourceManifest: [],
          blocks: [
            {
              blockId: "block-1" as never,
              schemaVersion: 1,
              kind: "heading",
              level: 1,
              text: "A bounded Canvas",
            },
          ],
        },
        createdBy: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        createdAt: now as never,
      },
    });
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "chat" as const };
    const chat = base.layouts.chat;
    if (chat.kind !== "group") throw new Error("expected group");
    const canvasTab = {
      kind: "canvas" as const,
      id: chat.tabs[0]!.id,
      mode: "chat" as const,
      title: "Quarterly summary",
      canvasId,
      projectId,
    };
    const restored = {
      ...base,
      contextByMode: {
        chat: {
          host: base.contextByMode.chat.host,
          mode: "chat" as const,
          projectId,
          boundRoot: null,
        },
        work: base.contextByMode.work,
        code: base.contextByMode.code,
      },
      layouts: {
        ...base.layouts,
        chat: { ...chat, tabs: [canvasTab], activeTabId: canvasTab.id },
      },
    } as never;
    const activeFixture = persistenceStub({
      workspace: { workspace: restored, aggregateVersion: 2 as never },
      project: projectFixture("chat") as never,
      canvasProjection: projection,
    });
    const activeBootstrap = new ShellService({
      persistence: activeFixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    const activeTab =
      activeBootstrap.workspace.layouts.chat.kind === "group"
        ? activeBootstrap.workspace.layouts.chat.tabs[0]
        : undefined;
    expect(activeTab?.kind).toBe("canvas");
    projection.clear();
    const missingFixture = persistenceStub({
      workspace: { workspace: restored, aggregateVersion: 2 as never },
      project: projectFixture("chat") as never,
      canvasProjection: projection,
    });
    const missingBootstrap = new ShellService({
      persistence: missingFixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    const missingTab =
      missingBootstrap.workspace.layouts.chat.kind === "group"
        ? missingBootstrap.workspace.layouts.chat.tabs[0]
        : undefined;
    expect(missingTab?.kind).toBe("unavailable");
  });

  it("requires an active matching Project before appending a preview tab", () => {
    const workspace = defaultWindowWorkspace(ids.window);
    const workLayout = workspace.layouts.work;
    if (workLayout.kind !== "group") throw new Error("expected group");
    const previewTab = {
      kind: "preview" as const,
      id: "00000000-0000-4000-8000-000000000206" as never,
      mode: "work" as const,
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file" as const,
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    };
    for (const project of [
      undefined,
      projectFixture("chat"),
      { ...projectFixture("work"), lifecycle: "archived" as const },
    ] as ReadonlyArray<ReturnType<PersistenceService["readProject"]>>) {
      const fixture = persistenceStub({ project });
      const service = new ShellService({
        persistence: fixture.persistence,
        uuid: uuidSequence(),
        clock: () => now,
      });
      service.bootstrap(ids.window);
      expect(() =>
        service.execute({
          kind: "apply-workspace-operation",
          windowId: ids.window,
          expectedVersion: 1,
          operation: {
            kind: "open-tab" as const,
            mode: "work" as const,
            groupId: workLayout.groupId,
            tab: previewTab,
          },
        }),
      ).toThrowError(
        expect.objectContaining({ failure: { category: "invalid", message: expect.any(String) } }),
      );
      expect(fixture.append).not.toHaveBeenCalled();
    }
  });

  it("clears stale context bindings when a bound Project is archived or missing", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const staleWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: {
          host: base.contextByMode.code.host,
          mode: "code" as const,
          projectId,
          boundRoot: "/repo",
        },
      },
    } as never;
    for (const project of [
      undefined,
      { ...projectFixture("code"), lifecycle: "archived" as const },
    ]) {
      const fixture = persistenceStub({
        workspace: { workspace: staleWorkspace, aggregateVersion: 2 as never },
        project: project as never,
      });
      const bootstrap = new ShellService({
        persistence: fixture.persistence,
        uuid: uuidSequence(),
        clock: () => now,
      }).bootstrap(ids.window);
      expect(bootstrap.workspace.contextByMode.code.projectId).toBeNull();
      expect(bootstrap.workspace.contextByMode.code.boundRoot).toBeNull();
      // Surface catalog must fail closed for root-backed surfaces.
      expect(bootstrap.availableSurfaces.code.find((d) => d.kind === "browser")?.available).toBe(
        false,
      );
    }
  });

  it("reconciles stale contexts before resolving execute operations", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const staleWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: {
          host: base.contextByMode.code.host,
          mode: "code" as const,
          projectId,
          boundRoot: "/repo",
        },
      },
    } as never;
    // Project is archived after the workspace was persisted. Without
    // reconcileContextWithProjects in execute, the stale boundRoot would let
    // a Browser open be journaled under stale authority.
    const fixture = persistenceStub({
      workspace: { workspace: staleWorkspace, aggregateVersion: 2 as never },
      project: { ...projectFixture("code"), lifecycle: "archived" as const } as never,
    });
    const service = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);
    const browserTab = {
      kind: "browser" as const,
      id: "00000000-0000-4000-8000-000000000220" as never,
      mode: "code" as const,
      title: "Browser",
    };
    expect(() =>
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 3,
        operation: {
          kind: "open-tab" as const,
          mode: "code" as const,
          groupId: code.groupId,
          tab: browserTab,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          category: "cross-context",
          message: expect.any(String),
          offerNewWindow: true,
        }),
      }),
    );
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("infers context from active Project tabs when upcasting a pre-contextByMode workspace", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const preContextWorkspace = {
      ...base,
      contextByMode: {
        chat: {
          host: base.contextByMode.chat.host,
          mode: "chat" as const,
          projectId: null,
          boundRoot: null,
        },
        work: {
          host: base.contextByMode.work.host,
          mode: "work" as const,
          projectId: null,
          boundRoot: null,
        },
        code: {
          host: base.contextByMode.code.host,
          mode: "code" as const,
          projectId: null,
          boundRoot: null,
        },
      },
      layouts: {
        ...base.layouts,
        code: {
          ...code,
          tabs: [
            {
              kind: "project" as const,
              id: code.tabs[0]!.id,
              projectId,
              mode: "code" as const,
              title: "Project",
            },
          ],
          activeTabId: code.tabs[0]!.id,
        },
      },
    } as never;
    const fixture = persistenceStub({
      workspace: { workspace: preContextWorkspace, aggregateVersion: 2 as never },
      project: projectFixture("code"),
    });
    const bootstrap = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    expect(bootstrap.workspace.contextByMode.code.projectId).toBe(projectId);
    expect(bootstrap.workspace.contextByMode.code.boundRoot).toBe("/repo");
    expect(bootstrap.availableSurfaces.code.find((d) => d.kind === "browser")?.available).toBe(
      true,
    );
  });

  it("converts root-backed tabs to unavailable when clearing stale context at bootstrap", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const withBrowserTab = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: {
          host: base.contextByMode.code.host,
          mode: "code" as const,
          projectId,
          boundRoot: "/repo",
        },
      },
      layouts: {
        ...base.layouts,
        code: {
          ...code,
          tabs: [
            {
              kind: "browser" as const,
              id: code.tabs[0]!.id,
              mode: "code" as const,
              title: "Browser",
            },
          ],
          activeTabId: code.tabs[0]!.id,
        },
      },
    } as never;
    const fixture = persistenceStub({
      workspace: { workspace: withBrowserTab, aggregateVersion: 2 as never },
      project: undefined,
    });
    const bootstrap = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    const restoredTab =
      bootstrap.workspace.layouts.code.kind === "group"
        ? bootstrap.workspace.layouts.code.tabs[0]
        : undefined;
    expect(restoredTab?.kind).toBe("unavailable");
    expect(bootstrap.workspace.contextByMode.code.projectId).toBeNull();
  });

  it("rebinds the context when an active Code Project is relinked to a new root", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const relinkedProject: Project = {
      ...projectFixture("code"),
      binding: { canonicalRoot: "/home/new-root" },
      bindingHistory: [
        {
          revisionId: "00000000-0000-4000-8000-000000000207" as never,
          revision: 1,
          previousBinding: { canonicalRoot: "/repo" },
          currentBinding: { canonicalRoot: "/home/new-root" },
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          changedAt: now as never,
        },
      ],
    } as never;
    const anchored = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: {
          host: base.contextByMode.code.host,
          mode: "code" as const,
          projectId,
          boundRoot: "/repo",
        },
      },
    } as never;
    const fixture = persistenceStub({
      workspace: { workspace: anchored, aggregateVersion: 2 as never },
      project: relinkedProject,
    });
    const bootstrap = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    expect(bootstrap.workspace.contextByMode.code.projectId).toBe(projectId);
    expect(bootstrap.workspace.contextByMode.code.boundRoot).toBe("/home/new-root");
  });

  it("quarantines extra Project tabs when inferring context from a pre-contextByMode workspace", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const otherProject = decodeProjectId("00000000-0000-4000-8000-000000000230");
    const preContextWorkspace = {
      ...base,
      contextByMode: {
        chat: {
          host: base.contextByMode.chat.host,
          mode: "chat" as const,
          projectId: null,
          boundRoot: null,
        },
        work: {
          host: base.contextByMode.work.host,
          mode: "work" as const,
          projectId: null,
          boundRoot: null,
        },
        code: {
          host: base.contextByMode.code.host,
          mode: "code" as const,
          projectId: null,
          boundRoot: null,
        },
      },
      layouts: {
        ...base.layouts,
        code: {
          ...code,
          tabs: [
            {
              kind: "project" as const,
              id: code.tabs[0]!.id,
              projectId,
              mode: "code" as const,
              title: "Project A",
            },
            {
              kind: "project" as const,
              id: "00000000-0000-4000-8000-000000000231" as never,
              projectId: otherProject,
              mode: "code" as const,
              title: "Project B",
            },
          ],
          activeTabId: code.tabs[0]!.id,
        },
      },
    } as never;
    const fixture = persistenceStub({
      workspace: { workspace: preContextWorkspace, aggregateVersion: 2 as never },
      projectFor: (id) =>
        id === otherProject
          ? ({ ...projectFixture("code"), id: otherProject } as never)
          : (projectFixture("code") as never),
    });
    const bootstrap = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    const tabs =
      bootstrap.workspace.layouts.code.kind === "group"
        ? bootstrap.workspace.layouts.code.tabs
        : [];
    expect(tabs.find((t) => t.kind === "project" && t.projectId === projectId)).toBeDefined();
    const otherTab = tabs.find((t) => t.id === ("00000000-0000-4000-8000-000000000231" as never));
    expect(otherTab?.kind).toBe("unavailable");
  });

  it("never journals a bootstrap-only unavailable presentation over its raw Project tab", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const rawProjectTab = {
      kind: "project" as const,
      id: code.tabs[0]!.id,
      projectId,
      mode: "code" as const,
      title: "Recoverable Project",
    };
    const rawWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...code, tabs: [rawProjectTab], activeTabId: rawProjectTab.id },
      },
    };
    const fixture = persistenceStub({
      workspace: { workspace: rawWorkspace, aggregateVersion: 2 as never },
      project: undefined,
    });
    const service = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });

    expect(service.bootstrap(ids.window).workspace.layouts.code).toMatchObject({
      tabs: [{ kind: "unavailable" }],
    });
    expect(rawWorkspace.layouts.code.tabs[0]).toEqual(rawProjectTab);

    const result = service.execute({
      kind: "apply-workspace-operation",
      windowId: ids.window,
      expectedVersion: 2,
      operation: { kind: "focus-group", mode: "code", groupId: code.groupId },
    });

    expect(result).toMatchObject({
      kind: "workspace-replaced",
      workspace: { layouts: { code: { tabs: [{ kind: "unavailable" }] } } },
      version: 3,
    });

    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      events: [
        {
          payload: {
            workspace: {
              layouts: { code: { tabs: [rawProjectTab] } },
              focusedGroupId: code.groupId,
            },
          },
        },
      ],
    });
    if (result.kind !== "workspace-replaced") throw new Error("expected workspace result");
    const appendRequest = fixture.append.mock.calls[0]?.[0];
    if (appendRequest === undefined) throw new Error("expected workspace append");
    const appendedWorkspace = (
      appendRequest as unknown as {
        events: [{ payload: { workspace: typeof rawWorkspace } }];
      }
    ).events[0].payload.workspace;
    expect(result.workspace).not.toBe(appendedWorkspace);
    expect(result.workspace.layouts.code).not.toBe(appendedWorkspace.layouts.code);
    expect(result.workspace.layouts.code).toMatchObject({ tabs: [{ kind: "unavailable" }] });
    expect(appendedWorkspace.layouts.code).toMatchObject({ tabs: [rawProjectTab] });
    expect(service.bootstrap(ids.window).workspace.layouts.code).toMatchObject({
      tabs: [{ kind: "unavailable" }],
    });
  });

  it("closes a stale raw Project tab and returns the updated presentation", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const stale = {
      kind: "project" as const,
      id: "00000000-0000-4000-8000-000000000208" as never,
      projectId,
      mode: "code" as const,
      title: "Stale",
    };
    const rawWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...code, tabs: [...code.tabs, stale], activeTabId: stale.id },
      },
    };
    const fixture = persistenceStub({
      workspace: { workspace: rawWorkspace, aggregateVersion: 2 as never },
    });
    const service = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);

    expect(
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 2,
        operation: { kind: "close-tab", mode: "code", groupId: code.groupId, tabId: stale.id },
      }),
    ).toMatchObject({
      kind: "workspace-replaced",
      workspace: { layouts: { code: { tabs: [{ kind: "welcome" }] } } },
    });
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      events: [{ payload: { workspace: { layouts: { code: { tabs: [{ kind: "welcome" }] } } } } }],
    });
  });

  it("reports recovery safely if post-commit presentation reconciliation fails", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("expected group");
    const rawProjectTab = {
      kind: "project" as const,
      id: code.tabs[0]!.id,
      projectId,
      mode: "code" as const,
      title: "Recoverable Project",
    };
    const rawWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...code, tabs: [rawProjectTab], activeTabId: rawProjectTab.id },
      },
    };
    let reads = 0;
    const fixture = persistenceStub({
      workspace: { workspace: rawWorkspace, aggregateVersion: 2 as never },
      projectFor: () => {
        reads += 1;
        if (reads === 1) return undefined;
        throw new Error("private storage detail");
      },
    });
    const service = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });
    service.bootstrap(ids.window);

    expect(() =>
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 2,
        operation: { kind: "focus-group", mode: "code", groupId: code.groupId },
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: { category: "unavailable", message: "Octant shell state is unavailable." },
      }),
    );
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      events: [{ payload: { workspace: { layouts: { code: { tabs: [rawProjectTab] } } } } }],
    });
  });
  it("synthesizes bootstrap defaults without appending events", () => {
    const { persistence, append } = persistenceStub();
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    const workspace = defaultWindowWorkspace(ids.window);

    expect(service.bootstrap(ids.window)).toEqual({
      settings: defaultShellSettings(),
      workspace,
      availableSurfaces: {
        chat: resolveSurfaceDescriptors(workspace.contextByMode.chat),
        work: resolveSurfaceDescriptors(workspace.contextByMode.work),
        code: resolveSurfaceDescriptors(workspace.contextByMode.code),
      },
      connectionStatus: "connected",
      settingsVersion: 0,
      workspaceVersion: 0,
      environmentPresentation: defaultEnvironmentPresentationState(),
      presentationVersion: 0,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("revalidates and commits a settings replacement with injected identities", () => {
    const { persistence, append } = persistenceStub({
      workspace: {
        workspace: { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const },
        aggregateVersion: 0 as never,
      },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    const settings = decodeShellSettings({
      chatEnabled: false,
      workEnabled: true,
      sidebarWidth: 320,
      contextSidebarWidth: 360,
      lastContextSurface: "project-memory",
      sidebarMaterial: "opaque",
      modeSwitcherPresentation: "dropdown",
    });
    const command = decodeShellCommand({
      kind: "replace-settings",
      windowId: ids.window,
      expectedVersion: 0,
      settings,
    });
    service.bootstrap(ids.window);

    expect(service.execute(command)).toEqual({ kind: "settings-replaced", settings, version: 1 });
    expect(append).toHaveBeenCalledWith({
      aggregate: { aggregateType: "shell-settings", aggregateId: SHELL_SETTINGS_AGGREGATE_ID },
      expectedVersion: 0,
      events: [
        {
          eventId: ids.event,
          eventName: "shell.settings-replaced",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: now,
          payload: { settings },
        },
      ],
    });

    expect(() =>
      service.execute({ ...command, settings: { ...settings, sidebarWidth: 999 } } as ShellCommand),
    ).toThrowError(
      expect.objectContaining({ failure: expect.objectContaining({ category: "invalid" }) }),
    );
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("journals a first-run onboarding resolution once and refuses to reopen it", () => {
    const resolved = decodeShellSettings({
      ...defaultShellSettings(),
      firstRunOnboarding: "completed",
    });
    const { persistence, append } = persistenceStub({
      settings: { settings: resolved, aggregateVersion: 1 as never },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);

    // A relaunch reads the resolved state back, so the first-run surface never
    // reappears (BOOT-01), and a renderer replaying a pending document cannot
    // reopen it.
    expect(service.bootstrap(ids.window).settings.firstRunOnboarding).toBe("completed");
    expect(
      service.execute(
        decodeShellCommand({
          kind: "replace-settings",
          windowId: ids.window,
          expectedVersion: 1,
          settings: { ...resolved, firstRunOnboarding: "pending" },
        }),
      ),
    ).toEqual({ kind: "settings-replaced", settings: resolved, version: 2 });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("commits an environment presentation replacement keyed by window", () => {
    const { persistence, append } = persistenceStub({
      workspace: {
        workspace: { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const },
        aggregateVersion: 0 as never,
      },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    const presentation = decodeEnvironmentPresentationState({
      byTab: [
        {
          tabId: "30000000-0000-4000-8000-000000000003",
          presentation: "pinned",
          pinnedWidth: 400,
        },
      ],
      byMode: { chat: "hidden", work: "floating", code: "pinned" },
    });
    const command = decodeShellCommand({
      kind: "set-environment-presentation",
      windowId: ids.window,
      expectedVersion: 0,
      presentation,
    });
    service.bootstrap(ids.window);

    expect(service.execute(command)).toEqual({
      kind: "environment-presentation-replaced",
      presentation,
      version: 1,
    });
    expect(append).toHaveBeenCalledWith({
      aggregate: { aggregateType: "environment-presentation", aggregateId: ids.window },
      expectedVersion: 0,
      events: [
        {
          eventId: ids.event,
          eventName: "shell.environment-presentation-replaced",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: now,
          payload: { presentation },
        },
      ],
    });
  });

  it("includes environment presentation in the bootstrap payload, merging settings defaults", () => {
    const projected = decodeEnvironmentPresentationState({
      byTab: [
        {
          tabId: "30000000-0000-4000-8000-000000000003",
          presentation: "pinned",
          pinnedWidth: 400,
        },
      ],
      byMode: { chat: "floating", work: "floating", code: "floating" },
    });
    const settings = decodeShellSettings({
      chatEnabled: true,
      workEnabled: true,
      sidebarWidth: 232,
      contextSidebarWidth: 360,
      lastContextSurface: null,
      sidebarMaterial: "system",
      modeSwitcherPresentation: "buttons",
      environmentPresentationByMode: { chat: "hidden", work: "floating", code: "pinned" },
    });
    const { persistence } = persistenceStub({
      workspace: {
        workspace: defaultWindowWorkspace(ids.window),
        aggregateVersion: 0 as never,
      },
      settings: { settings, aggregateVersion: 1 as never },
      presentation: { presentation: projected, aggregateVersion: 2 as never },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });

    const bootstrapped = service.bootstrap(ids.window);
    // Settings defaults flow into byMode; projected tab overrides are preserved.
    expect(bootstrapped.environmentPresentation.byMode).toEqual({
      chat: "hidden",
      work: "floating",
      code: "pinned",
    });
    expect(bootstrapped.environmentPresentation.byTab).toEqual(projected.byTab);
    expect(bootstrapped.presentationVersion).toBe(2);
  });

  it("reconciles a Chat-disabled default workspace before an unrelated settings save", () => {
    const current = decodeShellSettings({
      chatEnabled: false,
      workEnabled: true,
      sidebarWidth: 280,
      contextSidebarWidth: 320,
      lastContextSurface: "project-memory",
      sidebarMaterial: "opaque",
      modeSwitcherPresentation: "dropdown",
    });
    const { persistence, append } = persistenceStub({
      settings: { settings: current, aggregateVersion: 1 as never },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    const next = { ...current, sidebarWidth: 320 };

    service.bootstrap(ids.window);

    expect(
      service.execute(
        decodeShellCommand({
          kind: "replace-settings",
          windowId: ids.window,
          expectedVersion: 1,
          settings: next,
        }),
      ),
    ).toEqual({ kind: "settings-replaced", settings: next, version: 2 });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("reconciles registered persisted workspaces before a settings disable check", () => {
    const current = decodeShellSettings({
      chatEnabled: false,
      workEnabled: true,
      sidebarWidth: 280,
      contextSidebarWidth: 320,
      lastContextSurface: "project-memory",
      sidebarMaterial: "opaque",
      modeSwitcherPresentation: "dropdown",
    });
    const staleWorkspace = {
      ...defaultWindowWorkspace(ids.window),
      activeMode: "chat" as const,
    };
    const { persistence, append } = persistenceStub({
      settings: { settings: current, aggregateVersion: 1 as never },
      workspaces: [{ workspace: staleWorkspace, aggregateVersion: 1 as never }],
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    const next = { ...current, sidebarWidth: 320 };

    service.bootstrap(ids.window);

    expect(
      service.execute(
        decodeShellCommand({
          kind: "replace-settings",
          windowId: ids.window,
          expectedVersion: 1,
          settings: next,
        }),
      ),
    ).toEqual({ kind: "settings-replaced", settings: next, version: 2 });
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("commits workspace policy output and returns the committed version", () => {
    const current = defaultWindowWorkspace(ids.window);
    const group = current.layouts.code;
    if (group.kind !== "group") throw new Error("default code layout must be a group");
    const { persistence, append } = persistenceStub({
      workspace: { workspace: current, aggregateVersion: 0 as never },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    const command = decodeShellCommand({
      kind: "apply-workspace-operation",
      windowId: ids.window,
      expectedVersion: 0,
      operation: { kind: "set-active-mode", mode: "chat" },
    });
    service.bootstrap(ids.window);

    const result = service.execute(command);

    expect(result).toMatchObject({
      kind: "workspace-replaced",
      version: 1,
      workspace: { windowId: ids.window, activeMode: "chat", version: 1 },
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: "window-workspace", aggregateId: ids.window },
        expectedVersion: 0,
        events: [
          expect.objectContaining({
            eventName: "workspace.layout-replaced",
            payload: {
              workspace: expect.objectContaining({ activeMode: "chat", version: 1 }),
            },
          }),
        ],
      }),
    );
  });

  it("journals cross-group docking as one authoritative workspace replacement", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = base.layouts.code;
    if (code.kind !== "group") throw new Error("default code layout must be a group");
    const extraTabId = "00000000-0000-4000-8000-000000000211" as never;
    const withTab = applyWorkspaceOperation(base, {
      kind: "open-tab",
      mode: "code",
      groupId: code.groupId,
      tab: { kind: "settings", id: extraTabId, title: "Settings" },
    });
    const split = applyWorkspaceOperation(withTab, {
      kind: "split-group",
      mode: "code",
      groupId: code.groupId,
      tabId: extraTabId,
      splitNodeId: "00000000-0000-4000-8000-000000000212" as never,
      newGroupNodeId: "00000000-0000-4000-8000-000000000213" as never,
      newGroupId: "00000000-0000-4000-8000-000000000214" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });
    const sourceGroupId = "00000000-0000-4000-8000-000000000214" as never;
    const { persistence, append } = persistenceStub({
      workspace: { workspace: split, aggregateVersion: split.version },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);

    const result = service.execute({
      kind: "apply-workspace-operation",
      windowId: ids.window,
      expectedVersion: split.version,
      operation: {
        kind: "dock-tab",
        mode: "code",
        fromGroupId: sourceGroupId,
        targetGroupId: code.groupId,
        tabId: extraTabId,
        splitNodeId: "00000000-0000-4000-8000-000000000215",
        newGroupNodeId: "00000000-0000-4000-8000-000000000216",
        newGroupId: "00000000-0000-4000-8000-000000000217",
        orientation: "vertical",
        placement: "before",
        ratio: 0.5,
      },
    });

    expect(result).toMatchObject({
      kind: "workspace-replaced",
      version: split.version + 1,
      workspace: {
        activeGroupIds: {
          code: "00000000-0000-4000-8000-000000000217",
        },
        layouts: {
          code: {
            kind: "split",
            nodeId: "00000000-0000-4000-8000-000000000215",
            first: { kind: "group", tabs: [{ id: extraTabId }] },
            second: { kind: "group", groupId: code.groupId },
          },
        },
      },
    });
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      expectedVersion: split.version,
      events: [{ eventName: "workspace.layout-replaced" }],
    });
  });

  it("keeps unsupported tab kinds fail-closed at the command boundary", () => {
    const current = defaultWindowWorkspace(ids.window);
    const code = current.layouts.code;
    if (code.kind !== "group") throw new Error("default code layout must be a group");
    const { persistence, append } = persistenceStub({
      workspace: { workspace: current, aggregateVersion: 0 as never },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });

    expect(() =>
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 0,
        operation: {
          kind: "open-tab",
          mode: "code",
          groupId: code.groupId,
          tab: {
            kind: "future-editor",
            id: "00000000-0000-4000-8000-000000000204",
            title: "Future editor",
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ failure: expect.objectContaining({ category: "invalid" }) }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("rejects disabled mode selection and mutation before append while keeping Code available", () => {
    const settings = decodeShellSettings({
      chatEnabled: false,
      workEnabled: false,
      sidebarWidth: 280,
      contextSidebarWidth: 360,
      lastContextSurface: null,
      sidebarMaterial: "system",
      modeSwitcherPresentation: "buttons",
    });
    const current = defaultWindowWorkspace(ids.window);
    const { persistence, append } = persistenceStub({
      settings: { settings, aggregateVersion: 1 as never },
      workspace: { workspace: current, aggregateVersion: 0 as never },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);

    for (const operation of [
      { kind: "set-active-mode" as const, mode: "chat" as const },
      { kind: "reset-mode" as const, mode: "work" as const },
    ]) {
      expect(() =>
        service.execute({
          kind: "apply-workspace-operation",
          windowId: ids.window,
          expectedVersion: 0,
          operation,
        }),
      ).toThrowError(
        expect.objectContaining({
          failure: {
            category: "unsupported",
            message: expect.stringContaining(operation.mode),
          },
        }),
      );
    }
    expect(append).not.toHaveBeenCalled();

    expect(
      service.execute({
        kind: "apply-workspace-operation",
        windowId: ids.window,
        expectedVersion: 0,
        operation: { kind: "reset-mode", mode: "code" },
      }),
    ).toMatchObject({ kind: "workspace-replaced", version: 1 });
    expect(append).toHaveBeenCalledOnce();
  });

  it("requires a durable workspace fallback before disabling its active mode", () => {
    const activeChat = {
      ...defaultWindowWorkspace(ids.window),
      activeMode: "chat" as const,
      version: 1 as never,
    };
    const settings = decodeShellSettings({
      ...defaultShellSettings(),
      chatEnabled: false,
    });
    const { persistence, append } = persistenceStub({
      workspace: { workspace: activeChat, aggregateVersion: 1 as never },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);

    expect(() =>
      service.execute({
        kind: "replace-settings",
        windowId: ids.window,
        expectedVersion: 0,
        settings,
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: {
          category: "unsupported",
          message: expect.stringMatching(/active chat workspace/i),
        },
      }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("allows a recovered native window to disable a mode selected only by an orphaned old window", () => {
    const orphanedChat = {
      ...defaultWindowWorkspace(ids.window),
      activeMode: "chat" as const,
      version: 1 as never,
    };
    const settings = decodeShellSettings({
      ...defaultShellSettings(),
      chatEnabled: false,
    });
    const { persistence, append } = persistenceStub({
      workspaceFor: (windowId) =>
        windowId === ids.window
          ? { workspace: orphanedChat, aggregateVersion: 1 as never }
          : {
              workspace: { ...defaultWindowWorkspace(ids.otherWindow), activeMode: "code" },
              aggregateVersion: 0 as never,
            },
      workspaces: [{ workspace: orphanedChat, aggregateVersion: 1 as never }],
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.otherWindow);

    expect(
      service.execute({
        kind: "replace-settings",
        windowId: ids.otherWindow,
        expectedVersion: 0,
        settings,
      }),
    ).toEqual({ kind: "settings-replaced", settings, version: 1 });
    expect(append).toHaveBeenCalledOnce();
  });

  it("rejects a fresh unregistered window identity", () => {
    const settings = decodeShellSettings({
      ...defaultShellSettings(),
      chatEnabled: false,
    });
    const { persistence, append } = persistenceStub();
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);

    expect(() =>
      service.execute({
        kind: "replace-settings",
        windowId: ids.otherWindow,
        expectedVersion: 0,
        settings,
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: {
          category: "invalid",
          message: expect.stringMatching(/window.*not registered/i),
        },
      }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("blocks disabling a mode selected by another registered active window", () => {
    const activeChat = {
      ...defaultWindowWorkspace(ids.window),
      activeMode: "chat" as const,
      version: 1 as never,
    };
    const settings = decodeShellSettings({
      ...defaultShellSettings(),
      chatEnabled: false,
    });
    const { persistence, append } = persistenceStub({
      workspaceFor: (windowId) =>
        windowId === ids.window
          ? { workspace: activeChat, aggregateVersion: 1 as never }
          : undefined,
      workspaces: [{ workspace: activeChat, aggregateVersion: 1 as never }],
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);
    service.bootstrap(ids.otherWindow);

    expect(() =>
      service.execute({
        kind: "replace-settings",
        windowId: ids.otherWindow,
        expectedVersion: 0,
        settings,
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: {
          category: "unsupported",
          message: expect.stringMatching(/active chat workspace/i),
        },
      }),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("reports optimistic conflicts with the journal current version", () => {
    const { persistence } = persistenceStub({
      appendError: new ConcurrencyConflict({
        aggregateType: "shell-settings",
        aggregateId: SHELL_SETTINGS_AGGREGATE_ID,
        expectedVersion: 2,
        actualVersion: 4,
      }),
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);

    expect(() =>
      service.execute({
        kind: "replace-settings",
        windowId: ids.window,
        expectedVersion: 2,
        settings: defaultShellSettings(),
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: {
          category: "conflict",
          message: "Shell state changed; reload and retry.",
          expectedVersion: 2,
          actualVersion: 4,
        },
      }),
    );
  });

  it("maps recovery state and journal failures without exposing storage details", () => {
    const recovering = persistenceStub({ statusState: "recovery-required" });
    const unavailable = persistenceStub({
      appendError: new JournalWriteFailed({ operation: "append" }),
    });
    const unavailableService = new ShellService({
      persistence: unavailable.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    });
    unavailableService.bootstrap(ids.window);

    expect(() =>
      new ShellService({
        persistence: recovering.persistence,
        uuid: uuidSequence(),
        clock: () => now,
      }).bootstrap(ids.window),
    ).toThrowError(
      expect.objectContaining({
        failure: { category: "recovery-required", message: expect.any(String) },
      }),
    );
    expect(() =>
      unavailableService.execute({
        kind: "replace-settings",
        windowId: ids.window,
        expectedVersion: 0,
        settings: defaultShellSettings(),
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: { category: "unavailable", message: expect.any(String) },
      }),
    );
  });
});

function uuidSequence(): () => string {
  const values = [ids.event, ids.correlation];
  return () => values.shift() ?? ids.event;
}

function persistenceStub(
  options: {
    readonly workspace?: ReturnType<PersistenceService["readWindowWorkspace"]>;
    readonly workspaceFor?: (
      windowId: Parameters<PersistenceService["readWindowWorkspace"]>[0],
    ) => ReturnType<PersistenceService["readWindowWorkspace"]>;
    readonly workspaces?: ReturnType<PersistenceService["readWindowWorkspaces"]>;
    readonly settings?: ReturnType<PersistenceService["readShellSettings"]>;
    readonly presentation?: ReturnType<PersistenceService["readEnvironmentPresentation"]>;
    readonly project?: ReturnType<PersistenceService["readProject"]>;
    readonly projectFor?: (
      projectId: Parameters<PersistenceService["readProject"]>[0],
    ) => ReturnType<PersistenceService["readProject"]>;
    readonly canvasProjection?: CanvasProjection;
    readonly appendError?: Error;
    readonly statusState?: "current" | "recovery-required";
  } = {},
) {
  const append = vi.fn((request: { readonly expectedVersion: number }) => {
    if (options.appendError !== undefined) throw options.appendError;
    return { aggregateVersion: request.expectedVersion + 1 };
  });
  const persistence = {
    journal: { append },
    readShellSettings: () => options.settings,
    readEnvironmentPresentation: () => options.presentation,
    readWindowWorkspace: (windowId: Parameters<PersistenceService["readWindowWorkspace"]>[0]) =>
      options.workspaceFor?.(windowId) ?? options.workspace,
    readWindowWorkspaces: () =>
      options.workspaces ?? (options.workspace === undefined ? [] : [options.workspace]),
    readProject: (projectId: Parameters<PersistenceService["readProject"]>[0]) =>
      options.projectFor === undefined ? options.project : options.projectFor(projectId),
    readCodeThread: () => undefined,
    canvasProjection: options.canvasProjection ?? new CanvasProjection(),
    status: () => ({
      state: options.statusState ?? "current",
      integrity: "ok",
    }),
  } as unknown as PersistenceService;
  return { persistence, append };
}

function projectFixture(type: "chat" | "work" | "code"): Project {
  const common = {
    id: projectId,
    name: "Project",
    lifecycle: "active" as const,
    pinned: false,
    rank: "0/1" as never,
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
  };
  if (type === "chat") return { ...common, type } as const;
  if (type === "work") {
    return {
      ...common,
      type,
      binding: { canonicalRoot: "/home/folder" },
      bindingHistory: [
        {
          revisionId: "00000000-0000-4000-8000-000000000207" as never,
          revision: 1,
          currentBinding: { canonicalRoot: "/home/folder" },
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          changedAt: now as never,
        },
      ],
    } as unknown as Project;
  }
  return {
    ...common,
    type,
    binding: { canonicalRoot: "/repo" },
    bindingHistory: [
      {
        revisionId: "00000000-0000-4000-8000-000000000207" as never,
        revision: 1,
        currentBinding: { canonicalRoot: "/repo" },
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        changedAt: now as never,
      },
    ],
    codeAccessPersistence: "current-session" as const,
  } as unknown as Project;
}
