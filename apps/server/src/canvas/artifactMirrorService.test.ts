import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_MIRROR_AGGREGATE_TYPE,
  ARTIFACT_MIRROR_EVENT_NAMES,
  CANVAS_SCHEMA_VERSION,
  CanvasCreated,
  CanvasVersionAppended,
  decodeCanvasId,
  decodeCanvasVersion,
  decodeProjectId,
  EventActor,
  LOCAL_HOST_ID,
  ThreadCreationRootId,
  type CanvasVersion,
} from "@octant/contracts";
import type { ArtifactMirrorCommitOutcome } from "@octant/contracts/artifact-mirror";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { appendArtifactMirrorBundleVersion } from "../wiring/canvas";
import { buildArtifactBundle } from "./artifactBundle";
import { ArtifactMirrorEventStore, registerArtifactMirrorEvents } from "./artifactMirrorEventStore";
import { createArtifactMirrorFilePort } from "./artifactMirrorFilePort";
import {
  ArtifactMirrorService,
  type ArtifactMirrorFilePort,
  type ArtifactMirrorServiceDependencies,
} from "./artifactMirrorService";
import {
  CANVAS_AGGREGATE_TYPE,
  CANVAS_CREATED,
  CANVAS_VERSION_APPENDED,
  CanvasEventStore,
} from "./canvasEventStore";
import { CanvasProjection } from "./canvasProjection";
import { CanvasService } from "./canvasService";

const canvasId = "1a2b3c4d-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";

function version(overrides: { readonly title?: string; readonly versionId?: string } = {}) {
  return {
    schemaVersion: 1,
    canvasId,
    versionId: overrides.versionId ?? "30000000-0000-4000-8000-000000000001",
    sequence: 1,
    definition: {
      schemaVersion: 1,
      title: overrides.title ?? "Launch plan",
      provenance: {
        hostId: "host-1",
        projectId,
        actor: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
        providerInstanceId: "60000000-0000-4000-8000-000000000001",
        modelId: "model-a",
        createdAt: "2026-08-18T09:00:00.000Z",
        mode: "work",
        threadId: "70000000-0000-4000-8000-000000000001",
      },
      sourceManifest: { sources: [] },
      blocks: [{ blockId: "t1", schemaVersion: 1, kind: "rich-text", text: "Ship it." }],
    },
    createdBy: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
    createdAt: "2026-08-18T09:00:00.000Z",
  } as unknown as CanvasVersion;
}

function harness(
  options: {
    readonly checkoutRoot?: string;
    readonly outsideRootApproved?: boolean;
    readonly planMode?: boolean;
    readonly files?: Map<string, string>;
    /** The real filesystem port, in place of the in-memory files. */
    readonly port?: ArtifactMirrorFilePort;
    readonly current?: CanvasVersion;
    readonly commit?: ArtifactMirrorCommitOutcome | "unavailable";
  } = {},
) {
  const files = options.files ?? new Map<string, string>();
  const write = vi.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  });
  const remove = vi.fn(async (path: string) => {
    files.delete(path);
  });
  const journal = { append: vi.fn(), replay: () => [], replayReceipts: () => [] };
  const appendVersionFromBundle = vi.fn(
    (_input: { readonly canvasId: unknown; readonly definition: unknown }) =>
      ({ kind: "accepted", versionId: "30000000-0000-4000-8000-0000000000ff" }) as const,
  );
  const commitMirroredFiles = vi.fn(
    async (_input: {
      readonly checkoutRoot: string;
      readonly paths: ReadonlyArray<string>;
      readonly message: string;
    }): Promise<ArtifactMirrorCommitOutcome> =>
      options.commit === undefined || options.commit === "unavailable"
        ? { status: "not-requested" }
        : options.commit,
  );
  const dependencies: ArtifactMirrorServiceDependencies = {
    files: options.port ?? {
      write,
      read: async (path) => files.get(path),
      remove,
      resolveRoot: async (path) => path,
    },
    currentVersion: () => options.current ?? version(),
    projects: {
      read: () => ({
        name: "Storefront",
        ...(options.checkoutRoot === undefined ? {} : { checkoutRoot: options.checkoutRoot }),
      }),
    },
    outsideRootApproved: () => options.outsideRootApproved ?? true,
    planMode: () => options.planMode ?? false,
    appendVersionFromBundle,
    ...(options.commit === undefined || options.commit === "unavailable"
      ? {}
      : { commitMirroredFiles: commitMirroredFiles }),
    journal,
    clock: () => "2026-08-18T10:00:00.000Z" as never,
  };
  return {
    service: new ArtifactMirrorService(dependencies),
    files,
    write,
    remove,
    journal,
    appendVersionFromBundle,
    commitMirroredFiles,
  };
}

