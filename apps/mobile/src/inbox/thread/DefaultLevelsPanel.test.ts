// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../../design-system/theme";
import { DefaultLevelsPanel, type DefaultLevelsPanelProps } from "./DefaultLevelsPanel";
vi.mock("react-native", () => vi.importActual("react-native-web"));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const projectId = "10000000-0000-4000-8000-000000000001";
const at = "2026-11-12T10:00:00.000Z";
const codeProject = {
  id: projectId,
  type: "code",
  name: "Octant",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 4,
  createdAt: at,
  updatedAt: at,
  binding: { canonicalRoot: "/repo" },
  bindingRevisionId: "60000000-0000-4000-8000-000000000001",
  codeAccessPersistence: "current-session",
  defaultPermissionMode: "ask-first",
};
const codeSettings = {
  version: 9,
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  defaultAutoApprove: true,
  updatedAt: at,
};

function host(hostId: string) {
  const sent: Array<{ readonly path: string; readonly body: unknown }> = [];
  const read: string[] = [];
  const transport: MobileRemoteTransport = {
    hostId,
    authenticatedFetch: async (input) => {
      if (input.method === "GET") {
        read.push(input.path);
        return new Response(
          JSON.stringify(
            input.path === "/api/projects/bootstrap"
              ? { active: [codeProject], archived: [], availability: [], memory: [] }
              : { settings: codeSettings, threads: [], checkouts: [] },
          ),
        );
      }
      sent.push({ path: input.path, body: JSON.parse(String(input.body)) });
      return new Response(
        JSON.stringify({
          kind:
            input.path === "/api/projects/commands"
              ? "code-project-access-changed"
              : "settings-updated",
        }),
      );
    },
  };
  return { sent, read, transport };
}

function mount(props: DefaultLevelsPanelProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(DefaultLevelsPanel, props),
      }),
    ),
  );
}
function within(testId: string, label: string) {
  const section = document.querySelector(`[data-testid=${testId}]`);
  return [...(section?.querySelectorAll<HTMLElement>("[role=button]") ?? [])].filter(
    (element) => element.textContent === label,
  );
}
async function press(button: HTMLElement | undefined) {
  if (button === undefined) throw new Error("Missing button");
  await act(async () => button.click());
  await act(async () => {});
}
async function open() {
  await press(
    [...document.querySelectorAll<HTMLElement>("[role=button]")].find(
      (element) => element.textContent === "Project and default modes",
    ),
  );
}

describe("Project and default modes on a phone the host's own person paired", () => {
  it("sets the thread's Project to Full access after the warning, with no owner unlock", async () => {
    const { transport, sent } = host("levels-a");
    mount({ actsAsHostPerson: true, mode: "code", projectId, transport });
    await open();

    expect(document.body.textContent).toContain("Octant: Ask first");
    expect(document.body.textContent).toContain("New threads on this host: Auto");
    await press(within("mobile-project-level", "Full access")[0]);
    expect(sent).toEqual([]);
    expect(document.body.textContent).toContain("with no sandbox");
    expect(document.body.textContent).not.toMatch(/unlock/i);
    await press(within("mobile-project-level", "Use Full access")[0]);

    expect(sent).toEqual([
      {
        path: "/api/projects/commands",
        body: expect.objectContaining({
          kind: "change-code-project-permission-mode",
          permissionMode: "full-access",
          expectedVersion: 4,
        }),
      },
    ]);
  });

  it("sets the host default to Full access with the Code settings command", async () => {
    const { transport, sent, read } = host("levels-b");
    mount({ actsAsHostPerson: true, mode: "code", projectId, transport });
    await open();
    const readsBefore = read.length;

    await press(within("mobile-default-level", "Full access")[0]);
    await press(within("mobile-default-level", "Use Full access")[0]);

    expect(sent).toEqual([
      {
        path: "/api/code/commands",
        body: expect.objectContaining({
          kind: "update-code-settings",
          defaultExecutionPolicy: "full-access",
          expectedVersion: 9,
        }),
      },
    ]);
    // The version moved, so the next pick must be sent against a fresh read.
    expect(read.length).toBeGreaterThan(readsBefore);
  });

  it("shows a restricted session nothing to set a Project or default mode with", () => {
    const { transport, read } = host("levels-c");
    mount({ actsAsHostPerson: false, mode: "code", projectId, transport });

    expect(document.querySelectorAll("[role=button]")).toHaveLength(0);
    expect(read).toEqual([]);
  });
});
