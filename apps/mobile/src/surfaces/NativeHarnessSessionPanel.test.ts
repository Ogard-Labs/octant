// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeNativeHarnessSessionView, type NativeHarnessSessionView } from "@octant/contracts";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { BiometricAuthenticator } from "../security/BiometricGate";
import { ThemeProvider } from "../../design-system/theme";
import { NativeHarnessSessionPanel } from "./NativeHarnessSessionPanel";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-local-authentication", () => ({}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
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
  readonly outsideContent?: {
    readonly sourceCount: number;
    readonly sources: ReadonlyArray<{
      readonly sourceLabel: string;
      readonly ingestionCount: number;
      readonly firstIngestedAt: string;
      readonly lastIngestedAt: string;
    }>;
  };
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

function confirming(
  outcome: "confirmed" | "denied" | "unavailable" = "confirmed",
): BiometricAuthenticator {
  return {
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => outcome),
  };
}

function pendingLeadApproval() {
  return sessionView({
    id: "00000000-0000-4000-8000-000000000091",
    toolName: "bash",
    summary: "bash: bun run test",
    approvalClass: "shell-commands",
    status: "pending",
    askedAt: "2026-09-05T12:06:00.000Z",
  });
}

function pressChoice(container: ParentNode, label: string) {
  return act(async () => {
    [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent?.trim() === label)
      ?.click();
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
  authenticator: BiometricAuthenticator = confirming(),
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
          authenticator,
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

    expect(approvalChoices(container)).toEqual(["Allow", "Deny", "Allow this session"]);
    expect(container.textContent).toContain("This is waiting for your answer before it runs.");
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
    expect(container.textContent).toContain("This is waiting for your answer before it runs.");
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

  it("shows why a marked thread asks and what marked it before the choices", async () => {
    const container = await renderPanel(
      sessionView({
        id: "00000000-0000-4000-8000-000000000082",
        toolName: "bash",
        summary: "bash: bun run test",
        approvalClass: "shell-commands",
        singleUse: true,
        status: "pending",
        askedAt: "2026-09-05T12:06:00.000Z",
        outsideContent: {
          sourceCount: 3,
          sources: [
            {
              sourceLabel: "web-fetch",
              ingestionCount: 2,
              firstIngestedAt: "2026-09-05T11:00:00.000Z",
              lastIngestedAt: "2026-09-05T11:30:00.000Z",
            },
          ],
        },
      }),
    );

    const note = container.querySelector(
      '[data-testid="mobile-native-harness-approval-outside-content"]',
    );
    expect(note?.textContent).toContain("This thread took in outside content");
    expect(note?.textContent).toContain("Web pages · Read 2 times");
    expect(note?.textContent).toContain("and 2 more sources");
    const choice = [...container.querySelectorAll('[role="button"]')].find(
      (node) => node.textContent?.trim() === "Allow",
    );
    expect(
      note !== null &&
        choice !== undefined &&
        (note.compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  it("shows no outside content note on a clean thread", async () => {
    const container = await renderPanel(
      sessionView({
        id: "00000000-0000-4000-8000-000000000083",
        toolName: "bash",
        summary: "bash: bun run test",
        approvalClass: "shell-commands",
        status: "pending",
        askedAt: "2026-09-05T12:06:00.000Z",
      }),
    );
    expect(container.textContent).not.toContain("outside content");
  });

  it("sends no Allow when the person does not confirm on the phone", async () => {
    const bodies: unknown[] = [];
    const recording: MobileRemoteTransport = {
      hostId: transport.hostId,
      authenticatedFetch: async (request) => {
        bodies.push(request.body);
        return new Response(null, { status: 500 });
      },
    };
    const container = await renderPanel(
      pendingLeadApproval(),
      recording,
      confirming("unavailable"),
    );
    await pressChoice(container, "Allow");
    expect(bodies).toEqual([]);
    expect(container.textContent).toContain(
      "Set up Face ID, Touch ID or a passcode to allow from this phone.",
    );
  });

  it("denies without asking for confirmation", async () => {
    const bodies: unknown[] = [];
    const authenticator = confirming("denied");
    const recording: MobileRemoteTransport = {
      hostId: transport.hostId,
      authenticatedFetch: async (request) => {
        bodies.push(JSON.parse(String(request.body)));
        return new Response(JSON.stringify({ kind: "approval-decided" }), { status: 200 });
      },
    };
    const container = await renderPanel(pendingLeadApproval(), recording, authenticator);
    await pressChoice(container, "Deny");
    expect(bodies).toHaveLength(1);
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it("says the answer could not be sent when the connection fails", async () => {
    const failing: MobileRemoteTransport = {
      hostId: transport.hostId,
      authenticatedFetch: async () => {
        throw new Error("offline");
      },
    };
    const container = await renderPanel(pendingLeadApproval(), failing);
    await pressChoice(container, "Deny");
    expect(container.textContent).toContain(
      "Couldn't send that. Check the connection and try again.",
    );
  });

  it("keeps the pending approval on screen when a later read fails", async () => {
    const container = await renderPanel(pendingLeadApproval());
    vi.mocked(loadMobileNativeHarnessSession).mockRejectedValue(new Error("offline"));
    await pressChoice(container, "Deny");
    expect(approvalChoices(container)).toContain("Allow");
    expect(container.textContent).toContain("Reconnecting…");
  });
});
