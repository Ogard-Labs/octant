import { decodeHostId, decodeProjectId, decodeWindowId } from "@octant/contracts";
import {
  decodeCanvasHtmlImportRequest,
  type CanvasHtmlImportResult,
} from "@octant/contracts/canvas-cards";
import { describe, expect, it, vi } from "vitest";
import {
  copyClaudePageToCanvas,
  type ClaudePageCanvasCopyDependencies,
} from "./claudePageCanvasCopy";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000931");
const projectId = decodeProjectId("33333333-3333-4333-8333-333333333333");
const threadId = "22222222-2222-4222-8222-222222222222";
const request = { mode: "work", threadId, toolCallId: "call-1", title: "Launch plan" } as const;

function dependencies(overrides: Partial<ClaudePageCanvasCopyDependencies> = {}) {
  const imported: CanvasHtmlImportResult = {
    kind: "refused",
    reason: "empty",
    message: "stand-in for the importer's answer",
  };
  const importHtml = vi.fn<ClaudePageCanvasCopyDependencies["importHtml"]>(() => imported);
  const deps: ClaudePageCanvasCopyDependencies = {
    hostId: decodeHostId("local"),
    findPublishedSnapshot: async () => ({ format: "html", content: "<h1>Launch</h1>" }),
    resolveThreadWorkspace: () => ({
      kind: "work-root",
      projectId,
      rootId: "44444444-4444-4444-8444-444444444444" as never,
    }),
    readProject: () => ({ id: String(projectId), type: "work", lifecycle: "active" }),
    importHtml,
    requestId: () => "55555555-5555-4555-8555-555555555555",
    ...overrides,
  };
  return { deps, importHtml, imported };
}

describe("copying a Claude page's snapshot into a Canvas", () => {
  it("imports the kept HTML into the publishing thread's own Project with the person's title", async () => {
    const { deps, importHtml, imported } = dependencies();
    const result = await copyClaudePageToCanvas(deps, windowId, request);
    expect(result).toBe(imported);
    const [sent, context, project] = importHtml.mock.calls[0] ?? [];
    // The request is a well-formed import of the host's own copy of the page.
    expect(decodeCanvasHtmlImportRequest(sent)).toMatchObject({
      mode: "work",
      workspace: { kind: "work-root", projectId },
      originThreadId: threadId,
      html: "<h1>Launch</h1>",
      title: "Launch plan",
    });
    expect(context).toEqual({ mode: "work", projectId: String(projectId) });
    expect(project).toEqual({ id: String(projectId), type: "work", lifecycle: "active" });
  });

  it("creates nothing when the window's read check finds no snapshot", async () => {
    const { deps, importHtml } = dependencies({ findPublishedSnapshot: async () => undefined });
    expect(await copyClaudePageToCanvas(deps, windowId, request)).toMatchObject({
      kind: "denied",
      denialCode: "unavailable",
    });
    expect(importHtml).not.toHaveBeenCalled();
  });

  it("refuses a Markdown snapshot, which is not an HTML page", async () => {
    const { deps, importHtml } = dependencies({
      findPublishedSnapshot: async () => ({ format: "markdown", content: "# Launch" }),
    });
    expect(await copyClaudePageToCanvas(deps, windowId, request)).toMatchObject({
      kind: "refused",
      reason: "not-html",
    });
    expect(importHtml).not.toHaveBeenCalled();
  });

  it("creates nothing once the publishing thread or its Project is no longer active", async () => {
    const gone = dependencies({ resolveThreadWorkspace: () => undefined });
    expect(await copyClaudePageToCanvas(gone.deps, windowId, request)).toMatchObject({
      kind: "denied",
    });
    expect(gone.importHtml).not.toHaveBeenCalled();
    const archived = dependencies({
      readProject: () => ({ id: String(projectId), type: "work", lifecycle: "archived" }),
    });
    expect(await copyClaudePageToCanvas(archived.deps, windowId, request)).toMatchObject({
      kind: "denied",
    });
    expect(archived.importHtml).not.toHaveBeenCalled();
  });
});
