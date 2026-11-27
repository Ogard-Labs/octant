// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider } from "../../design-system/theme";
import type { MobileSessionContextValue } from "../session/MobileSessionContext";
import { DEEP_LINK_HOST_NOT_PAIRED } from "./deepLinkNavigation";
import { RootNavigator, type RootNavigatorProps } from "./RootNavigator";

const context = vi.hoisted(() => {
  Object.assign(globalThis, {
    __DEV__: true,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  return { session: undefined as unknown, rows: [] as ReadonlyArray<unknown>, sheetOpen: false };
});

vi.mock("@octant/client-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octant/client-runtime")>()),
  listAllHostsMobileInbox: async () => ({ rows: context.rows, failures: [] }),
  fetchMobileWorkProjects: async () => [],
  fetchMobileCodeProjects: async () => [],
}));
// Its native views have no browser build the test can load.
vi.mock("react-native-screens", () => ({}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/tone")),
  ...(await import("../../design-system/GlassSurface")),
  ScreenCanvas: (props: { readonly children: unknown }) => props.children,
}));
vi.mock("../appearance/AppearanceContext", () => ({
  useAppearance: () => ({ preferences: { effect: "none", picture: "plain" } }),
}));
vi.mock("../session/MobileSessionContext", () => ({
  useMobileSession: () => context.session as MobileSessionContextValue,
}));
vi.mock("../inbox/usePlacement", () => ({
  usePlacement: () => ({
    placementTransport: undefined,
    staleGate: { allowProductMutations: true },
    models: { options: [] },
    modelLabel: "Host models",
    refreshPlacement: () => undefined,
    setModelOptionId: () => undefined,
    modelOptionValues: {},
    setModelOptionValue: () => undefined,
  }),
}));
vi.mock("../voice/useVoiceDictation", () => ({ useVoiceDictation: () => undefined }));
vi.mock("../notifications/usePhoneNotificationRotation", () => ({
  usePhoneNotificationRotation: () => undefined,
}));
vi.mock("../notifications/mobileNotificationPort", () => ({ mobileNotificationPort: {} }));
vi.mock("../notifications/mobilePushRegistrationBook", () => ({
  mobilePushRegistrationBook: () => ({}),
}));
vi.mock("../hosts/HostsScreen", () => ({
  HostsScreen: (props: { readonly notice?: string }) =>
    createElement("div", { "data-testid": "settings" }, props.notice),
}));
vi.mock("../todos/TodosScreen", () => ({ TodosScreen: () => null }));
vi.mock("../inbox/ThreadRowActionsSheet", () => ({ ThreadRowActionsSheet: () => null }));
vi.mock("../inbox/CodeDeliveryTargetSheet", () => ({ CodeDeliveryTargetSheet: () => null }));
vi.mock("../ui/ModelPickerSheet", () => ({ ModelPickerSheet: () => null }));
vi.mock("../inbox/HomeComposerSheet", () => ({
  HomeComposerSheet: (props: { readonly visible: boolean }) =>
    props.visible ? createElement("div", { "data-testid": "new-thread-sheet" }) : null,
}));
vi.mock("../inbox/ThreadScreen", () => ({
  ThreadScreen: (props: { readonly selected?: MobileInboxRow }) =>
    createElement("div", { "data-testid": "thread" }, props.selected?.threadId),
}));
vi.mock("../ui/CountTile", () => ({
  CountTile: (props: {
    readonly testID: string;
    readonly count: number;
    readonly onPress: () => void;
  }) =>
    createElement(
      "button",
      { "data-testid": props.testID, onClick: props.onPress },
      String(props.count),
    ),
}));

