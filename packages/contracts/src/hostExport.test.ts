import { CANVAS_SCHEMA_VERSION } from "./canvasIdentity";
import { decodeHostExportBundle, decodeHostExportCanvas } from "./hostExport";
import { describe, expect, it } from "vitest";

const generatedAt = "2026-08-19T12:00:00.000Z";
const projectId = "20000000-0000-4000-8000-000000000001";

const threadOwnedCanvas = {
  canvasId: "11111111-1111-4111-8111-111111111112",
  projectId: null,
  mode: "chat",
  title: "Memo",
  updatedAt: generatedAt,
  definition: {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title: "Memo",
    provenance: {
      mode: "chat",
      hostId: "local",
      projectId: null,
      threadId: "99999999-9999-4999-8999-999999999999",
      actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      modelId: "octant-test-model",
      createdAt: generatedAt,
    },
    sourceManifest: [],
    blocks: [
      {
        blockId: "block-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "heading",
        level: 1,
        text: "Memo",
      },
    ],
  },
};

describe("host export canvas", () => {
  it("carries a Canvas owned by a Chat thread with no Project beside an older Project Canvas", () => {
    expect(decodeHostExportCanvas(threadOwnedCanvas).projectId).toBeNull();
    const projectCanvas = {
      ...threadOwnedCanvas,
      projectId,
      definition: {
        ...threadOwnedCanvas.definition,
        schemaVersion: 19,
        provenance: { ...threadOwnedCanvas.definition.provenance, projectId },
        blocks: threadOwnedCanvas.definition.blocks.map((block) => ({
          ...block,
          schemaVersion: 19,
        })),
      },
    };
    expect(decodeHostExportCanvas(projectCanvas).projectId).toBe(projectId);
    expect(() => decodeHostExportCanvas({ ...threadOwnedCanvas, projectId: undefined })).toThrow();
  });
});

describe("host export bundle", () => {
  it("decodes an empty local cut and rejects an extra field", () => {
    const bundle = {
      octant: {
        format: "octant.host-export/1",
        hostId: "local",
        generatedAt,
        threadCount: 0,
      },
      threads: [],
      projects: [],
      projectMemory: [],
      canvases: [],
      settings: { chatEnabled: true, workEnabled: false, themeMode: "dark" },
      usage: [],
      retention: { windows: [], tombstones: [] },
      omissions: [
        {
          subject: "credentials",
          reason: "Secrets, tokens, and credential material are unrepresentable.",
        },
      ],
    };
    expect(decodeHostExportBundle(bundle).octant.threadCount).toBe(0);
    expect(() => decodeHostExportBundle({ ...bundle, apiKey: "secret" })).toThrow();
  });
});