async function withGlobalFolder(h: ReturnType<typeof harness>) {
  await h.service.execute({
    kind: "set-artifact-mirror-fallback",
    expectedVersion: 0,
    destination: { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" },
  });
  return h;
}

describe("mirroring artifacts to files", () => {
  it("writes nothing at all until someone asks for it", async () => {
    const h = harness();

    const receipt = await h.service.materialize(version());

    expect(receipt.outcome).toBe("skipped");
    expect(h.write).not.toHaveBeenCalled();
    // Even doing nothing is journaled, so "why is there no file" is answerable.
    expect(h.journal.append).toHaveBeenCalled();
  });

  it("writes the bundle and its sidecars once a folder is chosen", async () => {
    const h = await withGlobalFolder(harness());

    const receipt = await h.service.materialize(version());

    expect(receipt.outcome).toBe("written");
    expect([...h.files.keys()]).toEqual([
      "/Users/me/Artifacts/storefront/launch-plan-1a2b3c4d.octant.json",
      "/Users/me/Artifacts/storefront/launch-plan-1a2b3c4d.md",
      "/Users/me/Artifacts/storefront/launch-plan-1a2b3c4d.svg",
    ]);
  });

  it("rewrites in place rather than piling up dated copies", async () => {
    const h = await withGlobalFolder(harness());

    await h.service.materialize(version());
    await h.service.materialize(version({ versionId: "30000000-0000-4000-8000-000000000002" }));

    expect(h.files.size).toBe(3);
  });

  it("removes the old files when an artifact is renamed", async () => {
    const h = await withGlobalFolder(harness());

    await h.service.materialize(version());
    await h.service.materialize(version({ title: "Launch plan v2" }));

    expect([...h.files.keys()].every((path) => path.includes("launch-plan-v2"))).toBe(true);
    expect(h.remove).toHaveBeenCalled();
  });

  it("refuses a folder outside a bound root until that is approved", async () => {
    const h = await withGlobalFolder(harness({ outsideRootApproved: false }));

    const receipt = await h.service.materialize(version());

    expect(receipt).toMatchObject({ outcome: "refused" });
    expect(receipt.detail).toContain("approved");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("refuses to write files for a thread in Plan mode", async () => {
    const h = await withGlobalFolder(harness({ planMode: true }));

    expect(await h.service.materialize(version())).toMatchObject({ outcome: "refused" });
    expect(h.write).not.toHaveBeenCalled();
  });

  it("does not report a Plan-mode refusal as the Project's folder not being mirrored", async () => {
    const h = await withGlobalFolder(harness({ planMode: true }));

    await h.service.materialize(version());

    expect(h.service.view().projects).toEqual([]);
  });

  it("reports a write it could not do instead of unwinding the version", async () => {
    const h = await withGlobalFolder(harness());
    h.write.mockRejectedValueOnce(new Error("read-only filesystem"));

    const receipt = await h.service.materialize(version());

    expect(receipt.outcome).toBe("failed");
  });

  it("refuses a repository destination in a Project that binds none", async () => {
    const h = harness();
    await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 0,
      destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
    });

    const receipt = await h.service.materialize(version());

    expect(receipt.detail).toContain("binds no repository");
  });

  it("leaves the commit to the person unless they turned auto-commit on", async () => {
    const h = harness({ checkoutRoot: "/repos/storefront", commit: { status: "committed" } });
    await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 0,
      destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
    });

    const receipt = await h.service.materialize(version());

    expect(receipt.outcome).toBe("written");
    expect(receipt.commit).toEqual({ status: "not-requested" });
    expect(h.commitMirroredFiles).not.toHaveBeenCalled();
  });

  it("commits only the files it wrote once auto-commit is on", async () => {
    const h = harness({ checkoutRoot: "/repos/storefront", commit: { status: "committed" } });
    await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 0,
      destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
    });
    await h.service.execute({
      kind: "set-artifact-mirror-auto-commit",
      expectedVersion: 1,
      autoCommit: true,
    });

    const receipt = await h.service.materialize(version());

    expect(receipt.commit).toEqual({ status: "committed" });
    const call = h.commitMirroredFiles.mock.calls[0]?.[0];
    expect(call?.checkoutRoot).toBe("/repos/storefront");
    expect(call?.paths).toEqual(receipt.paths);
    expect(call?.message).toBe("Update mirrored artifact: Launch plan");
  });

  it("never commits a folder that is not a repository", async () => {
    const h = await withGlobalFolder(
      harness({ checkoutRoot: "/repos/storefront", commit: { status: "committed" } }),
    );
    await h.service.execute({
      kind: "set-artifact-mirror-override",
      expectedVersion: 1,
      projectId,
      destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
    });
    await h.service.execute({
      kind: "set-artifact-mirror-auto-commit",
      expectedVersion: 2,
      autoCommit: true,
    });
    await h.service.execute({
      kind: "clear-artifact-mirror-override",
      expectedVersion: 3,
      projectId,
    });

    const receipt = await h.service.materialize(version());

    expect(receipt.destination.kind).toBe("global-folder");
    // Taking the repository away took auto-commit with it rather than leaving
    // a setting that does nothing until a repository appears again.
    expect(h.service.settings().autoCommit).toBe(false);
    expect(receipt.commit).toEqual({ status: "not-requested" });
    expect(h.commitMirroredFiles).not.toHaveBeenCalled();
  });

  it("refuses auto-commit when nothing mirrors into a repository", async () => {
    const h = await withGlobalFolder(harness());

    expect(
      await h.service.execute({
        kind: "set-artifact-mirror-auto-commit",
        expectedVersion: 1,
        autoCommit: true,
      }),
    ).toMatchObject({ kind: "mirror-refused", reason: "commit-needs-repository" });
    expect(h.service.settings().autoCommit).toBe(false);
  });

  it("reports auto-commit unavailable on a host that cannot commit", async () => {
    const h = harness({ checkoutRoot: "/repos/storefront", commit: "unavailable" });
    await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 0,
      destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
    });
    await h.service.execute({
      kind: "set-artifact-mirror-auto-commit",
      expectedVersion: 1,
      autoCommit: true,
    });

    const receipt = await h.service.materialize(version());

    // The files are still written: a host that cannot commit still mirrors.
    expect(receipt.outcome).toBe("written");
    expect(receipt.commit).toEqual({ status: "refused", reason: "commit-unavailable" });
  });

  it("refuses a settings change computed against a stale view", async () => {
    const h = await withGlobalFolder(harness());

    expect(
      await h.service.execute({
        kind: "set-artifact-mirror-auto-commit",
        expectedVersion: 0,
        autoCommit: true,
      }),
    ).toMatchObject({ kind: "mirror-refused", reason: "stale-version" });
  });
});

