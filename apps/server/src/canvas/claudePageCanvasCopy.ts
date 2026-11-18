import type { ArtifactLibraryClaudeCopyRequest } from "@octant/contracts/artifact-library";
import type {
  CanvasHtmlImportRequest,
  CanvasHtmlImportResult,
  CanvasWorkspaceScope,
} from "@octant/contracts/canvas-cards";
import type {
  HostId,
  PublishedSnapshotRunRequest,
  ThreadPublishedSnapshot,
  WindowId,
} from "@octant/contracts";
import type { CanvasAuthorizationContext, CanvasProjectRecord } from "./canvasService";

export interface ClaudePageCanvasCopyDependencies {
  readonly hostId: HostId;
  /** The kept snapshot, read under the publishing thread's read check for this window. */
  readonly findPublishedSnapshot: (
    windowId: WindowId,
    request: PublishedSnapshotRunRequest,
  ) => Promise<ThreadPublishedSnapshot | undefined>;
  /** The publishing thread's own workspace, from durable host state; undefined while it is not active. */
  readonly resolveThreadWorkspace: (thread: {
    readonly mode: "work" | "code";
    readonly threadId: string;
  }) => CanvasWorkspaceScope | undefined;
  readonly readProject: (projectId: string) => CanvasProjectRecord | undefined;
  readonly importHtml: (
    request: CanvasHtmlImportRequest,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord,
  ) => CanvasHtmlImportResult;
  readonly requestId: () => string;
}

/**
 * A Canvas in the library has no thread a create could name, so a copy of a
 * Claude page is created where the page was made: the publishing thread's
 * own Project and mode, with that thread as its origin. The scope comes from
 * the thread's durable record, never from the request, and the create runs
 * through the HTML importer, so the page is bounded and stripped exactly as an
 * imported file is.
 */
export async function copyClaudePageToCanvas(
  dependencies: ClaudePageCanvasCopyDependencies,
  windowId: WindowId,
  request: ArtifactLibraryClaudeCopyRequest,
): Promise<CanvasHtmlImportResult> {
  const snapshot = await dependencies.findPublishedSnapshot(windowId, {
    mode: request.mode,
    threadId: request.threadId,
    toolCallId: request.toolCallId,
  });
  if (snapshot === undefined) {
    return {
      kind: "denied",
      denialCode: "unavailable",
      message: "No snapshot of this page is available here.",
    };
  }
  if (snapshot.format !== "html") {
    return {
      kind: "refused",
      reason: "not-html",
      message: "Only an HTML page can be copied into a Canvas.",
    };
  }
  const workspace = dependencies.resolveThreadWorkspace({
    mode: request.mode,
    threadId: request.threadId,
  });
  const project =
    workspace?.projectId === undefined || workspace.projectId === null
      ? undefined
      : dependencies.readProject(String(workspace.projectId));
  if (
    workspace === undefined ||
    project === undefined ||
    project.lifecycle !== "active" ||
    project.type !== request.mode
  ) {
    return {
      kind: "denied",
      denialCode: "unavailable",
      message: "The thread that published this page is no longer open in its Project.",
    };
  }
  return dependencies.importHtml(
    {
      schemaVersion: 1,
      kind: "canvas-html-import",
      requestId: dependencies.requestId() as CanvasHtmlImportRequest["requestId"],
      hostId: dependencies.hostId,
      mode: request.mode,
      workspace,
      originThreadId: request.threadId as CanvasHtmlImportRequest["originThreadId"],
      requestedAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
      source: "file",
      html: snapshot.content,
      ...(request.title === undefined ? {} : { title: request.title }),
    },
    { mode: request.mode, projectId: project.id },
    project,
  );
}
