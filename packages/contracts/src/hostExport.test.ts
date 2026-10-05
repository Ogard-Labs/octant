import { decodeHostExportBundle } from "./hostExport";
import { describe, expect, it } from "vitest";

const generatedAt = "2026-08-19T12:00:00.000Z";

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