const temporaryFolders: Array<string> = [];
afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/**
 * A mirror folder inside a checkout an agent can rename folders in, beside a
 * host folder the agent could point a link at.
 */
function folderInsideCheckout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-mirror-root-")));
  temporaryFolders.push(base);
  const parent = join(base, "checkout", "mirror");
  const root = join(parent, "artifacts");
  const host = join(base, "host");
  mkdirSync(root, { recursive: true });
  mkdirSync(host);
  writeFileSync(join(host, "notes.md"), "host notes");
  return {
    base,
    root,
    /** Every name and byte under the host folder, to prove nothing there changed. */
    host: () => snapshot(host),
    swapRoot: () => {
      renameSync(root, `${root}-real`);
      symlinkSync(host, root);
    },
    swapParent: () => {
      renameSync(parent, `${parent}-real`);
      symlinkSync(host, parent);
    },
  };
}

function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    const path = join(directory, name);
    entries[name] = statSync(path).isDirectory() ? "<folder>" : readFileSync(path, "utf8");
  }
  return entries;
}

async function mirrorInto(canonicalRoot: string) {
  const h = harness({ port: createArtifactMirrorFilePort() });
  await h.service.execute({
    kind: "set-artifact-mirror-fallback",
    expectedVersion: 0,
    destination: { kind: "global-folder", canonicalRoot },
  });
  return h;
}

