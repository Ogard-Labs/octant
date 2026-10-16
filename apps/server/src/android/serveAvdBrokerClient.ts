import type { AndroidScreenFallbackReason } from "@octant/contracts/android-toolchain-rpc";
import { readManagedDeviceEndpoint } from "@octant/domain/managed-device-stream";

const PATH = "/v1/managed-device/serve-avd";
const HEADER = "x-octant-managed-device-token";
const SERIAL = /^emulator-[0-9]+$/;

/** Narrower than `typeof fetch` so a test double does not need `fetch.preconnect`. */
type LoopbackFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ServeAvdAttachment {
  readonly origin: string;
  readonly streamUrl: string;
}

export type ServeAvdOpening =
  | { readonly status: "attached"; readonly attachment: ServeAvdAttachment }
  | {
      readonly status: "unavailable";
      readonly reason: Extract<
        AndroidScreenFallbackReason,
        "not-emulator" | "tool-missing" | "tool-exited" | "timed-out" | "desktop-unreachable"
      >;
    };

/** The desktop's serve-avd broker, as the server reaches it. */
export interface ServeAvdPort {
  /** `sdkRoot` is the SDK whose adb the server runs; serve-avd uses the same one. */
  open(
    serial: string,
    options?: { readonly sdkRoot?: string; readonly signal?: AbortSignal },
  ): Promise<ServeAvdOpening>;
  /**
   * Stops the tool attached to `serial`. Called when the emulator has stopped:
   * the tool is keyed by serial and does not exit with its emulator, so one left
   * running would answer for the next emulator that takes the serial.
   */
  release(serial: string): Promise<void>;
}

/**
 * Present only when the desktop started this server and handed it a broker
 * address. A headless host has none, and the Android pane keeps using adb.
 */
export function serveAvdFromEnvironment(
  environment: NodeJS.ProcessEnv,
  fetchImpl: LoopbackFetch = fetch,
): ServeAvdPort | undefined {
  const endpoint = environment.OCTANT_SERVE_AVD_BROKER_URL;
  const token = environment.OCTANT_SERVE_AVD_BROKER_TOKEN;
  if (endpoint === undefined || token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return {
    release: async (serial) => {
      if (!SERIAL.test(serial)) return;
      try {
        await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          headers: { "content-type": "application/json", [HEADER]: token },
          body: JSON.stringify({ serial, release: true }),
        });
      } catch {
        // The desktop is gone, and its tools went with it.
      }
    },
    open: async (serial, options = {}) => {
      if (!SERIAL.test(serial)) return { status: "unavailable", reason: "not-emulator" };
      const { sdkRoot, signal } = options;
      const unreachable = { status: "unavailable", reason: "desktop-unreachable" } as const;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          ...(signal === undefined ? {} : { signal }),
          headers: {
            "content-type": "application/json",
            [HEADER]: token,
          },
          body: JSON.stringify(sdkRoot === undefined ? { serial } : { serial, sdkRoot }),
        });
      } catch {
        return unreachable;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return unreachable;
      }
      if (!response.ok) {
        const reason = response.status === 503 && isRecord(body) ? body.reason : undefined;
        return reason === "tool-missing" || reason === "tool-exited" || reason === "timed-out"
          ? { status: "unavailable", reason }
          : unreachable;
      }
      if (
        !isRecord(body) ||
        typeof body.origin !== "string" ||
        typeof body.streamUrl !== "string"
      ) {
        return unreachable;
      }
      const attachment = readManagedDeviceEndpoint(
        JSON.stringify({ device: serial, url: body.origin, streamUrl: body.streamUrl }),
        serial,
      );
      return attachment === undefined ? unreachable : { status: "attached", attachment };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
