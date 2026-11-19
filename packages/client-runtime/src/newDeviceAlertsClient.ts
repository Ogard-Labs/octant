import {
  NEW_DEVICE_ALERTS_PATH,
  NewDeviceAlertList,
  decodeHostAnswer,
  type NewDeviceAlertList as NewDeviceAlertListType,
} from "@octant/contracts";

/**
 * The new-device alerts a host holds, for any device connected to it: a
 * window, a paired browser, a hub guest, a phone (maintainer decision,
 * 2026-11-19). A refusal or an answer off the contract reads as `undefined`,
 * so a client keeps what it last showed rather than clearing an alert.
 */
export interface NewDeviceAlertsClient {
  readonly read: (signal?: AbortSignal) => Promise<NewDeviceAlertListType | undefined>;
  /** Clears a directly paired device's alert; the host takes this from a window on it alone. */
  readonly dismiss: (alertId: string) => Promise<boolean>;
}

export function createNewDeviceAlertsClient(port: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** A window's capability; a paired device sends none and its session carries it. */
  readonly windowCapability?: string;
}): NewDeviceAlertsClient {
  const capability =
    port.windowCapability === undefined || port.windowCapability === ""
      ? {}
      : { "x-octant-window-capability": port.windowCapability };
  return {
    read: async (signal) => {
      try {
        const response = await port.fetch(new URL(NEW_DEVICE_ALERTS_PATH, port.baseUrl), {
          method: "GET",
          headers: { accept: "application/json", ...capability },
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) return undefined;
        return decodeHostAnswer(NewDeviceAlertList)(await response.json());
      } catch {
        return undefined;
      }
    },
    dismiss: async (alertId) => {
      try {
        const response = await port.fetch(
          new URL(`${NEW_DEVICE_ALERTS_PATH}/dismiss`, port.baseUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json", ...capability },
            body: JSON.stringify({ alertId }),
          },
        );
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
