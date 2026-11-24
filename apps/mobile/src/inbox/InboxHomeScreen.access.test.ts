// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import { expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import { AgentsListScreen } from "./AgentsListScreen";
import { InboxHomeScreen } from "./InboxHomeScreen";

const { listInbox, createChat, createWork, createCode } = vi.hoisted(() => ({
  listInbox: vi.fn(),
  createChat: vi.fn(),
  createWork: vi.fn(),
  createCode: vi.fn(),
}));
vi.mock("@octant/client-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octant/client-runtime")>()),
  listAllHostsMobileInbox: listInbox,
  fetchMobileWorkProjects: async () => [],
  fetchMobileCodeProjects: async () => [],
  createMobileChatWithFirstTurn: createChat,
  createMobileWorkFromPrompt: createWork,
  createMobileCodeFromPrompt: createCode,
}));
vi.mock("react-native", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("react-native-web")),
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassSurface")),
}));
vi.mock("../session/MobileSessionContext", () => ({ useMobileSession: () => session }));
vi.mock("../session/usePlacementHostModels", () => ({
  usePlacementHostModels: () => ({ options: [] }),
}));
vi.mock("../voice/useVoiceDictation", () => ({ useVoiceDictation: () => undefined }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __DEV__: true });

const hostA = "11111111-1111-4111-8111-111111111111";
const hostB = "22222222-2222-4222-8222-222222222222";
const standing = {
  deviceId: "33333333-3333-4333-8333-333333333333",
  deviceLabel: "Phone",
  origin: "https://mac.example.test",
  credentialGeneration: 1,
  createdAt: "2026-11-23T00:00:00.000Z",
  expiresAt: "2026-12-23T00:00:00.000Z",
  lastSeenAt: "2026-11-23T07:00:00.000Z",
  state: "active",
  actsAsHostPerson: true,
};
const permitted: MobileRemoteTransport = {
  hostId: hostA,
  authenticatedFetch: vi.fn(async () => Response.json({ ...standing, accessLevel: "full" })),
};
const watching: MobileRemoteTransport = {
  hostId: hostB,
  authenticatedFetch: vi.fn(async () =>
    Response.json({ ...standing, actsAsHostPerson: false, accessLevel: "read-only" }),
  ),
};
const hosts = [
  { hostId: hostA, label: "Studio" },
  { hostId: hostB, label: "Laptop" },
];
const session = {
  environment: { kind: "live" },
  hosts,
  hostsLoaded: true,
  health: hosts.map((host) => ({ ...host, kind: "ready" })),
  placementHostId: hostA,
  inboxHostFilter: "all",
  setInboxHostFilter: vi.fn(),
  refreshHosts: vi.fn(),
  transport: permitted,
  transports: [permitted, watching],
  transportForHost: (id: string) => session.transports.find((transport) => transport.hostId === id),
};

const existing: MobileInboxRow = {
  hostId: hostB,
  mode: "work",
  threadId: "44444444-4444-4444-8444-444444444444",
  title: "Existing thread",
  status: "active",
  freshness: "2026-11-23T07:00:00.000Z",
};

it("keeps existing threads openable while the placement host refuses new threads", async () => {
  const opened = vi.fn();
  const noop = () => undefined;
  const home = (homeMode: "inbox" | "work" | "code") =>
    createElement(InboxHomeScreen, {
      homeMode,
      arrangement: "status",
      onOpenThread: opened,
      onOpenAgents: noop,
      onSelectArrangement: noop,
      onOpenWorkspace: noop,
      onAddWorkspace: noop,
      onScanToPair: noop,
    });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (screen: ReturnType<typeof createElement>) =>
    act(async () =>
      root.render(createElement(ThemeProvider, { preference: "light", children: screen })),
    );
  const element = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  listInbox.mockResolvedValue({ rows: [existing], failures: [] });
  try {
    await render(home("work"));
    expect(element("mobile-composer-input")?.getAttribute("readonly")).toBeNull();

    const reading = Promise.withResolvers<Response>();
    vi.mocked(watching.authenticatedFetch).mockImplementationOnce(() => reading.promise);
    session.placementHostId = hostB;
    await render(home("work"));
    expect(element("mobile-composer-input")?.hasAttribute("readonly")).toBe(true);
    expect(container.textContent).toContain("confirm this phone’s access");
    await act(async () => {
      reading.resolve(
        Response.json({ ...standing, actsAsHostPerson: false, accessLevel: "read-only" }),
      );
    });
    expect(container.textContent).toContain("Watching only");
    expect(element("mobile-composer-input")?.hasAttribute("readonly")).toBe(true);
    expect(element("mobile-composer-send")?.getAttribute("aria-disabled")).toBe("true");
    await render(home("code"));
    expect(element("mobile-composer-input")?.hasAttribute("readonly")).toBe(true);

    await render(home("inbox"));
    expect(element("mobile-home-compose")?.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Watching only");
    await act(async () => element("mobile-home-compose")?.click());
    expect(document.querySelector('[data-testid="mobile-home-composer-sheet"]')).toBeNull();
    await act(async () => element(`mobile-home-thread-row-work-${existing.threadId}`)?.click());
    expect(opened).toHaveBeenCalledWith(existing);

    await render(
      createElement(AgentsListScreen, {
        view: "all",
        onBack: noop,
        onOpenThread: opened,
        onSelectView: noop,
      }),
    );
    expect(element("mobile-agents-compose")?.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Watching only");
    expect(createChat).not.toHaveBeenCalled();
    expect(createWork).not.toHaveBeenCalled();
    expect(createCode).not.toHaveBeenCalled();

    session.placementHostId = hostA;
    await render(home("inbox"));
    await act(async () => element("mobile-home-compose")?.click());
    session.placementHostId = hostB;
    await render(home("inbox"));
    const sheet = document.querySelector('[data-testid="mobile-home-composer-sheet"]');
    expect(sheet?.textContent).toContain("Watching only");
    const refresh = sheet?.querySelector<HTMLElement>(
      '[data-testid="mobile-home-composer-refresh-host"]',
    );
    expect(refresh).not.toBeNull();
    vi.mocked(watching.authenticatedFetch).mockResolvedValueOnce(
      Response.json({ ...standing, actsAsHostPerson: false, accessLevel: "approve-and-steer" }),
    );
    await act(async () => refresh?.click());
    const input = sheet?.querySelector('[data-testid="mobile-home-composer-input"]');
    expect(input?.hasAttribute("readonly")).toBe(false);
  } finally {
    act(() => root.unmount());
    session.placementHostId = hostA;
  }
});