describe("mirroring into a folder an agent can rename", () => {
  // The folder's root was resolved afresh for every write and never compared
  // with the path the person chose, so a root inside a checkout swapped for a
  // link to a host folder received the bundle and its sidecars.
  it("refuses a folder swapped for a link to a host folder after it was chosen", async () => {
    const folder = folderInsideCheckout();
    const h = await mirrorInto(folder.root);
    folder.swapRoot();
    const before = folder.host();

    const receipt = await h.service.materialize(version());

    expect(receipt).toMatchObject({ outcome: "refused", paths: [] });
    expect(folder.host()).toEqual(before);
  });

  it("does not recreate a removed folder under a parent swapped for a link to a host folder", async () => {
    const folder = folderInsideCheckout();
    const h = await mirrorInto(folder.root);
    folder.swapParent();
    const before = folder.host();

    const receipt = await h.service.materialize(version());

    expect(receipt).toMatchObject({ outcome: "refused", paths: [] });
    expect(folder.host()).toEqual(before);
  });

  it("keeps a folder named through a link by its real path and mirrors into it", async () => {
    const folder = folderInsideCheckout();
    const linked = join(folder.base, "linked");
    symlinkSync(folder.root, linked);
    const h = await mirrorInto(linked);

    const receipt = await h.service.materialize(version());

    expect(h.service.settings().fallback).toEqual({
      kind: "global-folder",
      canonicalRoot: folder.root,
    });
    expect(receipt.outcome).toBe("written");
    expect(readdirSync(join(folder.root, "storefront"))).toHaveLength(3);
  });

  // The refusal was recorded only in the journaled receipt, which nothing on
  // screen reads, so a folder that stopped resolving to its stored real path
  // stopped mirroring with nothing shown.
  it("says in the settings read which Project stopped mirroring, until a folder is chosen again", async () => {
    const folder = folderInsideCheckout();
    const h = await mirrorInto(folder.root);
    folder.swapRoot();

    await h.service.materialize(version());

    expect(h.service.view().projects).toEqual([
      {
        projectId,
        projectName: "Storefront",
        source: "host",
        destination: { kind: "global-folder", canonicalRoot: folder.root },
        outcome: "refused",
        reason: "destination-unavailable",
        detail: "The folder this Project mirrors to could not be read.",
        observedAt: "2026-08-18T10:00:00.000Z",
      },
    ]);

    const chosen = join(folder.base, "chosen");
    await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 1,
      destination: { kind: "global-folder", canonicalRoot: chosen },
    });
    expect(h.service.view().projects).toEqual([]);

    await h.service.materialize(version());
    expect(h.service.view().projects).toMatchObject([{ projectId, outcome: "written" }]);
  });
});

