// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { ThreadRoutinesPanel } from "./ThreadRoutinesPanel";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const THREAD = "20000000-0000-4000-8000-000000000001";
const PROJECT = "20000000-0000-4000-8000-000000000010";
const roots: Root[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => root?.unmount());
  }
  document.body.replaceChildren();
});

const routine = (paused: boolean) => ({
  id: "30000000-0000-4000-8000-000000000001",
  displayName: "Demo: Workspace Summary",
  hostId: "local",
  mode: "work",
  projectId: PROJECT,
  lifecycle: paused ? "paused" : "enabled",
  definitionRevision: 1,
  trigger: {
    kind: "weekly-local",
    weekdays: [1, 2, 3, 4, 5],
    localTime: "09:00",
    timeZone: "America/Los_Angeles",
  },
  nextDueAt: paused ? null : "2026-11-12T17:00:00.000Z",
  originThreadId: THREAD,
  version: 1,
  updatedAt: "2026-11-11T12:00:00.000Z",
});

async function show(items: ReadonlyArray<unknown>): Promise<string> {
  const [first] = await showPolls([() => Response.json({ kind: "automation-list", items })]);
  return first ?? "";
}

/** Renders the panel and returns its text after each poll, one answer per poll. */
async function showPolls(answers: ReadonlyArray<() => Response>): Promise<ReadonlyArray<string>> {
  let served = 0;
  const transport: MobileRemoteTransport = {
    hostId: "host-1",
    authenticatedFetch: (async () => {
      const answer = answers[Math.min(served, answers.length - 1)];
      served += 1;
      return answer?.() ?? new Response("{}", { status: 500 });
    }) as MobileRemoteTransport["authenticatedFetch"],
  };
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(
        ThemeProvider,
        null,
        createElement(ThreadRoutinesPanel, {
          transport,
          threadId: THREAD,
          mode: "work",
          projectId: PROJECT,
        }),
      ),
    );
  });
  const seen = [host.textContent ?? ""];
  for (let poll = 1; poll < answers.length; poll += 1) {
    // The panel reads again every ten seconds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    seen.push(host.textContent ?? "");
  }
  return seen;
}

describe("the Scheduled panel on the phone", () => {
  it("shows a routine the thread set up with its schedule", async () => {
    const text = await show([routine(false)]);
    expect(text).toContain("Scheduled");
    expect(text).toContain("Demo: Workspace Summary");
    expect(text).toContain("Weekdays at 9:00");
    expect(text).not.toContain("paused");
  });

  it("says a paused routine is paused and where to resume it, with nothing to press", async () => {
    const text = await show([routine(true)]);
    expect(text).toContain("Weekdays at 9:00 · paused");
    expect(text).toContain("Resume it at a window on this computer.");
    expect(document.querySelector("button")).toBeNull();
  });

  it("draws nothing when the thread has no routine", async () => {
    expect(await show([])).toBe("");
  });

  it("keeps what it showed when a later read fails", async () => {
    const list = () => Response.json({ kind: "automation-list", items: [routine(false)] });
    const [first, second] = await showPolls([list, () => new Response("{}", { status: 500 })]);
    expect(first).toContain("Demo: Workspace Summary");
    expect(second).toContain("Demo: Workspace Summary");
  });

  it("shows nothing once the host refuses this phone the read", async () => {
    const list = () => Response.json({ kind: "automation-list", items: [routine(false)] });
    const [first, second] = await showPolls([list, () => new Response("{}", { status: 403 })]);
    expect(first).toContain("Demo: Workspace Summary");
    expect(second).toBe("");
  });
});
