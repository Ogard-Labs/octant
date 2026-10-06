import { describe, expect, it } from "vitest";
import {
  decodeCanvasExportFolderSettings,
  type CanvasExportFolderSettings,
} from "@octant/contracts/canvas-export-folder";
import {
  MAX_CANVAS_EXPORT_NAME_COPIES,
  canvasExportFolderRefusalText,
  canvasExportPlannedName,
  canvasExportStem,
  judgeCanvasExportFolder,
  planCanvasExportFileName,
  resolveCanvasExportFolder,
} from "./canvasExportFolderPolicy";

const PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const chosenAt = "2026-08-01T21:00:00.000Z";

function settings(input: {
  readonly fallback?: string;
  readonly overrides?: ReadonlyArray<{ readonly projectId: string; readonly folder: string }>;
  readonly version: number;
}): CanvasExportFolderSettings {
  return decodeCanvasExportFolderSettings({
    kind: "canvas-export-folder-settings",
    ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
    overrides: input.overrides ?? [],
    version: input.version,
    updatedAt: chosenAt,
  });
}

const host = settings({ fallback: "/Users/example/Documents/Octant", version: 1 });

const projectOverride = settings({
  fallback: "/Users/example/Documents/Octant",
  overrides: [{ projectId: PROJECT_ID, folder: "/Users/example/Handovers" }],
  version: 2,
});

describe("canvas export folder policy", () => {
  it("resolves a Project's own folder ahead of the host's", () => {
    expect(resolveCanvasExportFolder(projectOverride, PROJECT_ID)).toBe("/Users/example/Handovers");
  });

  it("falls back to the host's folder for a thread filed nowhere", () => {
    expect(resolveCanvasExportFolder(projectOverride, undefined)).toBe(
      "/Users/example/Documents/Octant",
    );
    expect(resolveCanvasExportFolder(host, PROJECT_ID)).toBe("/Users/example/Documents/Octant");
  });

  it("reports no folder at all before anyone has chosen one", () => {
    expect(resolveCanvasExportFolder(settings({ version: 0 }), PROJECT_ID)).toBe(undefined);
  });

  it("refuses a folder outside home while no standing approval exists", () => {
    const verdict = judgeCanvasExportFolder({
      folder: "/Volumes/Shared/Exports",
      writable: true,
      insideHome: false,
      standingOutsideApproval: false,
    });

    expect(verdict).toEqual({ status: "refused", reason: "outside-home" });
    expect(canvasExportFolderRefusalText("outside-home")).toContain("outside your home");
  });

  it("accepts a folder outside home once the standing approval exists", () => {
    const verdict = judgeCanvasExportFolder({
      folder: "/Volumes/Shared/Exports",
      writable: true,
      insideHome: false,
      standingOutsideApproval: true,
    });

    expect(verdict).toEqual({ status: "accepted", folder: "/Volumes/Shared/Exports" });
  });

  it("refuses a folder that cannot be read or written", () => {
    const verdict = judgeCanvasExportFolder({
      folder: "/Users/example/Gone",
      writable: false,
      insideHome: true,
      standingOutsideApproval: false,
    });

    expect(verdict).toEqual({ status: "refused", reason: "folder-unavailable" });
  });

  it("names the file from the Canvas title with the extension of the rendered format", () => {
    expect(canvasExportPlannedName("Launch plan", "markdown")).toBe("Launch plan.md");
    expect(canvasExportPlannedName("Launch plan", "html")).toBe("Launch plan.html");
  });

  it("turns a title that would leave the folder into a plain name", () => {
    expect(canvasExportStem("../../etc/passwd")).toBe("etc passwd");
    expect(canvasExportStem("   ")).toBe("canvas");
    expect(canvasExportStem(".hidden")).toBe("hidden");
    expect(canvasExportStem("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("writes a numbered copy beside a name that is already taken", () => {
    const taken = new Set(["Launch plan.md"]);
    const fileName = planCanvasExportFileName({
      title: "Launch plan",
      format: "markdown",
      taken: (candidate) => taken.has(candidate),
      replacesConfirmed: false,
    });

    expect(fileName).toBe("Launch plan (2).md");
  });

  it("keeps counting past the copies that also exist", () => {
    const taken = new Set(["Launch plan.md", "Launch plan (2).md", "Launch plan (3).md"]);
    const fileName = planCanvasExportFileName({
      title: "Launch plan",
      format: "markdown",
      taken: (candidate) => taken.has(candidate),
      replacesConfirmed: false,
    });

    expect(fileName).toBe("Launch plan (4).md");
  });

  it("reuses a taken name when the person approved replacing that file", () => {
    const fileName = planCanvasExportFileName({
      title: "Launch plan",
      format: "markdown",
      taken: () => true,
      replacesConfirmed: true,
    });

    expect(fileName).toBe("Launch plan.md");
  });

  it("gives up on a name when every numbered copy is taken", () => {
    const fileName = planCanvasExportFileName({
      title: "Launch plan",
      format: "markdown",
      taken: () => true,
      replacesConfirmed: false,
    });

    expect(fileName).toBeUndefined();
    expect(MAX_CANVAS_EXPORT_NAME_COPIES).toBeGreaterThan(1);
  });

  it("writes the first free name when nothing is in the folder", () => {
    const fileName = planCanvasExportFileName({
      title: "Launch plan",
      format: "html",
      taken: () => false,
      replacesConfirmed: false,
    });

    expect(fileName).toBe("Launch plan.html");
  });
});