describe("taking an edited mirrored file back in", () => {
  it("appends a new version and never overwrites the aggregate", async () => {
    const h = await withGlobalFolder(harness());
    await h.service.materialize(version());
    const path = "/Users/me/Artifacts/storefront/launch-plan-1a2b3c4d.octant.json";
    const edited = JSON.parse(h.files.get(path) ?? "{}") as Record<string, unknown>;
    (edited["definition"] as Record<string, unknown>)["title"] = "Edited by hand";
    h.files.set(path, JSON.stringify(edited, null, 2));

    const result = await h.service.execute({
      kind: "reimport-artifact-from-file",
      canvasId,
      expectedVersionId: "30000000-0000-4000-8000-000000000001",
    });

    expect(result).toMatchObject({ kind: "artifact-reimported" });
    expect(h.appendVersionFromBundle).toHaveBeenCalledOnce();
    expect(h.appendVersionFromBundle.mock.calls[0]?.[0].definition).toMatchObject({
      title: "Edited by hand",
    });
  });

  it("refuses when the artifact moved since the caller read it", async () => {
    const h = await withGlobalFolder(
      harness({ current: version({ versionId: "30000000-0000-4000-8000-0000000000aa" }) }),
    );
    await h.service.materialize(version());

    expect(
      await h.service.execute({
        kind: "reimport-artifact-from-file",
        canvasId,
        expectedVersionId: "30000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ kind: "mirror-refused", reason: "stale-version" });
    expect(h.appendVersionFromBundle).not.toHaveBeenCalled();
  });

  it("does nothing when the file still matches the artifact", async () => {
    const h = await withGlobalFolder(harness());
    await h.service.materialize(version());

    expect(
      await h.service.execute({
        kind: "reimport-artifact-from-file",
        canvasId,
        expectedVersionId: "30000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ kind: "mirror-refused", reason: "file-unchanged" });
  });

  it("refuses a file that is another artifact's bundle", async () => {
    const h = await withGlobalFolder(harness());
    await h.service.materialize(version());
    const path = "/Users/me/Artifacts/storefront/launch-plan-1a2b3c4d.octant.json";
    const foreign = buildArtifactBundle({
      ...version(),
      canvasId: "99999999-0000-4000-8000-000000000009",
    } as unknown as CanvasVersion);
    h.files.set(path, foreign.bundle);

    expect(
      await h.service.execute({
        kind: "reimport-artifact-from-file",
        canvasId,
        expectedVersionId: "30000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ kind: "mirror-refused", reason: "file-not-a-bundle" });
    expect(h.appendVersionFromBundle).not.toHaveBeenCalled();
  });

  it("re-imports an edited mirrored bundle for a person-paired device through real CanvasService wiring with remote-device journal attribution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octant-mirror-reimport-device-"));
    try {
      const now = "2026-08-18T10:00:00.000Z";
      const connection = openSqlite(join(dir, "events.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => now);
      const registry = registerArtifactMirrorEvents(
        new EventRegistry()
          .register(CANVAS_CREATED, 1, CanvasCreated)
          .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended),
      );
      const journal = new Journal({
        connection,
        registry,
        projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
        clock: () => now as never,
      });
      let counter = 0;
      const nextUuid = () =>
        `90909090-9090-4090-8090-${(counter += 1).toString(16).padStart(12, "0")}`;
      const localActor = Schema.decodeUnknownSync(EventActor)({
        kind: "system",
        actorId: "50000000-0000-4000-8000-000000000001",
      });
      const canvasProjection = new CanvasProjection();
      const canvasEventStore = new CanvasEventStore({
        journal,
        uuid: nextUuid,
        actor: localActor,
      });
      const initial = decodeCanvasVersion({
        schemaVersion: CANVAS_SCHEMA_VERSION,
        canvasId,
        versionId: "30000000-0000-4000-8000-000000000001",
        sequence: 1,
        definition: {
          schemaVersion: CANVAS_SCHEMA_VERSION,
          title: "Launch plan",
          provenance: {
            hostId: LOCAL_HOST_ID,
            projectId,
            actor: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
            providerInstanceId: "60000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            createdAt: "2026-08-18T09:00:00.000Z",
            mode: "work",
            threadId: "70000000-0000-4000-8000-000000000001",
          },
          sourceManifest: [],
          blocks: [
            {
              blockId: "t1",
              schemaVersion: CANVAS_SCHEMA_VERSION,
              kind: "heading",
              level: 1,
              text: "Ship it.",
            },
          ],
        },
        createdBy: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
        createdAt: "2026-08-18T09:00:00.000Z",
      });
      const typedCanvasId = decodeCanvasId(canvasId);
      const typedProjectId = decodeProjectId(projectId);
      canvasEventStore.appendCreate({
        canvasId: typedCanvasId,
        version: initial,
        occurredAt: now as never,
      });
      canvasProjection.applyCreated({ canvasId: typedCanvasId, version: initial });
      const canvasService = new CanvasService(
        {
          projection: canvasProjection,
          eventStore: canvasEventStore,
          uuid: nextUuid,
          clock: () => now as never,
        },
        {
          authorize: () => true,
        },
      );
      const mirrorEventStore = new ArtifactMirrorEventStore({
        journal,
        uuid: nextUuid,
        clock: () => now as never,
        actor: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
      });
      const files = new Map<string, string>();
      const mirror = new ArtifactMirrorService({
        files: {
          write: async (path, contents) => {
            files.set(path, contents);
          },
          read: async (path) => files.get(path),
          remove: async (path) => {
            files.delete(path);
          },
          resolveRoot: async (path) => path,
        },
        currentVersion: (id) => canvasProjection.getById(id)?.currentVersion,
        projects: { read: () => ({ name: "Storefront" }) },
        outsideRootApproved: () => true,
        planMode: () => false,
        appendVersionFromBundle: (input) =>
          appendArtifactMirrorBundleVersion({
            ...input,
            readCanvasEntry: (id) => canvasProjection.getById(id),
            readProject: (id) =>
              String(id) === projectId
                ? { id: typedProjectId, type: "work", lifecycle: "active" }
                : undefined,
            resolveCanvasWorkspace: () => ({
              kind: "work-root",
              projectId: typedProjectId,
              rootId: Schema.decodeUnknownSync(ThreadCreationRootId)(
                "80000000-0000-4000-8000-000000000001",
              ),
            }),
            canvasService,
            uuid: nextUuid,
          }),
        journal: mirrorEventStore,
        clock: () => now as never,
      });

      const deviceId = "00000000-0000-4000-8000-00000000d901";
      const remoteActor = Schema.decodeUnknownSync(EventActor)({
        kind: "remote-device",
        actorId: deviceId,
        deviceId,
      });

      await mirror.execute(
        {
          kind: "set-artifact-mirror-fallback",
          expectedVersion: 0,
          destination: { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" },
        },
        remoteActor,
      );
      await mirror.materialize(initial);
      const bundlePath = "/Users/me/Artifacts/storefront/launch-plan-1a2b3c4d.octant.json";
      const written = files.get(bundlePath);
      expect(written).toBeDefined();
      files.set(bundlePath, (written ?? "").replace("Ship it.", "Ship it from phone."));

      const result = await mirror.execute(
        {
          kind: "reimport-artifact-from-file",
          canvasId,
          expectedVersionId: String(initial.versionId),
        },
        remoteActor,
      );

      expect(result).toMatchObject({ kind: "artifact-reimported", canvasId });
      const head = canvasProjection.getById(typedCanvasId)?.currentVersion;
      expect(head?.sequence).toBe(2);
      expect(head?.definition.blocks[0]).toMatchObject({ text: "Ship it from phone." });

      const canvasFrames = journal.replayAggregate({
        aggregateType: CANVAS_AGGREGATE_TYPE,
        aggregateId: canvasId,
        afterVersion: 0,
        limit: 10,
      });
      const appendedFrame = canvasFrames.find(
        (frame) => frame.eventName === CANVAS_VERSION_APPENDED,
      );
      expect(appendedFrame?.actor).toEqual(remoteActor);

      const mirrorFrames = journal.replayAggregate({
        aggregateType: ARTIFACT_MIRROR_AGGREGATE_TYPE,
        aggregateId: canvasId,
        afterVersion: 0,
        limit: 10,
      });
      const reimportedFrame = mirrorFrames.find(
        (frame) => frame.eventName === ARTIFACT_MIRROR_EVENT_NAMES.reimported,
      );
      expect(reimportedFrame?.actor).toEqual(remoteActor);
      connection.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
