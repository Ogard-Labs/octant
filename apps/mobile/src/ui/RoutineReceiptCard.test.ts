// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRoutineReceipt } from "@octant/contracts";
import { ThemeProvider } from "../../design-system/theme";
import { RoutineReceiptCard } from "./RoutineReceiptCard";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => root?.unmount());
  }
  document.body.replaceChildren();
});

const receipt = (paused: boolean): ThreadRoutineReceipt =>
  ({
    routineId: "20000000-0000-4000-8000-0000000000a1",
    name: "Demo: Workspace Summary",
    trigger: {
      kind: "weekly-local",
      weekdays: [1, 2, 3, 4, 5],
      localTime: "09:00",
      timeZone: "America/Los_Angeles",
    },
    firstRunAt: "2026-11-12T17:00:00.000Z",
    paused,
  }) as never;

function show(routine: ThreadRoutineReceipt): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(createElement(ThemeProvider, null, createElement(RoutineReceiptCard, { routine }))),
  );
  return host.textContent ?? "";
}

describe("the Created automation card on the phone", () => {
  it("names the routine and its schedule the way the desktop card does, and says it was created paused", () => {
    expect(show(receipt(true))).toBe(
      "Created automationDemo: Workspace SummaryWeekdays at 9:00 · created paused",
    );
  });

  it("does not say paused for a routine the person confirmed", () => {
    const text = show(receipt(false));
    expect(text).toContain("Weekdays at 9:00");
    expect(text).not.toContain("paused");
  });
});
