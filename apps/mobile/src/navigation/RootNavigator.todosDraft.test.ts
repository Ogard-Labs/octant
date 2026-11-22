// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRouteId } from "../copy";
import { ThemeProvider } from "../../design-system/theme";
import type { MobileSessionContextValue } from "../session/MobileSessionContext";
import { RootNavigator } from "./RootNavigator";

const context = vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: true, IS_REACT_ACT_ENVIRONMENT: true });
  return { current: undefined as unknown };
});

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system/themeAtmospheres", () => ({
  themeAtmosphereSources: { light: 0, dark: 0 },
  themeAtmosphereOpacity: { light: 0.58, dark: 0.36 },
}));
vi.mock("../../design-system/groundPictures", () => ({ pictureSource: () => undefined }));
vi.mock("../session/MobileSessionContext", () => ({
  useMobileSession: () => context.current as MobileSessionContextValue,
}));
vi.mock("../notifications/usePhoneNotificationRotation", () => ({
  usePhoneNotificationRotation: () => undefined,
}));
vi.mock("../notifications/mobileNotificationPort", () => ({ mobileNotificationPort: {} }));
vi.mock("../notifications/mobilePushRegistrationBook", () => ({
  mobilePushRegistrationBook: () => ({}),
}));
vi.mock("../hosts/expoOwnerUnlockPorts", () => ({ createExpoPhoneUnlockKey: () => undefined }));
vi.mock("../hosts/GuestHubPanel", () => ({
  GuestHubPanel: () => null,
  GuestHubRefusals: () => null,
}));
vi.mock("../session/mobileSessionLifecycle", () => ({
  createMobileHostRemover: () => async () => ({ localCredentialRemoved: true }),
}));
vi.mock("./useMobileHardwareBack", () => ({ useMobileHardwareBack: () => undefined }));
vi.mock("../ui/TabBar", () => ({ TabBar: () => null }));
vi.mock("../../design-system/ScreenCanvas", () => ({ ScreenCanvas: () => null }));
vi.mock("../approvals/DeviceRevokePanel", () => ({ DeviceRevokePanel: () => null }));
vi.mock("../appearance/AppearanceBackgroundPanel", () => ({
  AppearanceBackgroundPanel: () => null,
}));
vi.mock("../hosts/ConnectorSignInPanel", () => ({ ConnectorSignInPanel: () => null }));
vi.mock("../hosts/OwnerAlertsPanel", () => ({ OwnerAlertsPanel: () => null }));
vi.mock("../hosts/OwnerMovesPanel", () => ({ OwnerMovesPanel: () => null }));
vi.mock("../hosts/PairingPanel", () => ({ PairingPanel: () => null }));
vi.mock("../hosts/RemoveHostPanel", () => ({ RemoveHostPanel: () => null }));
vi.mock("../inbox/AgentsListScreen", () => ({ AgentsListScreen: () => null }));
vi.mock("../inbox/InboxHomeScreen", () => ({ InboxHomeScreen: () => null }));
vi.mock("../inbox/ThreadScreen", () => ({ ThreadScreen: () => null }));
vi.mock("../notifications/enablePhoneNotifications", () => ({
  forgetPhoneNotificationsForHost: async () => undefined,
}));
vi.mock("../notifications/PushNotificationsPanel", () => ({ PushNotificationsPanel: () => null }));
vi.mock("../security/deviceIntegrityPort", () => ({
  createUnavailableDeviceIntegrityPort: () => ({}),
}));
vi.mock("../security/deviceProtection", () => ({
  mobileKeyStorageProtection: {},
  mobileScreenshotPrivacy: {},
}));
vi.mock("../security/expoBiometricAuthenticator", () => ({
  createExpoBiometricAuthenticator: () => ({}),
}));
vi.mock("../security/PrivacySecurityPanel", () => ({ PrivacySecurityPanel: () => null }));

