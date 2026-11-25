// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { BiometricAuthenticator } from "../security/BiometricGate";
import { ThemeProvider } from "../../design-system/theme";
import { AccessActivityPanel } from "./AccessActivityPanel";

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

const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
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

const raised = {
  kind: "thread-level-raised",
  noticeId: id(11),
  at: new Date().toISOString(),
  actor: { kind: "device", deviceId: id(1), label: "Ada's laptop" },
  surface: "code",
  threadId: "thread-1",
  threadTitle: "Fix login",
  from: "ask-first",
  to: "full-access",
};
const replaced = {
  kind: "provider-key-replaced",
  noticeId: id(12),
  at: new Date().toISOString(),
  actor: { kind: "agent", grantId: id(2), name: "Release bot" },
  providerInstanceId: id(3),
  providerName: "Anthropic",
};
const added = {
  kind: "added",
  entryId: id(21),
  at: new Date().toISOString(),
  deviceId: id(1),
  deviceLabel: "Ada's laptop",
  accessLevel: "full",
  actor: { kind: "local-person" },
};

function host(options: {
  notices?: ReadonlyArray<unknown>;
  entries?: ReadonlyArray<unknown>;
  failReads?: boolean;
  actionStatus?: number;
}) {
  const sent: Array<{ path: string; body: unknown }> = [];
  const transport: MobileRemoteTransport = {
    hostId: "host-1",
    authenticatedFetch: async ({ method, path, body }) => {
      if (method === "POST") {
        sent.push({ path, body: JSON.parse(String(body)) });
        return options.actionStatus === undefined || options.actionStatus === 200
          ? Response.json({})
          : Response.json(
              { message: "That thread changed again." },
              { status: options.actionStatus },
            );
      }
      if (options.failReads === true) return new Response("no", { status: 403 });
      return Response.json(
        path === "/api/access-activity"
          ? { entries: options.entries ?? [] }
          : { notices: options.notices ?? [] },
      );
    },
  };
  return { transport, sent };
}

function confirming(): BiometricAuthenticator {
  return {
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => "confirmed" as const),
  };
}

async function mount(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(AccessActivityPanel, {
          refreshIntervalMs: 60_000,
          ...props,
        } as never),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

const press = async (container: ParentNode, testId: string) => {
  const node = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  expect(node).not.toBeNull();
  await act(async () => {
    node?.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

describe("access activity on the phone", () => {
  it("shows nothing, and reads nothing, for a session that is not the host's person", async () => {
    const { transport, sent } = host({ notices: [raised] });
    const spy = vi.spyOn(transport, "authenticatedFetch");
    const container = await mount({ transport, actsAsHostPerson: false });
    expect(container.querySelector('[data-testid="mobile-access-activity"]')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("says plainly that nothing has been recorded", async () => {
    const { transport } = host({});
    const container = await mount({ transport, actsAsHostPerson: true });
    expect(container.textContent).toContain("No devices added, removed or re-levelled yet");
  });

  it("lists who changed access, newest first as the host sends it", async () => {
    const { transport } = host({ entries: [added] });
    const container = await mount({ transport, actsAsHostPerson: true });
    expect(container.textContent).toContain("Ada's laptop added at Full");
    expect(container.textContent).toContain("By you on this computer");
  });

  it("offers Undo, Revoke and Dismiss on a raised level and sends Undo and Dismiss as pressed", async () => {
    const { transport, sent } = host({ notices: [raised] });
    const container = await mount({ transport, actsAsHostPerson: true });
    expect(container.textContent).toContain(
      "Ada's laptop raised “Fix login” from Ask first to Full access",
    );
    const labels = [...container.querySelectorAll('[role="button"]')].map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "Undo: Ada's laptop raised “Fix login” from Ask first to Full access",
      "Revoke Ada's laptop",
      "Dismiss: Ada's laptop raised “Fix login” from Ask first to Full access",
    ]);
    await press(container, "mobile-change-notice-undo");
    await press(container, "mobile-change-notice-dismiss");
    expect(sent).toEqual([
      { path: "/api/change-notices/undo", body: { noticeId: id(11) } },
      { path: "/api/change-notices/dismiss", body: { noticeId: id(11) } },
    ]);
  });

  it("gives a replaced key no Undo and says the earlier key is not kept", async () => {
    const { transport } = host({ notices: [replaced] });
    const container = await mount({ transport, actsAsHostPerson: true });
    expect(container.querySelector('[data-testid="mobile-change-notice-undo"]')).toBeNull();
    expect(container.textContent).toContain("No Undo: the earlier key is not kept.");
    expect(container.textContent).toContain("End Release bot's access");
  });

  it("asks before revoking, then confirms on the phone, and sends nothing when the person keeps it", async () => {
    const { transport, sent } = host({ notices: [raised] });
    const authenticator = confirming();
    const container = await mount({ transport, actsAsHostPerson: true, authenticator });
    await press(container, "mobile-change-notice-revoke");
    expect(container.textContent).toContain("Revoke Ada's laptop?");
    expect(container.textContent).toContain("must pair again to return");
    expect(sent).toEqual([]);
    await press(container, "mobile-change-notice-revoke-cancel");
    expect(sent).toEqual([]);
    await press(container, "mobile-change-notice-revoke");
    await press(container, "mobile-change-notice-revoke-confirm");
    expect(authenticator.authenticate).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ path: "/api/change-notices/revoke", body: { noticeId: id(11) } }]);
  });

  it("does not revoke when the phone's confirmation is denied", async () => {
    const { transport, sent } = host({ notices: [raised] });
    const authenticator: BiometricAuthenticator = {
      hasDeviceCredential: vi.fn(async () => true),
      authenticate: vi.fn(async () => "denied" as const),
    };
    const container = await mount({ transport, actsAsHostPerson: true, authenticator });
    await press(container, "mobile-change-notice-revoke");
    await press(container, "mobile-change-notice-revoke-confirm");
    expect(sent).toEqual([]);
    expect(container.querySelector('[data-testid="mobile-access-refusal"]')).not.toBeNull();
  });

  it("shows the host's reason when it refuses an action", async () => {
    const { transport } = host({ notices: [raised], actionStatus: 409 });
    const container = await mount({ transport, actsAsHostPerson: true });
    await press(container, "mobile-change-notice-undo");
    expect(container.querySelector('[data-testid="mobile-access-refusal"]')?.textContent).toBe(
      "That thread changed again.",
    );
  });

  it("says it could not read when the host answers neither list", async () => {
    const { transport } = host({ failReads: true });
    const container = await mount({ transport, actsAsHostPerson: true });
    expect(
      container.querySelector('[data-testid="mobile-access-activity-error"]')?.textContent,
    ).toBe("Access activity could not be read.");
  });
});
