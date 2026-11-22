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

function mobileSession(transport: MobileRemoteTransport): MobileSessionContextValue {
  return {
    environment: { kind: "mock", scenarioId: "full", label: "Sample", offlineDemo: true },
    hosts: [],
    hostsLoaded: true,
    hostsError: undefined,
    health: [],
    transport,
    transports: [transport],
    transportForHost: (hostId: string) => (hostId === transport.hostId ? transport : undefined),
    setInboxHostFilter: () => undefined,
    refreshHosts: async () => undefined,
    resumeHost: () => undefined,
    inboxHostFilter: "all",
    placementHostId: undefined,
    setPlacementHostId: () => undefined,
    registry: {},
    guestHubStore: { load: async () => ({ notAccepted: [] }) },
    deviceKeyStore: {},
    bridge: {},
    bridgeState: { kind: "unavailable" },
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

function navigator(route: "todos" | "hosts", onSelectRoute: (next: MobileRouteId) => void) {
  return createElement(ThemeProvider, {
    preference: "light",
    children: createElement(RootNavigator, { activeRoute: route, onSelectRoute }),
  });
}

async function renderRoute(
  root: Root,
  route: "todos" | "hosts",
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
});
