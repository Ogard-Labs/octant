// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../../design-system/theme";
import { createInMemoryMobileHostRegistryStorage } from "../../hosts/HostRegistry";
import { createFullAccessWarningStore } from "../../hosts/fullAccessWarningStore";
import { ThreadLevelPanel, type ThreadLevelPanelProps } from "./ThreadLevelPanel";
interface ShownAlert {
  readonly title: string;
  readonly message: string;
  readonly buttons: ReadonlyArray<{ readonly text: string; readonly onPress?: () => void }>;
}
// The browser build shows no system alert, so the test answers it as a person would.
const alerts = vi.hoisted(() => ({ shown: [] as ShownAlert[] }));
vi.mock("react-native", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("react-native-web")),
  Alert: {
    alert: (title: string, message: string, buttons: ShownAlert["buttons"]) =>
      void alerts.shown.push({ title, message, buttons }),
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  alerts.shown.length = 0;
});

const codeThread = {
  id: "50000000-0000-4000-8000-000000000001",
  version: 6,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
} as const;

function host(hostId: string, status = 200) {
  const sent: unknown[] = [];
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: async (input) => {
      sent.push(JSON.parse(String(input.body)));
      return new Response(JSON.stringify({ kind: "thread-updated" }), { status });
    },
  };
  return { sent, transport };
}

function mount(input: Omit<ThreadLevelPanelProps, "warnings"> & Partial<ThreadLevelPanelProps>) {
  const props: ThreadLevelPanelProps = {
    warnings: createFullAccessWarningStore(createInMemoryMobileHostRegistryStorage()),
    ...input,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(ThreadLevelPanel, props),
      }),
    ),
  );
}
function buttons(label: string) {
  return [...document.querySelectorAll<HTMLElement>("[role=button]")].filter(
    (element) => element.textContent === label,
  );
}
/** What the open system alert says, if one is open. */
const alertText = () => {
  const shown = alerts.shown.at(-1);
  return shown === undefined ? "" : `${shown.title} ${shown.message}`;
};
async function press(label: string) {
  const button = buttons(label)[0];
  const inAlert = alerts.shown.at(-1)?.buttons.find((entry) => entry.text === label);
  if (button === undefined && inAlert === undefined) throw new Error(`Missing button ${label}`);
  if (button === undefined) alerts.shown.pop();
  await act(async () => (button === undefined ? inAlert?.onPress?.() : button.click()));
  await act(async () => {});
}

describe("a thread's mode on a phone the host's own person paired", () => {
  it("sets Full access after the warning, straight to the host with no owner unlock", async () => {
    const { transport, sent } = host("host-a");
    const onChanged = vi.fn();
    mount({
      actsAsHostPerson: true,
      subject: { mode: "code", thread: codeThread as never },
      transport,
      onChanged,
    });

    expect(document.body.textContent).toContain("Mode: Ask first");
    await press("Full access");
    expect(sent).toEqual([]);
    expect(alertText()).toContain("with no sandbox");
    expect(alertText()).not.toMatch(/unlock/i);
    await press("Use Full access");

    expect(sent).toEqual([
      expect.objectContaining({
        kind: "change-code-thread-access",
        executionPolicy: "full-access",
        expectedVersion: 6,
      }),
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("sends nothing and keeps warning when the person cancels the Full access warning", async () => {
    const { transport, sent } = host("host-f");
    const warnings = createFullAccessWarningStore(createInMemoryMobileHostRegistryStorage());
    mount({
      actsAsHostPerson: true,
      subject: { mode: "code", thread: codeThread as never },
      transport,
      warnings,
      onChanged: vi.fn(),
    });

    await press("Full access");
    await press("Cancel");
    expect(sent).toEqual([]);
    expect(await warnings.acknowledged("host-f")).toBe(false);
  });

  it("changes to any other mode at once, and says so when the host refuses", async () => {
    const { transport, sent } = host("host-b", 403);
    const onChanged = vi.fn();
    mount({
      actsAsHostPerson: true,
      subject: { mode: "code", thread: codeThread as never },
      transport,
      onChanged,
    });

    await press("Plan");
    expect(sent).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("The host did not change this thread's mode.");
  });

  it("offers a Work thread Plan and sends it as the Work level change", async () => {
    const { transport, sent } = host("host-w");
    const onChanged = vi.fn();
    mount({
      actsAsHostPerson: true,
      subject: {
        mode: "work",
        thread: { id: "20000000-0000-4000-8000-000000000001", version: 3, access: "auto" } as never,
      },
      transport,
      onChanged,
    });

    await press("Plan");
    expect(sent).toEqual([
      expect.objectContaining({ kind: "change-work-thread-access", access: "plan" }),
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the Full access warning once ever per host, not again after the app restarts", async () => {
    const storage = createInMemoryMobileHostRegistryStorage();
    const first = host("host-d");
    mount({
      actsAsHostPerson: true,
      subject: { mode: "code", thread: codeThread as never },
      transport: first.transport,
      warnings: createFullAccessWarningStore(storage),
      onChanged: vi.fn(),
    });
    await press("Full access");
    await press("Use Full access");
    expect(first.sent).toHaveLength(1);
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();

    // A restart builds a new store over what the phone kept.
    const restarted = createFullAccessWarningStore(storage);
    expect(await restarted.acknowledged("host-d")).toBe(true);
    const again = host("host-d");
    mount({
      actsAsHostPerson: true,
      subject: { mode: "code", thread: codeThread as never },
      transport: again.transport,
      warnings: restarted,
      onChanged: vi.fn(),
    });
    await press("Full access");
    expect(alertText()).toBe("");
    expect(again.sent).toHaveLength(1);
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();

    // Another host has not had its warning.
    const other = host("host-e");
    mount({
      actsAsHostPerson: true,
      subject: { mode: "code", thread: codeThread as never },
      transport: other.transport,
      warnings: restarted,
      onChanged: vi.fn(),
    });
    await press("Full access");
    expect(alertText()).toContain("with no sandbox");
    expect(other.sent).toEqual([]);
  });

  it("shows a restricted session nothing to set a mode with", () => {
    const { transport } = host("host-c");
    mount({
      actsAsHostPerson: false,
      subject: { mode: "code", thread: codeThread as never },
      transport,
      onChanged: vi.fn(),
    });

    expect(buttons("Full access")).toHaveLength(0);
    expect(document.querySelectorAll("[role=button]")).toHaveLength(0);
  });
});
