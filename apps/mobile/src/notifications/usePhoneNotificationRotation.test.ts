// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createPushRegistrationBook } from "./pushRegistrationBook";
import { createUnavailableNotificationPermissionPort } from "./notificationPermissionPort";
import { usePhoneNotificationRotation } from "./usePhoneNotificationRotation";

const listeners = vi.hoisted(() => ({ add: vi.fn(() => ({ remove: vi.fn() })) }));
vi.mock("react-native", () => ({ AppState: { addEventListener: listeners.add } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("leaves pending native notification-key deletion untouched in the offline environment", async () => {
  const values = new Map<string, string>();
  const book = createPushRegistrationBook({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    deleteItem: async (key) => {
      values.delete(key);
    },
  });
  const pending = {
    hostId: "real-host",
    deviceId: "real-device",
    hostKeyFingerprint: "real-fingerprint",
    tokenDigest: "real-token-digest",
    forgetPending: true,
  } as const;
  await book.record(pending);
  const read = vi.spyOn(book, "list");
  const forgetHost = vi.fn(async () => undefined);
  const permission = { ...createUnavailableNotificationPermissionPort(), forgetHost };
  function Rotation(props: { readonly enabled: boolean }) {
    usePhoneNotificationRotation({
      enabled: props.enabled,
      book,
      permission,
      transportForHost: () => undefined,
      transports: [],
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Rotation, { enabled: false })));
  expect(read).not.toHaveBeenCalled();
  expect(forgetHost).not.toHaveBeenCalled();
  expect(listeners.add).not.toHaveBeenCalled();
  expect(await book.list()).toEqual([pending]);
  await act(async () => root?.render(createElement(Rotation, { enabled: true })));
  expect(forgetHost).toHaveBeenCalledTimes(1);
  expect(await book.list()).toEqual([]);
});
