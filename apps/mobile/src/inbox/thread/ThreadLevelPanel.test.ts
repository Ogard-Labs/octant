// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../../design-system/theme";
import { ThreadLevelPanel, type ThreadLevelPanelProps } from "./ThreadLevelPanel";
vi.mock("react-native", () => vi.importActual("react-native-web"));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
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

function mount(props: ThreadLevelPanelProps) {
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
async function press(label: string) {
  const button = buttons(label)[0];
  if (button === undefined) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
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
    expect(document.body.textContent).toContain("with no sandbox");
    expect(document.body.textContent).not.toMatch(/unlock/i);
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
