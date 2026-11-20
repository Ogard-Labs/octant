import { describe, expect, it } from "vitest";
import {
  decodeCodeTerminalId,
  decodeProjectId,
  type CanvasHtmlImportRequest,
} from "@octant/contracts";
import {
  importMobileCanvasHtml,
  mobileChatCanvasHtmlImport,
  sendMobileProjectBrowser,
  sendMobileProjectTerminal,
} from "./mobileProjectToolsClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");
const terminalId = decodeCodeTerminalId("30000000-0000-4000-8000-000000000001");
const threadId = "40000000-0000-4000-8000-000000000001";

function host(answer: () => Response) {
  const calls: Array<{ path: string; body: unknown; contentType?: string }> = [];
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: (async (input: { path: string; body?: string; contentType?: string }) => {
      calls.push({
        path: input.path,
        body: JSON.parse(input.body ?? "null"),
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      });
      return answer();
    }) as MobileRemoteTransport["authenticatedFetch"],
  };
  return { transport, calls };
}

describe("a phone's own Project terminal", () => {
  it("sends the command to the host's Project terminal route and returns its answer", async () => {
    const { transport, calls } = host(
      () =>
        new Response(
          JSON.stringify({
            kind: "project-terminal",
            terminal: { projectId, terminalId, state: "running", posture: "approval-gated" },
            output: { text: "$ ", replace: false, characters: 2 },
          }),
        ),
    );
    const answer = await sendMobileProjectTerminal(transport, {
      kind: "read-output",
      projectId,
      terminalId,
      afterCharacters: 0,
    });
    expect(answer).toMatchObject({ kind: "project-terminal", output: { text: "$ " } });
    expect(calls).toEqual([
      {
        path: "/api/code/project-terminals",
        body: { kind: "read-output", projectId, terminalId, afterCharacters: 0 },
        contentType: "application/json",
      },
    ]);
  });

  it("turns a route's error into a refusal carrying the host's sentence", async () => {
    const { transport } = host(
      () =>
        new Response(
          JSON.stringify({
            category: "unauthorized",
            message: "Only you, from a window or a device you paired, can open this.",
          }),
          { status: 403 },
        ),
    );
    const answer = await sendMobileProjectTerminal(transport, {
      kind: "stop",
      projectId,
      terminalId,
    });
    expect(answer).toEqual({
      kind: "project-terminal-refused",
      reason: "unauthorized",
      message: "Only you, from a window or a device you paired, can open this.",
    });
  });
});

describe("a phone's own Private page", () => {
  it("opens the page through the Project browser route and shows the host's refusal", async () => {
    const { transport, calls } = host(
      () =>
        new Response(
          JSON.stringify({
            kind: "project-browser-refused",
            reason: "invalid",
            message: "The browser will not open that address.",
          }),
        ),
    );
    const answer = await sendMobileProjectBrowser(transport, {
      kind: "open",
      projectId,
      url: "https://example.com",
      profile: "private",
    });
    expect(answer).toMatchObject({ kind: "project-browser-refused", reason: "invalid" });
    expect(calls[0]).toMatchObject({
      path: "/api/browser/project-contexts",
      body: { kind: "open", projectId, url: "https://example.com", profile: "private" },
    });
  });
});

describe("importing an HTML page into a Canvas from a Chat thread on the phone", () => {
  it("names the thread's Project in the workspace scope and asks for no more than a Chat Canvas", () => {
    const request = mobileChatCanvasHtmlImport({
      requestId: "50000000-0000-4000-8000-000000000001",
      threadId,
      projectId: undefined,
      source: "paste",
      html: "<p>Hi</p>",
      title: "  Launch page ",
      fileName: "ignored.html",
    });
    expect(request).toEqual({
      schemaVersion: 1,
      kind: "canvas-html-import",
      requestId: "50000000-0000-4000-8000-000000000001",
      hostId: "local",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      originThreadId: threadId,
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
      source: "paste",
      html: "<p>Hi</p>",
      title: "Launch page",
    });
    expect(
      mobileChatCanvasHtmlImport({
        requestId: "50000000-0000-4000-8000-000000000002",
        threadId,
        projectId,
        source: "file",
        html: "<p>Hi</p>",
        fileName: "page.html",
      }),
    ).toMatchObject({
      workspace: { kind: "chat-virtual", projectId },
      fileName: "page.html",
    });
  });

  it("posts the import and passes the host's denial through", async () => {
    const { transport, calls } = host(
      () =>
        new Response(
          JSON.stringify({
            kind: "denied",
            denialCode: "unauthorized",
            message: "Canvas create is not authorized in this workspace.",
          }),
        ),
    );
    const request: CanvasHtmlImportRequest = mobileChatCanvasHtmlImport({
      requestId: "50000000-0000-4000-8000-000000000003",
      threadId,
      projectId: undefined,
      source: "paste",
      html: "<p>Hi</p>",
    });
    const answer = await importMobileCanvasHtml(transport, request);
    expect(answer).toEqual({
      kind: "denied",
      denialCode: "unauthorized",
      message: "Canvas create is not authorized in this workspace.",
    });
    expect(calls[0]?.path).toBe("/api/canvas/import-html");
  });
});
