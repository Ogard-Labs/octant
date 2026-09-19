import {
  decodeSimulatorDeviceInputResult,
  type SimulatorDeviceInput,
  type SimulatorDeviceInputResult,
} from "@octant/contracts/simulator-device";

/** The desktop's native device helper, as the server reaches it. */
export interface DesktopSimulatorDevicePort {
  readonly deliver: (
    input: SimulatorDeviceInput,
    signal?: AbortSignal,
  ) => Promise<SimulatorDeviceInputResult>;
}

const PATH = "/v1/simulator-device";
const MAX_RESULT_BYTES = 64 * 1024;

/**
 * Present only when the desktop started this server and handed it a broker
 * address. A headless or remote host has none, and Simulator input there is
 * reported unavailable rather than guessed at.
 */
export function createDesktopSimulatorDevicePort(
  environment: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): DesktopSimulatorDevicePort | undefined {
  const endpoint = environment.OCTANT_SIMULATOR_DEVICE_BROKER_URL;
  const token = environment.OCTANT_SIMULATOR_DEVICE_BROKER_TOKEN;
  if (endpoint === undefined || token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return undefined;
  }
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== PATH ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
  } catch {
    return undefined;
  }
  return {
    deliver: async (input, signal) => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([
          AbortSignal.timeout(input.budgetMs),
          ...(signal === undefined ? [] : [signal]),
        ]),
        headers: {
          "content-type": "application/json",
          "x-octant-simulator-device-token": token,
        },
        body: JSON.stringify({ input }),
      });
      if (!response.ok) throw new Error("The desktop's Simulator device broker refused the call.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESULT_BYTES) {
        throw new Error("The Simulator device result exceeds its limit.");
      }
      return decodeSimulatorDeviceInputResult(JSON.parse(new TextDecoder().decode(bytes)));
    },
  };
}
