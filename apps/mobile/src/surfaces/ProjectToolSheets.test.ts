// @vitest-environment jsdom
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { ProjectPageSheet, ProjectTerminalSheet } from "./ProjectToolSheets";
import { CanvasHtmlImportSheet } from "./CanvasHtmlImportSheet";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => ({ File: class {}, Paths: { cache: { uri: "cache:" } } }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassChip")),
  ...(await import("../../design-system/GlassSurface")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = "20000000-0000-4000-8000-000000000001";
const threadId = "40000000-0000-4000-8000-000000000001";
const roots: Root[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => {
      root?.unmount();
    });
  }
  document.body.replaceChildren();
});

function host(answer: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport: MobileRemoteTransport = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    authenticatedFetch: async ({ path, body }) => {
      const parsed = JSON.parse(String(body)) as Record<string, unknown>;
      calls.push({ path, body: parsed });
      return Response.json(answer(path, parsed));
    },
  };
  return { transport, calls };
}

async function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        surfaceStyle: "flat",
        children: element,
      }),
    );
  });
  return root;
}

function byTestId(id: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`No element ${id}.`);
  return node;
}

async function press(id: string) {
  await act(async () => {
    byTestId(id).click();
  });
}

async function type(id: string, value: string) {
  const field = byTestId(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the phone's Project terminal", () => {
  it("starts the device's shell, shows its output as plain text, runs a line, and stops it on close", async () => {
    let terminalId = "";
    const { transport, calls } = host((_path, body) => {
      terminalId = String(body.terminalId);
      const terminal = { projectId, terminalId, state: "running", posture: "approval-gated" };
      if (body.kind === "read-output") {
        return {
          kind: "project-terminal",
          terminal,
          output:
            body.afterCharacters === 0
              ? { text: "\u001b[32mready\u001b[0m\r\n$ ", replace: false, characters: 18 }
              : { text: "", replace: false, characters: 18 },
        };
      }
      return { kind: "project-terminal", terminal };
    });
    const root = await render(
      createElement(ProjectTerminalSheet, {
        visible: true,
        onClose: () => undefined,
        transport,
        projectId,
        pollIntervalMs: 60_000,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(calls[0]).toMatchObject({
      path: "/api/code/project-terminals",
      body: { kind: "start", projectId, columns: 60, rows: 30 },
    });
    expect(byTestId("mobile-project-terminal-output").textContent).toBe("ready\n$ ");

    await type("mobile-project-terminal-line", "ls");
    await press("mobile-project-terminal-run");
    expect(calls.find((call) => call.body.kind === "write")?.body).toEqual({
      kind: "write",
      projectId,
      terminalId,
      data: "ls\r",
    });

    await act(async () => {
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          surfaceStyle: "flat",
          children: createElement(ProjectTerminalSheet, {
            visible: false,
            onClose: () => undefined,
            transport,
            projectId,
            pollIntervalMs: 60_000,
          }),
        }),
      );
    });
    expect(calls.at(-1)?.body).toEqual({ kind: "stop", projectId, terminalId });
  });

  it("says why the host refused the shell", async () => {
    const { transport } = host(() => ({
      kind: "project-terminal-refused",
      reason: "unavailable",
      message: "Turn on Developer tools for this Work Project to open its terminal.",
    }));
    await render(
      createElement(ProjectTerminalSheet, {
        visible: true,
        onClose: () => undefined,
        transport,
        projectId,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(byTestId("mobile-project-terminal-refused").textContent).toBe(
      "Turn on Developer tools for this Work Project to open its terminal.",
    );
  });
});

describe("the phone's Private page", () => {
  it("opens a typed address as a Private page and shows what the host sees of it", async () => {
    const { transport, calls } = host((_path, body) =>
      body.kind === "open"
        ? {
            kind: "project-browser",
            browser: {
              projectId,
              mode: "work",
              subjectId: "60000000-0000-4000-8000-000000000001",
              context: {
                contextId: "70000000-0000-4000-8000-000000000001",
                state: "active",
                profile: "private",
              },
              page: { url: "https://example.com/", title: "Example Domain" },
            },
          }
        : {
            kind: "project-browser",
            browser: { projectId, mode: "work", subjectId: "60000000-0000-4000-8000-000000000001" },
          },
    );
    await render(
      createElement(ProjectPageSheet, {
        visible: true,
        onClose: () => undefined,
        transport,
        projectId,
      }),
    );
    expect(calls[0]?.body).toEqual({ kind: "current", projectId });
    await type("mobile-project-page-address", "example.com");
    await press("mobile-project-page-open");
    expect(calls.at(-1)?.body).toEqual({
      kind: "open",
      projectId,
      url: "https://example.com",
      profile: "private",
    });
    expect(byTestId("mobile-project-page-view").textContent).toContain("Example Domain");
  });
});

describe("importing HTML into a Canvas from a Chat thread on the phone", () => {
  it("imports pasted markup and says what was taken out", async () => {
    const authority = {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    };
    const scope = {
      hostId: "local",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
    };
    const shared = {
      schemaVersion: 1,
      canvasId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      versionId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      originThreadId: threadId,
      scope,
      title: "Launch page",
      createdAt: "2026-11-18T10:00:00.000Z",
    };
    const { transport, calls } = host(() => ({
      kind: "imported",
      receipt: {
        ...shared,
        kind: "canvas-create-receipt",
        receiptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        intent: "blank",
        effectiveAuthority: authority,
        outcome: "ready",
      },
      card: {
        ...shared,
        kind: "canvas-reference-card",
        cardId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        status: "ready",
        authority,
        actorId: "11111111-1111-4111-8111-111111111111",
        providerInstanceId: "22222222-2222-4222-8222-222222222222",
        modelId: "octant-test-model",
        actionCount: 0,
      },
      frame: "static",
      dropped: [{ kind: "stylesheet", count: 1, examples: ["cdn.example"] }],
    }));
    await render(
      createElement(CanvasHtmlImportSheet, {
        visible: true,
        onClose: () => undefined,
        transport,
        threadId,
        projectId: undefined,
      }),
    );
    await press("mobile-canvas-import-source-paste");
    await type("mobile-canvas-import-paste", "<p>Hi</p>");
    await type("mobile-canvas-import-title", "Launch page");
    await press("mobile-canvas-import-submit");
    expect(calls[0]).toMatchObject({
      path: "/api/canvas/import-html",
      body: {
        kind: "canvas-html-import",
        mode: "chat",
        workspace: { kind: "chat-virtual", projectId: null },
        originThreadId: threadId,
        source: "paste",
        html: "<p>Hi</p>",
        title: "Launch page",
      },
    });
    const result = byTestId("mobile-canvas-import-result").textContent;
    expect(result).toContain("“Launch page” is ready");
    expect(result).toContain("It is drawn as a static page and runs no script.");
    expect(result).toContain("1 stylesheet (cdn.example)");
  });

  it("shows the host's denial and keeps the draft", async () => {
    const { transport } = host(() => ({
      kind: "denied",
      denialCode: "unauthorized",
      message: "Canvas create is not authorized in this workspace.",
    }));
    await render(
      createElement(CanvasHtmlImportSheet, {
        visible: true,
        onClose: () => undefined,
        transport,
        threadId,
        projectId: undefined,
        pickFile: async () => ({
          status: "picked" as const,
          html: "<p>Hi</p>",
          fileName: "page.html",
        }),
      }),
    );
    await press("mobile-canvas-import-choose");
    await press("mobile-canvas-import-submit");
    expect(byTestId("mobile-canvas-import-problem").textContent).toBe(
      "Canvas create is not authorized in this workspace.",
    );
    expect(document.body.textContent).toContain("page.html");
  });
});
