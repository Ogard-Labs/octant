import {
  CanvasHtmlImportResult,
  decodeCanvasHtmlImportRequest,
  decodeHostAnswer,
  decodeProjectBrowserCommand,
  decodeProjectTerminalCommand,
  LOCAL_HOST_ID,
  ProjectBrowserResult,
  ProjectTerminalResult,
  type CanvasHtmlImportRequest,
  type ProjectBrowserCommand,
  type ProjectTerminalCommand,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

/**
 * A phone's own Project tools, through the routes the host already takes from
 * a device its own person paired: the device's shell in a local Project, its
 * Private page for that Project, and an HTML page imported into a new Canvas.
 * The host decides everything that matters (the Project is local and active,
 * a Work Project's Developer tools are on, the shell and page belong to this
 * device and end when it is revoked or goes quiet, a profile page stays at a
 * window); these calls carry the command and return the host's typed answer.
 * A route that answers with an error says why in a refusal, never a throw, so
 * a card can show the host's sentence.
 */

export async function sendMobileProjectTerminal(
  transport: MobileRemoteTransport,
  command: ProjectTerminalCommand,
  signal?: AbortSignal,
): Promise<ProjectTerminalResult> {
  const answer = await post(
    transport,
    "/api/code/project-terminals",
    decodeProjectTerminalCommand(command),
    signal,
  );
  if (answer.status === "refused") {
    return {
      kind: "project-terminal-refused",
      reason:
        answer.httpStatus === 401 || answer.httpStatus === 403 ? "unauthorized" : "unavailable",
      message: answer.message,
    };
  }
  return decode(answer.body, decodeHostAnswer(ProjectTerminalResult), "Project terminal");
}

export async function sendMobileProjectBrowser(
  transport: MobileRemoteTransport,
  command: ProjectBrowserCommand,
  signal?: AbortSignal,
): Promise<ProjectBrowserResult> {
  const answer = await post(
    transport,
    "/api/browser/project-contexts",
    decodeProjectBrowserCommand(command),
    signal,
  );
  if (answer.status === "refused") {
    return {
      kind: "project-browser-refused",
      reason:
        answer.httpStatus === 401 || answer.httpStatus === 403 ? "unauthorized" : "unavailable",
      message: answer.message,
    };
  }
  return decode(answer.body, decodeHostAnswer(ProjectBrowserResult), "Project page");
}

/**
 * The authority a Canvas import asks for, the same a Canvas created from a
 * Chat thread asks for: tools only, at Plan. The import widens nothing.
 */
const CANVAS_IMPORT_AUTHORITY = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
} as const;

/**
 * An HTML page brought into a new Canvas from a Chat thread on the phone. A
 * device has no workspace on the host, so the request names the thread's
 * Project (or none) in its workspace scope and the host checks it before it
 * journals anything.
 */
export function mobileChatCanvasHtmlImport(input: {
  readonly requestId: string;
  readonly threadId: string;
  readonly projectId: string | undefined;
  readonly source: "file" | "paste";
  readonly html: string;
  readonly title?: string | undefined;
  readonly fileName?: string | undefined;
}): CanvasHtmlImportRequest {
  const title = input.title?.trim() ?? "";
  const fileName = input.fileName?.trim() ?? "";
  return decodeCanvasHtmlImportRequest({
    schemaVersion: 1,
    kind: "canvas-html-import",
    requestId: input.requestId,
    hostId: LOCAL_HOST_ID,
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: input.projectId ?? null },
    originThreadId: input.threadId,
    requestedAuthority: CANVAS_IMPORT_AUTHORITY,
    source: input.source,
    html: input.html,
    ...(title.length === 0 ? {} : { title }),
    ...(input.source === "file" && fileName.length > 0 ? { fileName } : {}),
  });
}

export async function importMobileCanvasHtml(
  transport: MobileRemoteTransport,
  request: CanvasHtmlImportRequest,
): Promise<CanvasHtmlImportResult> {
  const answer = await post(
    transport,
    "/api/canvas/import-html",
    decodeCanvasHtmlImportRequest(request),
    undefined,
  );
  if (answer.status === "refused") {
    return {
      kind: "denied",
      denialCode:
        answer.httpStatus === 401 || answer.httpStatus === 403 ? "unauthorized" : "unavailable",
      message: answer.message,
    };
  }
  return decode(answer.body, decodeHostAnswer(CanvasHtmlImportResult), "Canvas import");
}

type PostAnswer =
  | { readonly status: "ok"; readonly body: unknown }
  | { readonly status: "refused"; readonly httpStatus: number; readonly message: string };

async function post(
  transport: MobileRemoteTransport,
  path: string,
  command: unknown,
  signal: AbortSignal | undefined,
): Promise<PostAnswer> {
  const response = await transport.authenticatedFetch({
    method: "POST",
    path,
    body: JSON.stringify(command),
    contentType: "application/json",
    ...(signal === undefined ? {} : { signal }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return { status: "ok", body };
  return {
    status: "refused",
    httpStatus: response.status,
    message: hostMessage(body) ?? "The host did not take that request.",
  };
}

function hostMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("message" in body)) return undefined;
  const message = body.message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim().slice(0, 512)
    : undefined;
}

function decode<T>(body: unknown, decoder: (value: unknown) => T, what: string): T {
  try {
    return decoder(body);
  } catch {
    throw new MobileInboxFailure("incompatible", `${what}: the host returned an invalid response.`);
  }
}
