// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeNativeHarnessSessionView, type NativeHarnessSessionView } from "@octant/contracts";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { NativeHarnessSessionPanel } from "./NativeHarnessSessionPanel";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassChip")),
}));
vi.mock("@octant/client-runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@octant/client-runtime")>("@octant/client-runtime");
  return {
    ...actual,
    loadMobileNativeHarnessSession: vi.fn(),
  };
});

const { loadMobileNativeHarnessSession } = await import("@octant/client-runtime");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "00000000-0000-4000-8000-000000000020";
const transport: MobileRemoteTransport = {
  hostId: "00000000-0000-4000-8000-0000000000aa",
  authenticatedFetch: async () => new Response(null, { status: 500 }),
};

const roots: Root[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => {
      root?.unmount();
    });
  }
  document.body.replaceChildren();
  vi.mocked(loadMobileNativeHarnessSession).mockReset();
});

function sessionView(approval: {
  readonly id: string;
  readonly toolName: string;
  readonly summary: string;
  readonly approvalClass: string;
  readonly status: "pending";
  readonly askedAt: string;
  readonly singleUse?: boolean;
  readonly commandHosts?: ReadonlyArray<{
    readonly host: string;
    readonly port: number;
    readonly from: "thread-rule" | "project-rule" | "proposal";
    readonly preselected: boolean;
  }>;
  readonly source?: {
    readonly runId: string;
    readonly providerInstanceId: string;
    readonly providerName: string;
    readonly modelId: string;
  };
}): NativeHarnessSessionView {
  return decodeNativeHarnessSessionView({
    session: {
      id: "00000000-0000-4000-8000-000000000010",
      threadId,
      mode: "code",
      leadSlotId: "default",
      lead: {
        hostId: "00000000-0000-4000-8000-0000000000aa",
        providerInstanceId: "00000000-0000-4000-8000-000000000001",
        modelId: "session-lead",
      },
      status: "idle",
      turnsRun: 1,
      cutovers: 0,
      startedAt: "2026-09-05T12:00:00.000Z",
      updatedAt: "2026-09-05T12:05:00.000Z",
      version: 4,
    },
    routes: [],
    turns: [],
    reductions: [],
    interventions: [],
    activatedFollowUpIds: [],
    questions: [],
    approvals: [approval],
  });
}

function approvalChoices(container: ParentNode): readonly string[] {
  return [...container.querySelectorAll('[role="button"]')]
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter((label) => label === "Allow" || label === "Allow this session" || label === "Deny");
}

async function renderPanel(
  view: NativeHarnessSessionView,
  panelTransport: MobileRemoteTransport = transport,
): Promise<HTMLElement> {
  vi.mocked(loadMobileNativeHarnessSession).mockResolvedValue(view);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        surfaceStyle: "flat",
        children: createElement(NativeHarnessSessionPanel, {
          transport: panelTransport,
          threadId,
          refreshIntervalMs: 60_000,
        }),
      }),
    );
  });
  return container;
}

describe("phone harness approvals", () => {
  it("offers Allow and Deny only when a child asks", async () => {
    const container = await renderPanel(
      sessionView({
        id: "00000000-0000-4000-8000-000000000061",
        toolName: "bash",
        summary: "bash: bun run test",
        approvalClass: "shell-commands",
        status: "pending",
        askedAt: "2026-09-05T12:06:00.000Z",
        source: {
          runId: "00000000-0000-4000-8000-000000000062",
          providerInstanceId: "00000000-0000-4000-8000-000000000063",
          providerName: "Workbench",
          modelId: "session-small",
        },
      }),
    );

    expect(approvalChoices(container)).toEqual(["Allow", "Deny"]);
    expect(container.textContent).toContain("Child 00000000 · Workbench · session-small");
    expect(container.textContent).toContain("Allow this request for this child.");
  });

  it("still offers Allow this session for a lead request", async () => {
    const container = await renderPanel(
      sessionView({
        id: "00000000-0000-4000-8000-000000000071",
        toolName: "bash",
        summary: "bash: bun run test",
        approvalClass: "shell-commands",
        status: "pending",
        askedAt: "2026-09-05T12:06:00.000Z",
      }),
    );

    expect(approvalChoices(container)).toEqual(["Allow", "Allow this session", "Deny"]);
    expect(container.textContent).toContain("Needs your say-so (shell-commands).");
  });

  it("offers no session-wide choice after the thread took in outside content", async () => {
    const container = await renderPanel(
      sessionView({
        id: "00000000-0000-4000-8000-000000000081",
        toolName: "bash",
        summary: "bash: bun run test",
        approvalClass: "shell-commands",
        singleUse: true,
        status: "pending",
        askedAt: "2026-09-05T12:06:00.000Z",
      }),
    );

    expect(approvalChoices(container)).toEqual(["Allow", "Deny"]);
    expect(container.textContent).toContain("Needs your say-so (shell-commands).");
  });
  it("lists a marked thread's command hosts and sends only the ones left selected", async () => {
    const bodies: unknown[] = [];
    const recording: MobileRemoteTransport = {
      hostId: transport.hostId,
      authenticatedFetch: async (request) => {
        bodies.push(JSON.parse(String(request.body)));
        return new Response(JSON.stringify({ kind: "approval-refused" }), { status: 409 });
      },
    };
    const container = await renderPanel(
      sessionView({
        id: "00000000-0000-4000-8000-000000000066",
        toolName: "bash",
        summary: "bash: npm install",
        approvalClass: "shell-commands",
        status: "pending",
        askedAt: "2026-09-05T12:06:00.000Z",
        singleUse: true,
        commandHosts: [
          { host: "registry.npmjs.org", port: 443, from: "thread-rule", preselected: true },
          { host: "mirror.example.com", port: 8080, from: "project-rule", preselected: true },
          { host: "cdn.example.com", port: 443, from: "proposal", preselected: false },
        ],
      }),
      recording,
    );
    const hosts = container.querySelector('[data-testid="mobile-native-harness-command-hosts"]');
    const chip = (label: string) =>
      [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(
        (node) => node.textContent?.trim() === label,
      );
    expect(hosts?.textContent).toContain("mirror.example.com:8080");
    await act(async () => chip("mirror.example.com:8080")?.click());
    await act(async () => chip("cdn.example.com")?.click());
    await act(async () => chip("Allow")?.click());

    expect(bodies).toEqual([
      {
        approvalId: "00000000-0000-4000-8000-000000000066",
        decision: "approve",
        commandHosts: [
          { host: "registry.npmjs.org", port: 443 },
          { host: "cdn.example.com", port: 443 },
        ],
      },
    ]);
  });
});
