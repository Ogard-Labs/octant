// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import { expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import { HomeScreen } from "./HomeScreen";
import { MobileThreadsProvider } from "./MobileThreadsContext";
import { NewThreadProvider, useNewThread } from "./NewThreadContext";

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
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock("../navigation/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../ui/CountTile", () => ({ CountTile: () => null }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
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

/** New, as the bar offers it: off while the computer takes no thread from this phone. */
function NewButton() {
  const { openNewThread, accessReason } = useNewThread();
  return createElement(
    "button",
    { "data-testid": "new", disabled: accessReason !== undefined, onClick: openNewThread },
    "New",
  );
}

it("keeps existing threads openable while the placement host refuses new threads", async () => {
  const opened = vi.fn();
  const noop = () => undefined;
  const home = () =>
    createElement(MobileThreadsProvider, {
      children: createElement(NewThreadProvider, {
        onOpenThread: opened,
        children: [
          createElement(NewButton, { key: "new" }),
          createElement(HomeScreen, {
            key: "home",
            onAddWorkspace: noop,
            onOpenCounted: noop,
            onOpenSettings: noop,
            onOpenThread: opened,
            onOpenThreads: noop,
            onOpenTodos: noop,
            onOpenWorkspace: noop,
            onScanToPair: noop,
          }),
        ],
      }),
    });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async () =>
    act(async () =>
      root.render(createElement(ThemeProvider, { preference: "light", children: home() })),
    );
  const element = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const sheet = () => document.querySelector('[data-testid="mobile-home-composer-sheet"]');
  listInbox.mockResolvedValue({ rows: [existing], failures: [] });
  try {
    await render();
    expect(element("new")?.hasAttribute("disabled")).toBe(false);

    const reading = Promise.withResolvers<Response>();
    vi.mocked(watching.authenticatedFetch).mockImplementationOnce(() => reading.promise);
    session.placementHostId = hostB;
    await render();
    expect(element("new")?.hasAttribute("disabled")).toBe(true);
    expect(container.textContent).toContain("confirm this phone’s access");
    await act(async () => {
      reading.resolve(
        Response.json({ ...standing, actsAsHostPerson: false, accessLevel: "read-only" }),
      );
    });
    expect(container.textContent).toContain("Watching only");
    expect(element("new")?.hasAttribute("disabled")).toBe(true);
    await act(async () => element("new")?.click());
    expect(sheet()).toBeNull();
    await act(async () => element(`mobile-home-thread-row-work-${existing.threadId}`)?.click());
    expect(opened).toHaveBeenCalledWith(existing);

    // The sheet was open when the computer new threads go to changed.
    session.placementHostId = hostA;
    await render();
    await act(async () => element("new")?.click());
    session.placementHostId = hostB;
    await render();
    expect(sheet()?.textContent).toContain("Watching only");
    const input = () => sheet()?.querySelector('[data-testid="mobile-home-composer-input"]');
    expect(input()?.hasAttribute("readonly")).toBe(true);
    expect(createChat).not.toHaveBeenCalled();
    expect(createWork).not.toHaveBeenCalled();
    expect(createCode).not.toHaveBeenCalled();
    const refresh = sheet()?.querySelector<HTMLElement>(
      '[data-testid="mobile-home-composer-refresh-host"]',
    );
    vi.mocked(watching.authenticatedFetch).mockResolvedValueOnce(
      Response.json({ ...standing, actsAsHostPerson: false, accessLevel: "approve-and-steer" }),
    );
    await act(async () => refresh?.click());
    expect(input()?.hasAttribute("readonly")).toBe(false);
  } finally {
    act(() => root.unmount());
    session.placementHostId = hostA;
  }
});