const hostA = "11111111-1111-4111-8111-111111111111";
const hostB = "22222222-2222-4222-8222-222222222222";
const roots: Root[] = [];

function mobileSession(
  transport: MobileRemoteTransport | undefined,
  registeredHostIds: ReadonlyArray<string> = [],
  bridgeState: MobileSessionContextValue["bridgeState"] = {
    kind: "unavailable",
    reason: "Unavailable.",
  },
  inboxHostFilter: MobileSessionContextValue["inboxHostFilter"] = "all",
): MobileSessionContextValue {
  return {
    environment: { kind: "mock", scenarioId: "full", label: "Sample", offlineDemo: true },
    hosts: registeredHostIds.map((hostId) => ({ hostId, label: "Studio" })),
    hostsLoaded: true,
    hostsError: undefined,
    health: [],
    transport,
    transports: transport === undefined ? [] : [transport],
    transportForHost: (hostId: string) => (hostId === transport?.hostId ? transport : undefined),
    setInboxHostFilter: () => undefined,
    refreshHosts: async () => undefined,
    resumeHost: () => undefined,
    inboxHostFilter,
    placementHostId: undefined,
    setPlacementHostId: () => undefined,
    registry: {},
    guestHubStore: { load: async () => ({ notAccepted: [] }) },
    deviceKeyStore: {},
    bridge: {},
    bridgeState,
    hub: {},
    fullAccessWarnings: {},
  } as unknown as MobileSessionContextValue;
}

function input(container: HTMLElement): HTMLInputElement {
  const field = container.querySelector('[data-testid="mobile-todos-add"]');
  if (!(field instanceof HTMLInputElement))
    throw new Error("The to-do draft input was not rendered.");
  return field;
}

function listResponse(
  hostId: string,
  row?: { readonly id: string; readonly title: string },
): Response {
  return Response.json({
    kind: "todo-list",
    hostId,
    todos:
      row === undefined
        ? []
        : [
            {
              id: row.id,
              title: row.title,
              notes: "",
              projects: [],
              tags: [],
              state: "open",
              threads: [],
              rank: 0,
              version: 1,
              createdAt: "2026-11-14T10:00:00.000Z",
              updatedAt: "2026-11-14T10:00:00.000Z",
            },
          ],
  });
}

