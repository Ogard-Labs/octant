// @vitest-environment jsdom
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { BiometricAuthenticator } from "../security/BiometricGate";
import { ThemeProvider } from "../../design-system/theme";
import { MemoryProposalCard, RoutineProposalCard } from "./AgentProposalCards";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-local-authentication", () => ({}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassChip")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "68000000-0000-4000-8000-000000000001";
const projectId = "68000000-0000-4000-8000-0000000000aa";
const proposalId = "68000000-0000-4000-8000-000000000010";
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

/** A host holding one proposal until it is answered, recording each answer. */
function hostHolding(listPath: string, listKind: string, proposal: unknown, answer: unknown) {
  const answers: Array<{ readonly path: string; readonly body: unknown }> = [];
  const transport: MobileRemoteTransport = {
    hostId: "68000000-0000-4000-8000-0000000000ff",
    authenticatedFetch: async ({ method, path, body }) => {
      if (method === "POST") {
        answers.push({ path, body: JSON.parse(String(body)) });
        return Response.json(answer);
      }
      expect(path).toBe(listPath);
      return Response.json({ kind: listKind, proposals: answers.length > 0 ? [] : [proposal] });
    },
  };
  return { transport, answers };
}

function memoryHost() {
  return hostHolding(
    "/api/projects/memory/proposals",
    "project-memory-proposal-list",
    {
      proposalId,
      projectId,
      mode: "work",
      threadId,
      change: { kind: "create", memoryKind: "decision", content: "Ship on Tuesdays." },
      expectedVersion: 2,
      requestedAt: "2026-11-20T09:00:00.000Z",
    },
    { kind: "project-memory-proposal-declined" },
  );
}

function routineHost(proposal: Record<string, unknown>) {
  return hostHolding(
    "/api/automations/proposals",
    "routine-proposal-list",
    { proposalId, threadId, projectId, requestedAt: "2026-11-20T09:00:00.000Z", ...proposal },
    { kind: "routine-proposal-declined" },
  );
}

function confirming(): BiometricAuthenticator {
  return {
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => "confirmed" as const),
  };
}

async function render(element: ReactElement): Promise<HTMLElement> {
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
  return container;
}

function choices(container: ParentNode): readonly string[] {
  return [...container.querySelectorAll('[role="button"]')].map(
    (node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
}

async function press(container: ParentNode, label: string): Promise<void> {
  const button = [...container.querySelectorAll('[role="button"]')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    (button as HTMLElement | undefined)?.click();
  });
}

describe("Project memory proposal on the phone", () => {
  it("shows exactly what would be written and declines on the host's memory route, then withdraws", async () => {
    const { transport, answers } = memoryHost();
    const container = await render(
      createElement(MemoryProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: true,
        authenticator: confirming(),
        refreshIntervalMs: 60_000,
      }),
    );

    expect(container.textContent).toContain("Save a decision to Project memory?");
    expect(container.textContent).toContain("Ship on Tuesdays.");
    expect(container.textContent).toContain("Every later thread in this Project starts with this");
    expect(choices(container)).toEqual(["Save to memory", "Decline"]);

    await press(container, "Decline");

    expect(answers).toEqual([
      {
        path: "/api/projects/memory/proposals/decide",
        body: { proposalId, decision: "decline" },
      },
    ]);
    expect(container.querySelector('[data-testid="mobile-memory-proposal"]')).toBeNull();
  });

  it("confirms on this phone before it saves the change", async () => {
    const { transport, answers } = memoryHost();
    const authenticator = confirming();
    const container = await render(
      createElement(MemoryProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: true,
        authenticator,
        refreshIntervalMs: 60_000,
      }),
    );

    await press(container, "Save to memory");

    expect(authenticator.authenticate).toHaveBeenCalled();
    expect(answers.map((entry) => entry.body)).toEqual([{ proposalId, decision: "confirm" }]);
    expect(container.querySelector('[data-testid="mobile-memory-proposal"]')).toBeNull();
  });

  it("tells a session the host would not take an answer from to answer on the computer", async () => {
    const { transport } = memoryHost();
    const container = await render(
      createElement(MemoryProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: false,
        refreshIntervalMs: 60_000,
      }),
    );

    expect(container.textContent).toContain("Ship on Tuesdays.");
    expect(container.textContent).toContain("Answer this on the computer.");
    expect(choices(container)).toEqual([]);
  });
});

describe("Routine proposal on the phone", () => {
  it("says what would run and when, and creates the routine on the host's routine route", async () => {
    const { transport, answers } = routineHost({
      mode: "work",
      displayName: "Morning triage",
      taskPrompt: "Triage new issues.",
      trigger: { kind: "interval", intervalMinutes: 60, anchorAt: "2026-11-20T09:00:00.000Z" },
      missedRunPolicy: "skip",
      firstRunAt: "2026-11-20T10:00:00.000Z",
    });
    const container = await render(
      createElement(RoutineProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: true,
        authenticator: confirming(),
        refreshIntervalMs: 60_000,
      }),
    );

    expect(container.textContent).toContain("Morning triage");
    expect(container.textContent).toContain("Triage new issues.");
    expect(container.textContent).toContain("Every hour");
    expect(choices(container)).toEqual(["Create routine", "Decline"]);

    await press(container, "Create routine");

    expect(answers).toEqual([
      {
        path: "/api/automations/proposals/decide",
        body: { proposalId, decision: "confirm" },
      },
    ]);
    expect(container.querySelector('[data-testid="mobile-routine-proposal"]')).toBeNull();
  });

  it("asks before pausing a routine and keeps it when the person declines", async () => {
    const { transport, answers } = routineHost({
      kind: "routine-change-request",
      mode: "code",
      automationId: "68000000-0000-4000-8000-000000000030",
      change: "pause",
      displayName: "Nightly build",
      expectedVersion: 4,
      reason: "The build is red until the fix lands.",
    });
    const container = await render(
      createElement(RoutineProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: true,
        authenticator: confirming(),
        refreshIntervalMs: 60_000,
      }),
    );

    expect(container.textContent).toContain("Nightly build");
    expect(container.textContent).toContain("The build is red until the fix lands.");
    expect(choices(container)).toEqual(["Pause routine", "Keep it"]);

    await press(container, "Keep it");

    expect(answers.map((entry) => entry.body)).toEqual([{ proposalId, decision: "decline" }]);
    expect(container.querySelector('[data-testid="mobile-routine-proposal"]')).toBeNull();
  });
});
