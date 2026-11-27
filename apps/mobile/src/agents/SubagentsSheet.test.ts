// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileProviderDirectoryEntry, MobileSubagent } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { SubagentsPill, SubagentsSheet } from "./SubagentsSheet";

vi.mock("react-native", async () => {
  const web = await vi.importActual<Record<string, unknown>>("react-native-web");
  return {
    ...web,
    // The person confirms whatever the alert asks.
    Alert: {
      alert: (
        _title: string,
        _body: string,
        buttons: ReadonlyArray<{ style?: string; onPress?: () => void }>,
      ) => buttons.find((button) => button.style === "destructive")?.onPress?.(),
    },
  };
});
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../ui/ComposerSurface", () => ({
  ComposerSurface: (props: { readonly children: ReactNode }) => props.children,
}));
vi.mock("../ui/BottomSheet", () => ({
  BottomSheet: (props: { readonly visible: boolean; readonly children: ReactNode }) =>
    props.visible ? props.children : null,
}));
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

function show(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(ThemeProvider, null, node)));
  return host;
}

function press(host: HTMLElement, testID: string) {
  const target = host.querySelector(`[data-testid="${testID}"]`);
  if (target === null) throw new Error(`${testID} is not on screen`);
  act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const directory: ReadonlyArray<MobileProviderDirectoryEntry> = [
  {
    providerInstanceId: "p1",
    displayName: "Claude",
    driverKind: "claude",
    models: [{ modelId: "opus", displayName: "Opus 5.5" }],
  },
];

const finished: MobileSubagent = {
  id: "run-1",
  origin: "octant-started",
  task: "Condense group A areas",
  status: "completed",
  providerInstanceId: "p1",
  modelId: "opus",
  effort: "medium",
  latest: "Group A is done.",
  result: "Group A is done.\nAll 44 entries kept.",
  startedAt: "2026-11-26T08:00:00.000Z",
  updatedAt: "2026-11-26T08:08:42.000Z",
  stoppable: false,
};
const working: MobileSubagent = {
  id: "obs-1",
  origin: "provider-started",
  task: "Find every caller",
  status: "running",
  providerInstanceId: "p1",
  latest: "Reading ProjectToolSheets.tsx",
  updatedAt: "2026-11-26T08:09:00.000Z",
  stoppable: true,
};

describe("a thread's subagents on the phone", () => {
  it("counts them over the composer, and shows nothing for a thread without any", () => {
    expect(
      show(
        createElement(SubagentsPill, {
          subagents: [finished, working, { ...finished, id: "run-2", status: "failed" }],
          liveTasks: [{ taskId: "t1" }],
          onPress: () => undefined,
        }),
      ).textContent,
    ).toBe("1 running · 1 failed · 1 done · 1 background task");
    expect(
      show(createElement(SubagentsPill, { subagents: [], liveTasks: [], onPress: () => undefined }))
        .textContent,
    ).toBe("");
  });

  it("lists the one at work first, with its status, run time, model and latest line", () => {
    const text =
      show(
        createElement(SubagentsSheet, {
          visible: true,
          onClose: () => undefined,
          subagents: [finished, working],
          liveTasks: [],
          providerDirectory: directory,
        }),
      ).textContent ?? "";
    expect(text.indexOf("Find every caller")).toBeLessThan(text.indexOf("Condense group A"));
    expect(text).toContain("Condense group A areas8m 42sCompleted · Claude · Opus 5.5 · Medium");
    expect(text).toContain("Group A is done.");
  });

  it("opens a subagent's reply, and stops one at work only after the person confirms", async () => {
    const stopped: string[] = [];
    const host = show(
      createElement(SubagentsSheet, {
        visible: true,
        onClose: () => undefined,
        subagents: [finished, working],
        liveTasks: [],
        providerDirectory: directory,
        onStop: async (subagent: MobileSubagent) => {
          stopped.push(subagent.id);
          return "This subagent already finished.";
        },
      }),
    );
    press(host, "mobile-subagent-run-1");
    expect(host.textContent).toContain("All 44 entries kept.");
    expect(host.querySelector('[data-testid="mobile-subagent-stop"]')).toBeNull();
    press(host, "mobile-subagent-back");
    press(host, "mobile-subagent-obs-1");
    press(host, "mobile-subagent-stop");
    await act(async () => undefined);
    expect(stopped).toEqual(["obs-1"]);
    expect(host.textContent).toContain("This subagent already finished.");
  });
});
