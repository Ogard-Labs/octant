// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MobileInboxRow } from "@octant/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider } from "../../design-system/theme";
import { createMobileMockScenario } from "../dev/mobileMockScenario";
import { RootNavigator } from "../navigation/RootNavigator";

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
  return { session: undefined as unknown, rows: [] as ReadonlyArray<unknown> };
});

vi.mock("@octant/client-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octant/client-runtime")>()),
  listAllHostsMobileInbox: async () => ({ rows: context.rows, failures: [] }),
  fetchMobileWorkProjects: async () => [],
  fetchMobileCodeProjects: async () => [],
}));
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
  useMobileSession: () => context.session,
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
vi.mock("../hosts/HostsScreen", () => ({ HostsScreen: () => null }));
vi.mock("../hosts/expoOwnerUnlockPorts", () => ({ createExpoPhoneUnlockKey: () => undefined }));
vi.mock("../todos/TodosScreen", () => ({ TodosScreen: () => null }));
vi.mock("../inbox/ThreadRowActionsSheet", () => ({ ThreadRowActionsSheet: () => null }));
vi.mock("../inbox/CodeDeliveryTargetSheet", () => ({ CodeDeliveryTargetSheet: () => null }));
vi.mock("../ui/ModelPickerSheet", () => ({ ModelPickerSheet: () => null }));
vi.mock("../inbox/HomeComposerSheet", () => ({ HomeComposerSheet: () => null }));
vi.mock("../inbox/ThreadScreen", () => ({
  ThreadScreen: (props: { readonly selected?: MobileInboxRow }) =>
    createElement("div", { "data-testid": "thread" }, props.selected?.threadId),
}));
vi.mock("../ui/CountTile", () => ({ CountTile: () => null }));

const scenario = createMobileMockScenario("full");
const studio = "11111111-1111-4111-8111-111111111111";
const reviewThread = "60000000-0000-4000-8000-000000000001";
const resumeThread = "60000000-0000-4000-8000-000000000002";
const unlistedThread = "60000000-0000-4000-8000-0000000000ff";

let root: Root;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}
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
function rowsIn(group: string): ReadonlyArray<string> {
  return [...(seen(`mobile-pr-group-${group}`)?.querySelectorAll("[data-testid]") ?? [])]
    .map((element) => element.getAttribute("data-testid") ?? "")
    .filter((id) => id.startsWith("mobile-pr-row-"));
}

beforeEach(async () => {
  context.session = {
    environment: { kind: "mock", scenarioId: "full", label: "Full", offlineDemo: true },
    hosts: scenario.hosts,
    hostsLoaded: true,
    hostsError: undefined,
    health: [],
    transport: scenario.transports[0],
    transports: scenario.transports,
    transportForHost: (hostId: string) =>
      scenario.transports.find((transport) => transport.hostId === hostId),
    inboxHostFilter: "all",
    setInboxHostFilter: () => undefined,
    deviceKeyStore: {},
    guestHubStore: {},
  };
  context.rows = [
    {
      hostId: studio,
      mode: "code",
      threadId: reviewThread,
      title: "Polish the mobile review loop",
      status: "active",
      freshness: "2026-08-10T09:30:00.000Z",
    },
  ];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(SafeAreaProvider, {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          },
          children: createElement(RootNavigator, {}),
        }),
      }),
    ),
  );
  await settle();
  await press("mobile-tab-prs");
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("the phone's pull requests", () => {
  it("sorts pull requests from both computers by what they wait on, naming each computer", () => {
    expect(rowsIn("needs-you")).toEqual(["mobile-pr-row-815", "mobile-pr-row-47"]);
    expect(rowsIn("ready")).toEqual(["mobile-pr-row-812"]);
    expect(rowsIn("in-progress")).toEqual(["mobile-pr-row-44", "mobile-pr-row-809"]);
    const failing = seen("mobile-pr-row-815")?.getAttribute("aria-label") ?? "";
    expect(failing).toContain("4 of 6 passed");
    expect(failing).toContain("Babysitting");
    expect(failing).toContain("Studio Mac");
    expect(seen("mobile-pr-row-44")?.getAttribute("aria-label")).toContain("Merge queued");
  });

  it("opens a pull request and its thread, while a thread the phone does not list stays unopenable", async () => {
    await press("mobile-pr-row-47");
    expect(seen("mobile-pr-detail")?.textContent).toContain("Changes requested");
    expect(seen(`mobile-pr-thread-${unlistedThread}`)?.getAttribute("role")).not.toBe("button");
    expect(seen(`mobile-pr-thread-${unlistedThread}`)?.textContent).toContain(
      "Not in this phone's thread list",
    );
  });

  it("follows a linked thread from a pull request to the thread itself", async () => {
    await press("mobile-pr-row-812");
    await press(`mobile-pr-thread-${reviewThread}`);
    expect(seen("thread")?.textContent).toBe(reviewThread);
  });

  it("asks before merging, sends the head it re-read, and offers no Merge once merged", async () => {
    await press("mobile-pr-row-812");
    expect(seen("mobile-pr-merge-confirm")).toBeUndefined();
    await press("mobile-pr-merge-open");
    expect(seen("mobile-pr-merge")?.textContent).toContain("Merge #812 now?");
    await press("mobile-pr-merge-confirm");
    expect(seen("mobile-pr-merge")).toBeUndefined();
    expect(seen("mobile-pr-detail")?.textContent).toContain("Merged");
  });

  it("refuses to offer the confirm step for a pull request the computer says is not mergeable", async () => {
    await press("mobile-pr-row-47");
    await press("mobile-pr-merge-open");
    expect(seen("mobile-pr-merge-confirm")).toBeUndefined();
    expect(seen("mobile-pr-merge-notice")?.textContent).toContain("Not ready to merge here");
  });
  it("turns Babysit off, and on again for a linked thread with the checks the person chose", async () => {
    const asked: string[] = [];
    const choose = (button: string) =>
      vi.spyOn(Alert, "alert").mockImplementation((title, _body, buttons) => {
        asked.push(String(title));
        buttons?.find((entry) => entry.text === button)?.onPress?.();
      });
    await press("mobile-pr-row-815");
    expect(seen("mobile-pr-babysit")?.textContent).toBe("Fixing a failing check");
    choose("Turn off Babysit");
    await press(`mobile-pr-babysit-off-${resumeThread}`);
    expect(seen("mobile-pr-babysit")?.textContent).toBe("Off");
    choose("All checks");
    await press(`mobile-pr-babysit-on-${resumeThread}`);
    expect(seen("mobile-pr-babysit")?.textContent).toBe("Checking");
    expect(seen(`mobile-pr-babysit-on-${resumeThread}`)).toBeUndefined();
    expect(asked).toEqual(["Turn off Babysit?", "Turn on Babysit?"]);
    vi.restoreAllMocks();
  });
});