const studio = "11111111-1111-4111-8111-111111111111";
const laptop = "22222222-2222-4222-8222-222222222222";
const row = (threadId: string, fields: Partial<MobileInboxRow> = {}): MobileInboxRow => ({
  hostId: studio,
  mode: "code",
  threadId,
  title: threadId,
  status: "active",
  freshness: "2026-11-25T08:00:00.000Z",
  ...fields,
});
const transport = (hostId: string): MobileRemoteTransport => ({
  hostId,
  authenticatedFetch: async () => Response.json({}),
});
const session = {
  environment: { kind: "live" },
  hosts: [
    { hostId: studio, label: "Studio" },
    { hostId: laptop, label: "Laptop" },
  ],
  hostsLoaded: true,
  hostsError: undefined,
  health: [],
  transport: transport(studio),
  transports: [transport(studio), transport(laptop)],
  transportForHost: () => undefined,
  inboxHostFilter: "all",
  setInboxHostFilter: () => undefined,
};

let root: Root;
let container: HTMLElement;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1)
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}
async function render(props: RootNavigatorProps = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(SafeAreaProvider, {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          },
          children: createElement(RootNavigator, props),
        }),
      }),
    ),
  );
  await settle();
}
/** The element of that name a person can see: places kept in the background are not shown. */
function seen(testId: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].find(
    (element) => {
      for (let node: HTMLElement | null = element; node !== null; node = node.parentElement)
        if (
          node.style.display === "none" ||
          node.getAttribute("aria-hidden") === "true" ||
          getComputedStyle(node).display === "none"
        )
          return false;
      return true;
    },
  );
}
async function press(testId: string): Promise<void> {
  const element = seen(testId);
  if (element === undefined) throw new Error(`${testId} is not shown`);
  await act(async () => element.click());
  await settle();
}
async function back(): Promise<void> {
  const button = [...container.querySelectorAll<HTMLElement>("[aria-label]")].filter((element) =>
    /back$/i.test(element.getAttribute("aria-label") ?? ""),
  );
  // The header answers on the next frame.
  await act(async () => {
    button.at(-1)?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await settle();
}

beforeEach(() => {
  context.session = session;
  context.rows = [
    row("code", { live: "working" }),
    row("work", { mode: "work" }),
    row("chat", { mode: "chat", hostId: laptop }),
    row("waiting", { live: "needs-input", waitingAsk: { label: "Approval" } }),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("the phone's navigation", () => {
  it("shows Home, Threads and Inbox in the bar, while Bots and PRs stay hidden until their work lands", async () => {
    await render();
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) =>
      tab.getAttribute("aria-label"),
    );
    expect(tabs).toEqual(["Home", "Threads", "Inbox"]);
  });

  it("lists Chat, Work and Code threads from every computer in Threads, and narrows to Code", async () => {
    await render();
    await press("mobile-tab-threads");
    for (const name of ["code-code", "work-work", "chat-chat"])
      expect(seen(`mobile-home-thread-row-${name}`)).toBeDefined();
    await press("mobile-threads-mode");
    await press("mobile-threads-mode-code");
    expect(seen("mobile-home-thread-row-code-code")).toBeDefined();
    expect(seen("mobile-home-thread-row-work-work")).toBeUndefined();
    expect(seen("mobile-home-thread-row-chat-chat")).toBeUndefined();
  });

  it("shows Threads as a list beside the open thread on a window as wide as an iPad", async () => {
    // The web build reads the window's width from the document element.
    const page = document.documentElement;
    const width = page.clientWidth;
    const resize = (value: number) => {
      Object.defineProperty(page, "clientWidth", { configurable: true, value });
      window.dispatchEvent(new Event("resize"));
    };
    resize(1024);
    try {
      await render();
      await press("mobile-tab-threads");
      expect(seen("mobile-place-columns")).toBeDefined();
      expect(seen("mobile-place-columns-empty")).toBeDefined();
      await press("mobile-home-thread-row-code-code");
      expect(seen("thread")?.textContent).toBe("code");
      expect(seen("mobile-home-thread-row-work-work")).toBeDefined();
    } finally {
      resize(width);
    }
  });

  it("opens the new-thread sheet from every place", async () => {
    await render();
    for (const place of ["home", "threads", "inbox"]) {
      await press(`mobile-tab-${place}`);
      expect(seen("mobile-new-thread"), place).toBeDefined();
    }
    await press("mobile-new-thread");
    expect(seen("new-thread-sheet")).toBeDefined();
  });

  it("keeps the bar in a thread, and Back returns to the list it was opened from", async () => {
    await render();
    await press("mobile-tab-inbox");
    await press("mobile-home-thread-row-code-waiting");
    expect(seen("thread")?.textContent).toBe("waiting");
    expect(seen("mobile-tab-bar")).toBeDefined();
    await back();
    expect(seen("mobile-inbox")).toBeDefined();
    expect(seen("mobile-tab-bar")).toBeDefined();
  });

  it("counts a finished turn under To review until its thread is opened, with what it does while open", async () => {
    context.rows = [row("turn", { lastSequence: 4 })];
    await render();
    // What the computer had already finished when the phone first saw it is read.
    expect(seen("mobile-tile-review")?.textContent).toBe("0");
    context.rows = [row("turn", { lastSequence: 9 })];
    await press("mobile-tab-threads");
    await press("mobile-tab-home");
    expect(seen("mobile-tile-review")?.textContent).toBe("1");
    await press("mobile-tile-review");
    await press("mobile-home-thread-row-code-turn");
    context.rows = [row("turn", { lastSequence: 15 })];
    await back();
    expect(seen("mobile-counted-threads")?.textContent).toContain("No finished turns waiting.");
    await back();
    expect(seen("mobile-tile-review")?.textContent).toBe("0");
  });

  it("keeps the threads it read when no computer can be reached, and drops a removed computer's", async () => {
    await render();
    await press("mobile-tab-threads");
    context.session = { ...session, transports: [], transport: undefined };
    await render();
    expect(seen("mobile-home-thread-row-code-code")).toBeDefined();
    expect(seen("mobile-home-thread-row-chat-chat")).toBeDefined();
    context.session = {
      ...session,
      hosts: session.hosts.filter((host) => host.hostId === studio),
      transports: [],
      transport: undefined,
    };
    await render();
    expect(seen("mobile-home-thread-row-code-code")).toBeDefined();
    expect(seen("mobile-home-thread-row-chat-chat")).toBeUndefined();
    context.session = {
      ...session,
      health: [{ hostId: studio, kind: "unauthorized" }],
      transports: [],
      transport: undefined,
    };
    await render();
    expect(seen("mobile-home-thread-row-code-code")).toBeUndefined();
  });

  it("keeps each place where the person left it", async () => {
    await render();
    await press("mobile-tile-attention");
    expect(seen("mobile-counted-threads")).toBeDefined();
    await press("mobile-tab-inbox");
    await press("mobile-tab-home");
    expect(seen("mobile-counted-threads")).toBeDefined();
  });

  it("opens a tapped thread notification on that thread, and Back returns to its list", async () => {
    const consumed = vi.fn();
    await render({ pendingDeepLinkRow: row("linked"), onDeepLinkConsumed: consumed });
    expect(seen("thread")?.textContent).toBe("linked");
    expect(consumed).toHaveBeenCalledOnce();
    await back();
    expect(seen("mobile-threads")).toBeDefined();
  });

  it("leaves the person on the screen they were on when a link is refused, with the reason", async () => {
    await render();
    await press("mobile-tab-inbox");
    await render({
      pendingDeepLinkRow: row("elsewhere", { hostId: "33333333-3333-4333-8333-333333333333" }),
    });
    expect(seen("mobile-inbox")).toBeDefined();
    expect(seen("thread")).toBeUndefined();
    expect(seen("mobile-link-notice")?.textContent).toContain(DEEP_LINK_HOST_NOT_PAIRED);
    await press("mobile-link-notice-dismiss");
    expect(seen("mobile-link-notice")).toBeUndefined();
  });

  it("opens the Computers link in Settings over Home", async () => {
    await render({ pendingComputersLink: { hostId: studio } as never });
    expect(seen("settings")).toBeDefined();
    await back();
    expect(seen("mobile-inbox-home")).toBeDefined();
  });
});
