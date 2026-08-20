import {
  decodeEnvironmentPresentationState,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeProjectId,
  decodeShellCommand,
  decodeShellSettings,
  decodeWindowId,
  type ShellCommand,
  type Project,
  type WindowWorkspace,
  LOCAL_HOST_ID,
} from "@octant/contracts";
import {
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
  it("requires an active matching Project before appending a Project surface", () => {
    const workspace = defaultWindowWorkspace(ids.window);
    const codeLayout = workspace.layouts.code;
    if (codeLayout.kind !== "pane") throw new Error("expected pane");
    const operation = {
      kind: "open-surface" as const,
      mode: "code" as const,
      paneId: codeLayout.paneId,
      surface: {
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

  it("rejects opening a Project surface bound to a different context with a cross-context failure", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
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
      kind: "open-surface" as const,
      mode: "code" as const,
      paneId: code.paneId,
      surface: {
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
        kind: "switch-project-surface",
        mode: "code",
        surface: {
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
    if (work.kind !== "pane") throw new Error("expected pane");
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
        kind: "open-surface",
        mode: "work",
        paneId: work.paneId,
        surface: {
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

  it("keeps archived restored Project surfaces but presents missing or mismatched ones as welcome", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
    const restored = {
      ...base,
      layouts: {
        ...base.layouts,
        code: {
          ...code,
          surface: {
            kind: "project",
            id: code.surface.id,
            projectId,
            mode: "code",
            title: "Saved",
          },
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
    ).toMatchObject({ surface: { kind: "project" } });
    for (const project of [undefined, projectFixture("chat")]) {
      const persistence = persistenceStub({
        workspace: { workspace: restored, aggregateVersion: 2 as never },
        project,
      });
      // Restore is layout-only: the pane keeps its place and identity but the
      // unresolvable Project renders the mode's welcome surface, never a dead
      // placeholder.
      expect(
        new ShellService({
          persistence: persistence.persistence,
          uuid: uuidSequence(),
          clock: () => now,
        }).bootstrap(ids.window).workspace.layouts.code,
      ).toMatchObject({ surface: { kind: "welcome", id: code.surface.id } });
      expect(persistence.append).not.toHaveBeenCalled();
    }
  });

  it("keeps restored preview surfaces bound to the active Project and quarantines stale ones", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "work" as const };
    const work = base.layouts.work;
    if (work.kind !== "pane") throw new Error("expected pane");
    const boundPreviewSurface = {
      kind: "preview" as const,
      id: work.surface.id,
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
        work: { ...work, surface: boundPreviewSurface },
      },
    } as never;
    // Active matching Project: the preview surface stays durable so the
    // renderer can reopen it through the existing preview contracts.
    const activeFixture = persistenceStub({
      workspace: { workspace: restored, aggregateVersion: 2 as never },
      project: projectFixture("work") as never,
    });
    const activeBootstrap = new ShellService({
      persistence: activeFixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    const activeSurface =
      activeBootstrap.workspace.layouts.work.kind === "pane"
        ? activeBootstrap.workspace.layouts.work.surface
        : undefined;
    expect(activeSurface?.kind).toBe("preview");
    expect(activeFixture.append).not.toHaveBeenCalled();
    // Archived/missing Project: the pane renders the mode's welcome surface so
    // the host never guesses a replacement file.
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
      const staleSurface =
        staleBootstrap.workspace.layouts.work.kind === "pane"
          ? staleBootstrap.workspace.layouts.work.surface
          : undefined;
      expect(staleSurface?.kind).toBe("welcome");
      expect(staleFixture.append).not.toHaveBeenCalled();
    }
  });

  it("keeps restored canvas surfaces bound and quarantines missing projection rows", () => {
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
    if (chat.kind !== "pane") throw new Error("expected pane");
    const canvasSurface = {
      kind: "canvas" as const,
      id: chat.surface.id,
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
        chat: { ...chat, surface: canvasSurface },
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
    const activeSurface =
      activeBootstrap.workspace.layouts.chat.kind === "pane"
        ? activeBootstrap.workspace.layouts.chat.surface
        : undefined;
    expect(activeSurface?.kind).toBe("canvas");
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
    const missingSurface =
      missingBootstrap.workspace.layouts.chat.kind === "pane"
        ? missingBootstrap.workspace.layouts.chat.surface
        : undefined;
    expect(missingSurface?.kind).toBe("welcome");
  });

  it("requires an active matching Project before appending a preview surface", () => {
    const workspace = defaultWindowWorkspace(ids.window);
    const workLayout = workspace.layouts.work;
    if (workLayout.kind !== "pane") throw new Error("expected pane");
    const previewSurface = {
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
            kind: "open-surface" as const,
            mode: "work" as const,
            paneId: workLayout.paneId,
            surface: previewSurface,
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
    if (code.kind !== "pane") throw new Error("expected pane");
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
    const browserSurface = {
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
          kind: "open-surface" as const,
          mode: "code" as const,
          paneId: code.paneId,
          surface: browserSurface,
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

  it("infers context from active Project surfaces when upcasting a pre-contextByMode workspace", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
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
          surface: {
            kind: "project" as const,
            id: code.surface.id,
            projectId,
            mode: "code" as const,
            title: "Project",
          },
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

  it("converts root-backed surfaces to welcome when clearing stale context at bootstrap", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
    const withBrowserSurface = {
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
          surface: {
            kind: "browser" as const,
            id: code.surface.id,
            mode: "code" as const,
            title: "Browser",
          },
        },
      },
    } as never;
    const fixture = persistenceStub({
      workspace: { workspace: withBrowserSurface, aggregateVersion: 2 as never },
      project: undefined,
    });
    const bootstrap = new ShellService({
      persistence: fixture.persistence,
      uuid: uuidSequence(),
      clock: () => now,
    }).bootstrap(ids.window);
    const restoredSurface =
      bootstrap.workspace.layouts.code.kind === "pane"
        ? bootstrap.workspace.layouts.code.surface
        : undefined;
    expect(restoredSurface?.kind).toBe("welcome");
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

  it("quarantines extra Project surfaces when inferring context from a pre-contextByMode workspace", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
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
          kind: "split" as const,
          nodeId: "00000000-0000-4000-8000-000000000232",
          orientation: "horizontal" as const,
          ratio: 0.5,
          first: {
            ...code,
            surface: {
              kind: "project" as const,
              id: code.surface.id,
              projectId,
              mode: "code" as const,
              title: "Project A",
            },
          },
          second: {
            kind: "pane" as const,
            nodeId: "00000000-0000-4000-8000-000000000233",
            paneId: "00000000-0000-4000-8000-000000000234",
            surface: {
              kind: "project" as const,
              id: "00000000-0000-4000-8000-000000000231" as never,
              projectId: otherProject,
              mode: "code" as const,
              title: "Project B",
            },
          },
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
    const layout = bootstrap.workspace.layouts.code;
    if (layout.kind !== "split" || layout.first.kind !== "pane" || layout.second.kind !== "pane") {
      throw new Error("expected a split of two panes");
    }
    expect(layout.first.surface).toMatchObject({ kind: "project", projectId });
    // The second Project surface loses authority: it renders welcome in place
    // so activating its pane cannot bypass the open-surface context guard.
    expect(layout.second.surface).toMatchObject({
      kind: "welcome",
      id: "00000000-0000-4000-8000-000000000231",
    });
  });

  it("never journals a bootstrap-only welcome presentation over its raw Project surface", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
    const rawProjectSurface = {
      kind: "project" as const,
      id: code.surface.id,
      projectId,
      mode: "code" as const,
      title: "Recoverable Project",
    };
    const rawWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...code, surface: rawProjectSurface },
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
      surface: { kind: "welcome" },
    });
    expect(rawWorkspace.layouts.code.surface).toEqual(rawProjectSurface);

    const result = service.execute({
      kind: "apply-workspace-operation",
      windowId: ids.window,
      expectedVersion: 2,
      operation: { kind: "focus-pane", mode: "code", paneId: code.paneId },
    });

    expect(result).toMatchObject({
      kind: "workspace-replaced",
      workspace: { layouts: { code: { surface: { kind: "welcome" } } } },
      version: 3,
    });

    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      events: [
        {
          payload: {
            workspace: {
              layouts: { code: { surface: rawProjectSurface } },
              focusedPaneId: code.paneId,
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
    expect(result.workspace.layouts.code).toMatchObject({ surface: { kind: "welcome" } });
    expect(appendedWorkspace.layouts.code).toMatchObject({ surface: rawProjectSurface });
    expect(service.bootstrap(ids.window).workspace.layouts.code).toMatchObject({
      surface: { kind: "welcome" },
    });
  });

  it("closes a stale raw Project pane and returns the updated presentation", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
    const stalePaneId = "00000000-0000-4000-8000-000000000209" as never;
    const stalePane = {
      kind: "pane" as const,
      nodeId: "00000000-0000-4000-8000-000000000210" as never,
      paneId: stalePaneId,
      surface: {
        kind: "project" as const,
        id: "00000000-0000-4000-8000-000000000208" as never,
        projectId,
        mode: "code" as const,
        title: "Stale",
      },
    };
    const rawWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: {
          kind: "split" as const,
          nodeId: "00000000-0000-4000-8000-000000000211" as never,
          orientation: "horizontal" as const,
          ratio: 0.5 as never,
          first: code,
          second: stalePane,
        },
      },
      activePaneIds: { ...base.activePaneIds, code: stalePaneId },
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
        operation: { kind: "close-pane", mode: "code", paneId: stalePaneId },
      }),
    ).toMatchObject({
      kind: "workspace-replaced",
      workspace: { layouts: { code: { kind: "pane", surface: { kind: "welcome" } } } },
    });
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      events: [
        {
          payload: {
            workspace: { layouts: { code: { kind: "pane", surface: { kind: "welcome" } } } },
          },
        },
      ],
    });
  });

  it("reports recovery safely if post-commit presentation reconciliation fails", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("expected pane");
    const rawProjectSurface = {
      kind: "project" as const,
      id: code.surface.id,
      projectId,
      mode: "code" as const,
      title: "Recoverable Project",
    };
    const rawWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...code, surface: rawProjectSurface },
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
        operation: { kind: "focus-pane", mode: "code", paneId: code.paneId },
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: { category: "unavailable", message: "Octant shell state is unavailable." },
      }),
    );
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      events: [{ payload: { workspace: { layouts: { code: { surface: rawProjectSurface } } } } }],
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

  it("journals an edge-drop split as one authoritative workspace replacement", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = base.layouts.code;
    if (code.kind !== "pane") throw new Error("default code layout must be a pane");
    const surfaceId = "00000000-0000-4000-8000-000000000211" as never;
    const { persistence, append } = persistenceStub({
      workspace: { workspace: base, aggregateVersion: base.version },
    });
    const service = new ShellService({ persistence, uuid: uuidSequence(), clock: () => now });
    service.bootstrap(ids.window);

    const result = service.execute({
      kind: "apply-workspace-operation",
      windowId: ids.window,
      expectedVersion: base.version,
      operation: {
        kind: "split-pane",
        mode: "code",
        targetPaneId: code.paneId,
        surface: { kind: "settings", id: surfaceId, title: "Settings" },
        splitNodeId: "00000000-0000-4000-8000-000000000215",
        newPaneNodeId: "00000000-0000-4000-8000-000000000216",
        newPaneId: "00000000-0000-4000-8000-000000000217",
        orientation: "vertical",
        placement: "before",
        ratio: 0.5,
      },
    });

    expect(result).toMatchObject({
      kind: "workspace-replaced",
      version: base.version + 1,
      workspace: {
        activePaneIds: {
          code: "00000000-0000-4000-8000-000000000217",
        },
        layouts: {
          code: {
            kind: "split",
            nodeId: "00000000-0000-4000-8000-000000000215",
            first: {
              kind: "pane",
              paneId: "00000000-0000-4000-8000-000000000217",
              surface: { id: surfaceId },
            },
            second: { kind: "pane", paneId: code.paneId },
          },
        },
      },
    });
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      expectedVersion: base.version,
      events: [{ eventName: "workspace.layout-replaced" }],
    });
  });

  it("keeps unsupported surface kinds fail-closed at the command boundary", () => {
    const current = defaultWindowWorkspace(ids.window);
    const code = current.layouts.code;
    if (code.kind !== "pane") throw new Error("default code layout must be a pane");
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
          kind: "open-surface",
          mode: "code",
          paneId: code.paneId,
          surface: {
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
