import { describe, expect, it } from "vitest";
import { decodeCanvasId, decodeProjectId } from "@octant/contracts";
import {
  authorizeCanvasInventoryAccess,
  chatThreadHoldsCanvas,
  classifyCanvasTabAuthority,
  classifyCanvasTabRestore,
  classifyThreadOwnedCanvasTab,
  filterCanvasInventoryEntries,
} from "./canvasInventoryPolicy";

const project = decodeProjectId("77777777-7777-4777-8777-777777777777");
const otherProject = decodeProjectId("88888888-8888-4888-8888-888888888888");
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");

const entry = {
  canvasId,
  projectId: project,
  mode: "chat" as const,
  title: "Quarterly summary",
  versionCount: 1,
  currentVersionId: "22222222-2222-4222-8222-222222222222" as never,
  currentSequence: 1,
  updatedAt: "2026-08-01T21:00:00.000Z" as never,
};

describe("classifyCanvasTabAuthority", () => {
  it("binds when the active Project matches", () => {
    expect(classifyCanvasTabAuthority({ tabProjectId: project, activeProjectId: project })).toBe(
      "bound",
    );
  });

  it("fails closed across Projects", () => {
    expect(
      classifyCanvasTabAuthority({ tabProjectId: project, activeProjectId: otherProject }),
    ).toBe("unavailable");
    expect(classifyCanvasTabAuthority({ tabProjectId: project, activeProjectId: null })).toBe(
      "unavailable",
    );
  });
});

describe("classifyCanvasTabRestore", () => {
  it("restores bound tabs when projection and Project still match", () => {
    expect(
      classifyCanvasTabRestore({
        tabProjectId: project,
        activeProjectId: project,
        canvasProjectId: project,
      }),
    ).toBe("bound");
  });

  it("quarantines missing, mismatched, and cross-Project canvases", () => {
    expect(
      classifyCanvasTabRestore({
        tabProjectId: project,
        activeProjectId: project,
        canvasProjectId: null,
      }),
    ).toBe("unavailable-canvas");
    expect(
      classifyCanvasTabRestore({
        tabProjectId: project,
        activeProjectId: project,
        canvasProjectId: otherProject,
      }),
    ).toBe("unavailable-mismatch");
    expect(
      classifyCanvasTabRestore({
        tabProjectId: project,
        activeProjectId: otherProject,
        canvasProjectId: project,
      }),
    ).toBe("unavailable-project");
  });
});

describe("classifyThreadOwnedCanvasTab", () => {
  const owned = { projectId: null };

  it("binds a Chat tab to a Canvas its thread still holds, archived or active", () => {
    expect(
      classifyThreadOwnedCanvasTab({
        mode: "chat",
        canvas: owned,
        thread: { lifecycle: "active" },
      }),
    ).toBe("bound");
    expect(
      classifyThreadOwnedCanvasTab({
        mode: "chat",
        canvas: owned,
        thread: { lifecycle: "archived" },
      }),
    ).toBe("bound");
  });

  it("quarantines the tab once the owning thread is deleted, deleting, or gone", () => {
    for (const lifecycle of ["deleted", "deleting"] as const) {
      expect(
        classifyThreadOwnedCanvasTab({ mode: "chat", canvas: owned, thread: { lifecycle } }),
      ).toBe("unavailable-thread");
      expect(chatThreadHoldsCanvas({ lifecycle })).toBe(false);
    }
    expect(classifyThreadOwnedCanvasTab({ mode: "chat", canvas: owned, thread: undefined })).toBe(
      "unavailable-thread",
    );
    expect(chatThreadHoldsCanvas(undefined)).toBe(false);
  });

  it("never stands in for a Project's Canvas, a missing Canvas, or another mode", () => {
    const thread = { lifecycle: "active" as const };
    expect(
      classifyThreadOwnedCanvasTab({ mode: "chat", canvas: { projectId: project }, thread }),
    ).toBe("unavailable-canvas");
    expect(classifyThreadOwnedCanvasTab({ mode: "chat", canvas: undefined, thread })).toBe(
      "unavailable-canvas",
    );
    expect(classifyThreadOwnedCanvasTab({ mode: "work", canvas: owned, thread })).toBe(
      "unavailable-canvas",
    );
  });
});

describe("filterCanvasInventoryEntries", () => {
  it("filters by title query", () => {
    const filtered = filterCanvasInventoryEntries(
      [
        entry,
        {
          ...entry,
          canvasId: decodeCanvasId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          title: "Runbook",
        },
      ],
      "quarter",
    );
    expect(filtered.map((row) => row.title)).toEqual(["Quarterly summary"]);
  });
});

describe("authorizeCanvasInventoryAccess", () => {
  it("authorizes only the active matching Project and mode", () => {
    expect(
      authorizeCanvasInventoryAccess({
        requestedProjectId: project,
        activeProjectId: project,
        activeMode: "chat",
        projectMode: "chat",
      }),
    ).toBe(true);
    expect(
      authorizeCanvasInventoryAccess({
        requestedProjectId: project,
        activeProjectId: otherProject,
        activeMode: "chat",
        projectMode: "chat",
      }),
    ).toBe(false);
    expect(
      authorizeCanvasInventoryAccess({
        requestedProjectId: project,
        activeProjectId: project,
        activeMode: "work",
        projectMode: "chat",
      }),
    ).toBe(false);
  });
});
