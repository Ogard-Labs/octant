import { describe, expect, it } from "vitest";
import {
  decodeCanvasExportFolderCommand,
  decodeCanvasExportFolderResult,
  decodeCanvasExportFolderSettings,
  decodeCanvasExportFolderView,
} from "./canvasExportFolder";

const canvasId = "11111111-1111-4111-8111-111111111111";
const projectId = "77777777-7777-4777-8777-777777777777";
const candidateId = "88888888-8888-4888-8888-888888888888";

describe("canvas export folder contracts", () => {
  it("starts with no folder named and one choice per Project", () => {
    const settings = decodeCanvasExportFolderSettings({
      kind: "canvas-export-folder-settings",
      overrides: [],
      version: 0,
      updatedAt: "2026-08-01T21:00:00.000Z",
    });

    expect(settings.fallback).toBeUndefined();
    expect(settings.overrides).toEqual([]);
  });

  it("refuses two choices for one Project", () => {
    expect(() =>
      decodeCanvasExportFolderSettings({
        kind: "canvas-export-folder-settings",
        overrides: [
          { projectId, folder: "/Users/example/One" },
          { projectId, folder: "/Users/example/Two" },
        ],
        version: 2,
        updatedAt: "2026-08-01T21:00:00.000Z",
      }),
    ).toThrow();
  });

  it("refuses a folder that is not an absolute path", () => {
    expect(() =>
      decodeCanvasExportFolderSettings({
        kind: "canvas-export-folder-settings",
        fallback: "Documents/Exports",
        overrides: [],
        version: 1,
        updatedAt: "2026-08-01T21:00:00.000Z",
      }),
    ).toThrow();
  });

  it("carries a choose command as a browser candidate, never a path", () => {
    const command = decodeCanvasExportFolderCommand({
      schemaVersion: 1,
      kind: "choose-canvas-export-folder",
      canvasId,
      mode: "work",
      candidateId,
      scope: "project",
      expectedVersion: 0,
    });

    expect(command.candidateId).toBe(candidateId);
    expect(command.scope).toBe("project");
  });

  it("refuses a choose command that carries a path instead of a candidate", () => {
    expect(() =>
      decodeCanvasExportFolderCommand({
        schemaVersion: 1,
        kind: "choose-canvas-export-folder",
        canvasId,
        mode: "work",
        candidateId,
        scope: "project",
        expectedVersion: 0,
        folder: "/Users/example/Documents",
      }),
    ).toThrow();
  });

  it("names the scope and the resolved folder a Canvas would export to", () => {
    const view = decodeCanvasExportFolderView({
      kind: "canvas-export-folder-view",
      settings: {
        kind: "canvas-export-folder-settings",
        overrides: [{ projectId, folder: "/Users/example/Documents" }],
        version: 1,
        updatedAt: "2026-08-01T21:00:00.000Z",
      },
      folder: "/Users/example/Documents",
      scope: "project",
      hostId: "local",
      mode: "work",
    });

    expect(view.scope).toBe("project");
    expect(view.folder).toBe("/Users/example/Documents");
  });

  it("carries a refusal as a value with the reason the host refused", () => {
    const refused = decodeCanvasExportFolderResult({
      kind: "canvas-export-folder-refused",
      reason: "outside-home",
      message: "That folder is outside your home folder.",
    });

    expect(refused.kind).toBe("canvas-export-folder-refused");
  });
});