async function typeText(field: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(field: HTMLInputElement): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function navigator(route: MobileRouteId, onSelectRoute: (next: MobileRouteId) => void) {
  return createElement(ThemeProvider, {
    preference: "light",
    children: createElement(RootNavigator, { activeRoute: route, onSelectRoute }),
  });
}

async function renderRoute(
  root: Root,
  route: MobileRouteId,
  onSelectRoute: (next: MobileRouteId) => void,
): Promise<void> {
  await act(async () => root.render(navigator(route, onSelectRoute)));
  await settle();
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("the to-do draft across host selection", () => {
  it("reuses the draft id on one host and preserves text across a switch and late reply", async () => {
    const firstCommands: Array<Record<string, unknown>> = [];
    const nextCommands: Array<Record<string, unknown>> = [];
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstReply = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const firstTransport: MobileRemoteTransport = {
      hostId: hostA,
      authenticatedFetch: async ({ method, path, body }) => {
        if (method === "GET" && path === "/api/todos")
          return Response.json({ kind: "todo-list", hostId: hostA, todos: [] });
        if (method === "POST" && path === "/api/todos/commands") {
          firstCommands.push(JSON.parse(String(body)) as Record<string, unknown>);
          if (firstCommands.length === 1) return firstReply;
          return Response.json(
            {
              kind: "todo-refused",
              reason: "kept-elsewhere",
              message: "Another computer keeps the to-do list.",
            },
            { status: 409 },
          );
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    };
    const nextTransport: MobileRemoteTransport = {
      hostId: hostB,
      authenticatedFetch: async ({ method, path, body }) => {
        if (method === "GET" && path === "/api/todos")
          return Response.json({ kind: "todo-list", hostId: hostB, todos: [] });
        if (method === "POST" && path === "/api/todos/commands") {
          nextCommands.push(JSON.parse(String(body)) as Record<string, unknown>);
          return Response.json(
            {
              kind: "todo-refused",
              reason: "kept-elsewhere",
              message: "Another computer keeps the to-do list.",
            },
            { status: 409 },
          );
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    };
    context.current = mobileSession(firstTransport);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const onSelectRoute = vi.fn<(next: MobileRouteId) => void>();

    await renderRoute(root, "todos", onSelectRoute);
    await typeText(input(container), "Carry this draft");
    await submit(input(container));
    expect(firstCommands).toHaveLength(1);

    await renderRoute(root, "hosts", onSelectRoute);
    await renderRoute(root, "todos", onSelectRoute);
    expect(input(container).value).toBe("Carry this draft");
    expect(firstCommands).toHaveLength(1);
    await submit(input(container));
    await settle();
    expect(firstCommands).toHaveLength(2);
    expect(firstCommands[1]?.todoId).toBe(firstCommands[0]?.todoId);

    await renderRoute(root, "hosts", onSelectRoute);
    context.current = mobileSession(nextTransport);
    await renderRoute(root, "hosts", onSelectRoute);
    await renderRoute(root, "todos", onSelectRoute);

    expect(input(container).value).toBe("Carry this draft");
    expect(nextCommands).toHaveLength(0);
    const releaseFirst = resolveFirst;
    if (releaseFirst === undefined) throw new Error("The first host did not receive the request.");
    await act(async () => {
      releaseFirst(Response.json({ kind: "todo-list", hostId: hostA, todos: [] }));
      await firstReply;
    });
    expect(input(container).value).toBe("Carry this draft");
    expect(nextCommands).toHaveLength(0);

    await submit(input(container));
    expect(nextCommands).toHaveLength(1);
    expect(nextCommands[0]?.todoId).not.toBe(firstCommands[0]?.todoId);
    expect(input(container).value).toBe("Carry this draft");
  });

  it("keeps its id and acknowledges an accepted send across same-host authentication renewal", async () => {
    const commands: Array<Record<string, unknown>> = [];
    let resolveAccepted: ((response: Response) => void) | undefined;
    const acceptedReply = new Promise<Response>((resolve) => {
      resolveAccepted = resolve;
    });
    let resolveRetry: ((response: Response) => void) | undefined;
    const retryReply = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    const transport: MobileRemoteTransport = {
      hostId: hostA,
      authenticatedFetch: async ({ method, path, body }) => {
        if (method === "GET" && path === "/api/todos")
          return Response.json({ kind: "todo-list", hostId: hostA, todos: [] });
        if (method === "POST" && path === "/api/todos/commands") {
          commands.push(JSON.parse(String(body)) as Record<string, unknown>);
          return commands.length === 1 ? acceptedReply : retryReply;
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    };
    const ready = { kind: "ready", hostId: hostA, displayName: "Studio" } as const;
    context.current = mobileSession(transport, [hostA], ready, hostA);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const onSelectRoute = vi.fn<(next: MobileRouteId) => void>();

    await renderRoute(root, "todos", onSelectRoute);
    await typeText(input(container), "Carry this draft");
    await submit(input(container));
    expect(commands).toHaveLength(1);

    context.current = mobileSession(
      undefined,
      [hostA],
      { kind: "authenticating", hostId: hostA, displayName: "Studio" },
      hostA,
    );
    await renderRoute(root, "todos", onSelectRoute);
    context.current = mobileSession(transport, [hostA], ready, hostA);
    await renderRoute(root, "todos", onSelectRoute);
    expect(input(container).value).toBe("Carry this draft");
    await submit(input(container));
    expect(commands).toHaveLength(2);
    expect(commands[1]?.todoId).toBe(commands[0]?.todoId);

    await renderRoute(root, "home", onSelectRoute);
    const resolveFirst = resolveAccepted;
    if (resolveFirst === undefined) throw new Error("The accepted send did not start.");
    await act(async () => {
      resolveFirst(Response.json({ kind: "todo-list", hostId: hostA, todos: [] }));
      await acceptedReply;
    });
    await renderRoute(root, "todos", onSelectRoute);
    expect(input(container).value).toBe("");

    const resolveSecond = resolveRetry;
    if (resolveSecond === undefined) throw new Error("The explicit retry did not start.");
    await act(async () => {
      resolveSecond(Response.json({ kind: "todo-list", hostId: hostA, todos: [] }));
      await retryReply;
    });
    await renderRoute(root, "todos", onSelectRoute);
    expect(input(container).value).toBe("");
  });

  it("keeps the current host list and edited draft when an accepted prior-host send replies", async () => {
    const previousHostCommands: Array<Record<string, unknown>> = [];
    let previousHostReads = 0;
    let currentHostReads = 0;
    let resolvePreviousHostSend: ((response: Response) => void) | undefined;
    const previousHostSend = new Promise<Response>((resolve) => {
      resolvePreviousHostSend = resolve;
    });
    let resolveCurrentHostRead: ((response: Response) => void) | undefined;
    const currentHostRead = new Promise<Response>((resolve) => {
      resolveCurrentHostRead = resolve;
    });
    const previousTransport: MobileRemoteTransport = {
      hostId: hostA,
      authenticatedFetch: async ({ method, path, body }) => {
        if (method === "GET" && path === "/api/todos") {
          previousHostReads += 1;
          return listResponse(hostA);
        }
        if (method === "POST" && path === "/api/todos/commands") {
          previousHostCommands.push(JSON.parse(String(body)) as Record<string, unknown>);
          return previousHostSend;
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    };
    const currentTransport: MobileRemoteTransport = {
      hostId: hostB,
      authenticatedFetch: async ({ method, path }) => {
        if (method === "GET" && path === "/api/todos") {
          currentHostReads += 1;
          return currentHostRead;
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    };
    context.current = mobileSession(
      previousTransport,
      [hostA, hostB],
      { kind: "ready", hostId: hostA, displayName: "Previous" },
      hostA,
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const onSelectRoute = vi.fn<(next: MobileRouteId) => void>();

    await renderRoute(root, "todos", onSelectRoute);
    await typeText(input(container), "Send from previous host");
    await submit(input(container));
    expect(previousHostCommands).toHaveLength(1);

    context.current = mobileSession(
      currentTransport,
      [hostA, hostB],
      { kind: "ready", hostId: hostB, displayName: "Current" },
      hostB,
    );
    await renderRoute(root, "todos", onSelectRoute);
    expect(currentHostReads).toBe(1);
    expect(input(container).value).toBe("Send from previous host");
    await typeText(input(container), "Edited for current host");

    const resolveSend = resolvePreviousHostSend;
    if (resolveSend === undefined) throw new Error("The previous host did not receive the send.");
    await act(async () => {
      resolveSend(
        listResponse(hostA, {
          id: "33333333-3333-4333-8333-333333333333",
          title: "Stale previous-host row",
        }),
      );
      await previousHostSend;
    });
    expect(previousHostReads).toBe(1);
    expect(currentHostReads).toBe(1);
    expect(container.textContent).not.toContain("Stale previous-host row");
    expect(input(container).value).toBe("Edited for current host");

    const resolveRead = resolveCurrentHostRead;
    if (resolveRead === undefined) throw new Error("The current host list read did not start.");
    await act(async () => {
      resolveRead(
        listResponse(hostB, {
          id: "44444444-4444-4444-8444-444444444444",
          title: "Current-host row",
        }),
      );
      await currentHostRead;
    });
    expect(container.textContent).toContain("Current-host row");
    expect(container.textContent).not.toContain("Stale previous-host row");
    expect(input(container).value).toBe("Edited for current host");
  });
});
