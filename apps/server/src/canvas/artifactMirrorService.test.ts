import type { CanvasVersion } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildArtifactBundle } from "./artifactBundle";
import {
  ArtifactMirrorService,
  type ArtifactMirrorServiceDependencies,
} from "./artifactMirrorService";

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
    readonly current?: CanvasVersion;
  } = {},
) {
  const files = options.files ?? new Map<string, string>();
  const write = vi.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  });
  const remove = vi.fn(async (path: string) => {
    files.delete(path);
  });
  const journal = { append: vi.fn() };
  const appendVersionFromBundle = vi.fn(
    (_input: { readonly canvasId: unknown; readonly definition: unknown }) =>
      ({ kind: "accepted", versionId: "30000000-0000-4000-8000-0000000000ff" }) as const,
  );
  const dependencies: ArtifactMirrorServiceDependencies = {
    files: {
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
});
