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

/** The desktop's serve-avd broker, as the server reaches it. */
export interface ServeAvdPort {
  open(serial: string, signal?: AbortSignal): Promise<ServeAvdAttachment | undefined>;
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
    open: async (serial, signal) => {
      if (!SERIAL.test(serial)) return undefined;
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
          body: JSON.stringify({ serial }),
        });
      } catch {
        return undefined;
      }
      if (!response.ok) return undefined;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return undefined;
      }
      if (
        !isRecord(body) ||
        typeof body.origin !== "string" ||
        typeof body.streamUrl !== "string"
      ) {
        return undefined;
      }
      return readManagedDeviceEndpoint(
        JSON.stringify({ device: serial, url: body.origin, streamUrl: body.streamUrl }),
        serial,
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
