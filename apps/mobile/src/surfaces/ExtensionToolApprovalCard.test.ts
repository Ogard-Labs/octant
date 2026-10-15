// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { ExtensionToolApprovalCard } from "./ExtensionToolApprovalCard";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassChip")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "00000000-0000-4000-8000-000000000020";
const approvalId = "00000000-0000-4000-8000-000000000030";
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

function hostWithOnePrompt(outsideContent?: unknown) {
  const answers: Array<unknown> = [];
  let answered = false;
  const transport: MobileRemoteTransport = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    authenticatedFetch: async ({ body }) => {
      const parsed = JSON.parse(String(body)) as { kind: string };
      if (parsed.kind === "decide") {
        answers.push(parsed);
        answered = true;
        return Response.json({ accepted: true });
      }
      return Response.json(
        answered
          ? []
          : [
              {
                approvalId,
                threadId,
                projectId: "00000000-0000-4000-8000-000000000040",
                extensionId: "00000000-0000-4000-8000-000000000041",
                packageId: "00000000-0000-4000-8000-000000000042",
                componentId: "server",
                serverName: "notes",
                providerToolName: "plugin__notes__search",
                mcpToolName: "search",
                inputJson: '{"q":"plan"}',
                requestedAt: "2026-10-15T06:00:00.000Z",
                rememberable: false,
                ...(outsideContent === undefined ? {} : { outsideContent }),
              },
            ],
      );
    },
  };
  return { transport, answers };
}

function choices(container: ParentNode): readonly string[] {
  return [...container.querySelectorAll('[role="button"]')].map(
    (node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
}

describe("MCP tool prompt on the phone", () => {
  it("offers Approve once and Deny only, and approves the call once", async () => {
    const { transport, answers } = hostWithOnePrompt();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          surfaceStyle: "flat",
          children: createElement(ExtensionToolApprovalCard, {
            transport,
            threadId,
            refreshIntervalMs: 60_000,
          }),
        }),
      );
    });

    expect(container.textContent).toContain("Allow search?");
    expect(container.textContent).toContain('{"q":"plan"}');
    expect(choices(container)).toEqual(["Approve once", "Deny"]);
    expect(
      container.querySelector('[data-testid="mobile-extension-tool-approval"]'),
    ).not.toBeNull();

    const approve = [...container.querySelectorAll('[role="button"]')].find(
      (node) => node.textContent?.trim() === "Approve once",
    );
    await act(async () => {
      (approve as HTMLElement | undefined)?.click();
    });

    expect(answers).toEqual([{ kind: "decide", approvalId, decision: "approved" }]);
    expect(container.querySelector('[data-testid="mobile-extension-tool-approval"]')).toBeNull();
  });

  it("shows why a marked thread asks and what marked it before Approve once", async () => {
    const { transport } = hostWithOnePrompt({
      sourceCount: 2,
      sources: [
        {
          sourceLabel: "web-fetch",
          ingestionCount: 2,
          firstIngestedAt: "2026-10-15T05:00:00.000Z",
          lastIngestedAt: "2026-10-15T05:30:00.000Z",
        },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          surfaceStyle: "flat",
          children: createElement(ExtensionToolApprovalCard, {
            transport,
            threadId,
            refreshIntervalMs: 60_000,
          }),
        }),
      );
    });

    const note = container.querySelector(
      '[data-testid="mobile-native-harness-approval-outside-content"]',
    );
    expect(note?.textContent).toContain("This thread took in outside content");
    expect(note?.textContent).toContain("Web pages · Read 2 times");
    expect(note?.textContent).toContain("and 1 more source");
    const approve = [...container.querySelectorAll('[role="button"]')].find(
      (node) => node.textContent?.trim() === "Approve once",
    );
    expect(
      note !== null &&
        approve !== undefined &&
        (note.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  it("shows no outside content note on a clean thread", async () => {
    const { transport } = hostWithOnePrompt();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          surfaceStyle: "flat",
          children: createElement(ExtensionToolApprovalCard, {
            transport,
            threadId,
            refreshIntervalMs: 60_000,
          }),
        }),
      );
    });
    expect(container.textContent).not.toContain("outside content");
  });
});
