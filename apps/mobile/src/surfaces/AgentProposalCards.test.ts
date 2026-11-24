// @vitest-environment jsdom
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { decodeAutomationTrigger } from "@octant/contracts/automation";
import { routineScheduleLabel } from "@octant/domain";
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

  it("keeps the host's reason where the card was when a confirmed save is not applied, until dismissed", async () => {
    const { transport, answers } = hostHolding(
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
      { kind: "project-memory-proposal-not-applied", message: "Memory moved on." },
    );
    const container = await render(
      createElement(MemoryProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: true,
        authenticator: confirming(),
        refreshIntervalMs: 60_000,
      }),
    );

    await press(container, "Save to memory");

    expect(answers.map((entry) => entry.body)).toEqual([{ proposalId, decision: "confirm" }]);
    expect(container.querySelector('[data-testid="mobile-memory-proposal"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="mobile-memory-proposal-failed"]')?.textContent,
    ).toContain("Not saved: Memory moved on. Nothing was changed.");

    await press(container, "Dismiss");

    expect(container.querySelector('[data-testid="mobile-memory-proposal-failed"]')).toBeNull();
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

  it("keeps the host's reason where the card was when a confirmed routine is not applied, until dismissed", async () => {
    const { transport, answers } = hostHolding(
      "/api/automations/proposals",
      "routine-proposal-list",
      {
        proposalId,
        threadId,
        projectId,
        requestedAt: "2026-11-20T09:00:00.000Z",
        mode: "work",
        displayName: "Morning triage",
        taskPrompt: "Triage new issues.",
        trigger: { kind: "interval", intervalMinutes: 60, anchorAt: "2026-11-20T09:00:00.000Z" },
        missedRunPolicy: "skip",
        firstRunAt: "2026-11-20T10:00:00.000Z",
      },
      {
        kind: "automation-command-failed",
        reason: "invalid",
        message: "A routine with this name already exists.",
      },
    );
    const container = await render(
      createElement(RoutineProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: true,
        authenticator: confirming(),
        refreshIntervalMs: 60_000,
      }),
    );

    await press(container, "Create routine");

    expect(answers.map((entry) => entry.body)).toEqual([{ proposalId, decision: "confirm" }]);
    expect(container.querySelector('[data-testid="mobile-routine-proposal"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="mobile-routine-proposal-failed"]')?.textContent,
    ).toContain("Not saved: A routine with this name already exists. Nothing was changed.");

    await press(container, "Dismiss");

    expect(container.querySelector('[data-testid="mobile-routine-proposal-failed"]')).toBeNull();
  });

  it("keeps the card answerable when the host could not record the answer, until a retry lands", async () => {
    const proposal = {
      proposalId,
      threadId,
      projectId,
      requestedAt: "2026-11-20T09:00:00.000Z",
      mode: "work",
      displayName: "Morning triage",
      taskPrompt: "Triage new issues.",
      trigger: { kind: "interval", intervalMinutes: 60, anchorAt: "2026-11-20T09:00:00.000Z" },
      missedRunPolicy: "skip",
      firstRunAt: "2026-11-20T10:00:00.000Z",
    };
    const answers: Array<{ readonly path: string; readonly body: unknown }> = [];
    const transport: MobileRemoteTransport = {
      hostId: "68000000-0000-4000-8000-0000000000ff",
      authenticatedFetch: async ({ method, path, body }) => {
        if (method === "POST") {
          answers.push({ path, body: JSON.parse(String(body)) });
          return Response.json(
            answers.length === 1
              ? {
                  kind: "routine-proposal-answer-unrecorded",
                  message: "The answer could not be saved; nothing was changed. Try again.",
                }
              : { kind: "routine-proposal-declined" },
          );
        }
        expect(path).toBe("/api/automations/proposals");
        // The host kept the proposal, so it still lists until an answer lands.
        return Response.json({
          kind: "routine-proposal-list",
          proposals: answers.length < 2 ? [proposal] : [],
        });
      },
    };
    const container = await render(
      createElement(RoutineProposalCard, {
        transport,
        threadId,
        actsAsHostPerson: true,
        authenticator: confirming(),
        refreshIntervalMs: 60_000,
      }),
    );

    await press(container, "Create routine");

    expect(
      container.querySelector('[data-testid="mobile-routine-proposal-failed"]')?.textContent,
    ).toContain("The answer could not be saved; nothing was changed. Try again.");
    expect(container.querySelector('[data-testid="mobile-routine-proposal"]')).not.toBeNull();
    expect(choices(container)).toEqual(["Dismiss", "Create routine", "Decline"]);

    await press(container, "Decline");

    expect(answers.map((entry) => entry.body)).toEqual([
      { proposalId, decision: "confirm" },
      { proposalId, decision: "decline" },
    ]);
    expect(container.querySelector('[data-testid="mobile-routine-proposal"]')).toBeNull();
    expect(container.querySelector('[data-testid="mobile-routine-proposal-failed"]')).toBeNull();
  });

  it("names the zone a weekly routine repeats in, and the phone's own when they differ", async () => {
    const firstRunAt = "2026-11-22T20:00:00.000Z";
    const trigger = {
      kind: "weekly-local",
      weekdays: [1],
      localTime: "09:00",
      timeZone: "Pacific/Auckland",
    } as const;
    const { transport } = routineHost({
      mode: "work",
      displayName: "Monday digest",
      taskPrompt: "Summarise the week.",
      trigger,
      missedRunPolicy: "skip",
      firstRunAt,
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

    const shortZone = (timeZone: string | undefined) =>
      new Intl.DateTimeFormat("en-US", {
        ...(timeZone === undefined ? {} : { timeZone }),
        timeZoneName: "short",
      })
        .formatToParts(new Date(firstRunAt))
        .find((part) => part.type === "timeZoneName")?.value;
    expect(container.textContent).toContain(
      `${routineScheduleLabel(decodeAutomationTrigger(trigger))} ${shortZone("Pacific/Auckland")}`,
    );
    expect(container.textContent).toContain(
      `First run ${new Date(firstRunAt).toLocaleString()} ${shortZone(undefined)}`,
    );
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
