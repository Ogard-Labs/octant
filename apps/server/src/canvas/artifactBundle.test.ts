import type { CanvasVersion } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { ARTIFACT_BUNDLE_FORMAT, buildArtifactBundle, readArtifactBundle } from "./artifactBundle";

function version(overrides: { readonly title?: string; readonly blocks?: unknown } = {}) {
  return {
    schemaVersion: 1,
    canvasId: "1a2b3c4d-0000-4000-8000-000000000001",
    versionId: "30000000-0000-4000-8000-000000000001",
    sequence: 4,
    definition: {
      schemaVersion: 1,
      title: overrides.title ?? "Launch plan",
      provenance: {
        hostId: "host-1",
        projectId: "20000000-0000-4000-8000-000000000001",
        actor: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
        providerInstanceId: "60000000-0000-4000-8000-000000000001",
        modelId: "model-a",
        createdAt: "2026-08-18T09:00:00.000Z",
        mode: "work",
        threadId: "70000000-0000-4000-8000-000000000001",
      },
      sourceManifest: { sources: [] },
      blocks: overrides.blocks ?? [
        { blockId: "h1", schemaVersion: 1, kind: "heading", level: 1, text: "Sequence" },
        { blockId: "t1", schemaVersion: 1, kind: "rich-text", text: "Ship the preview first." },
        { blockId: "d1", schemaVersion: 1, kind: "diagram", nodes: [], edges: [] },
      ],
    },
    createdBy: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
    createdAt: "2026-08-18T09:00:00.000Z",
  } as unknown as CanvasVersion;
}

describe("writing an artifact out as files", () => {
  it("writes a bundle that says which artifact and version it is", () => {
    const files = buildArtifactBundle(version());
    const parsed = JSON.parse(files.bundle) as { octant: Record<string, unknown> };

    expect(parsed.octant).toMatchObject({
      format: ARTIFACT_BUNDLE_FORMAT,
      canvasId: "1a2b3c4d-0000-4000-8000-000000000001",
      versionId: "30000000-0000-4000-8000-000000000001",
      sequence: 4,
      mode: "work",
    });
  });

  it("writes a stable, diff-friendly file so one edit shows one changed line", () => {
    const before = buildArtifactBundle(version()).bundle;
    const after = buildArtifactBundle(
      version({
        blocks: [
          { blockId: "h1", schemaVersion: 1, kind: "heading", level: 1, text: "Sequence" },
          { blockId: "t1", schemaVersion: 1, kind: "rich-text", text: "Ship the gallery first." },
          { blockId: "d1", schemaVersion: 1, kind: "diagram", nodes: [], edges: [] },
        ],
      }),
    ).bundle;

    expect(before.endsWith("\n")).toBe(true);
    const changed = after.split("\n").filter((line, index) => line !== before.split("\n")[index]);
    expect(changed).toHaveLength(1);
  });

  it("carries identity in the readable sidecar's front matter too", () => {
    const files = buildArtifactBundle(version());

    expect(files.markdown.startsWith("---\n")).toBe(true);
    expect(files.markdown).toContain("canvas_id: 1a2b3c4d-0000-4000-8000-000000000001");
    expect(files.markdown).toContain("# Launch plan");
    // A block the sidecar cannot write is named, so the file never claims to be
    // the whole document.
    expect(files.markdown).toContain("_(diagram — see the bundle)_");
    expect(files.markdown).toContain("editing this");
  });

  it("keeps a title with quotes and newlines from breaking the front matter", () => {
    const files = buildArtifactBundle(version({ title: 'A "big"\nplan' }));

    expect(files.markdown).toContain('title: "A \\"big\\" plan"');
    expect(files.markdown.split("---").length).toBe(3);
  });

  it("reads back a bundle it wrote", () => {
    const files = buildArtifactBundle(version());
    const read = readArtifactBundle(files.bundle);

    expect(read?.header.canvasId).toBe("1a2b3c4d-0000-4000-8000-000000000001");
    expect(read?.definition).toMatchObject({ title: "Launch plan" });
  });

  it.each([
    ["not json at all", "hello"],
    ["another tool's json", '{"title":"Launch plan"}'],
    ["a bundle with no header", '{"definition":{}}'],
    [
      "a format this host does not know",
      '{"octant":{"format":"octant.artifact-bundle/9"},"definition":{}}',
    ],
    ["a truncated bundle", '{"octant":{"format":"octant.artifact-bundle/1"},"definit'],
  ])("refuses %s rather than guessing", (_name, text) => {
    expect(readArtifactBundle(text)).toBeUndefined();
  });
});
