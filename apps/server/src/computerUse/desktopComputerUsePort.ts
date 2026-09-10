import {
  decodeComputerControlResult,
  decodeComputerUseStatus,
  type ComputerControlCommand,
  type ComputerControlResult,
  type ComputerUseOwner,
  type ComputerUseSettings,
  type ComputerUseStatus,
} from "@octant/contracts/computer-use-plugin";

export interface DesktopComputerUsePort {
  readonly status: () => Promise<ComputerUseStatus>;
  readonly configure: (settings: ComputerUseSettings) => Promise<void>;
  readonly reserve: (owner: ComputerUseOwner) => Promise<boolean>;
  readonly execute: (
    owner: ComputerUseOwner,
    command: ComputerControlCommand,
    signal?: AbortSignal,
  ) => Promise<ComputerControlResult>;
  readonly release: (owner: ComputerUseOwner) => Promise<void>;
}

export function createDesktopComputerUsePort(
  environment: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch = fetch,
): DesktopComputerUsePort | undefined {
  const endpoint = environment.OCTANT_COMPUTER_USE_BROKER_URL;
  const token = environment.OCTANT_COMPUTER_USE_BROKER_TOKEN;
  if (endpoint === undefined || token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return undefined;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/v1/computer-use" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
  } catch {
    return undefined;
  }
  const brokerUrl = endpoint;
  const authorization = token;
  async function request(
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const combined = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(signal === undefined ? [] : [signal]),
    ]);
    const response = await fetchImpl(brokerUrl, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: combined,
      headers: { "content-type": "application/json", "x-octant-computer-use-token": authorization },
      body: JSON.stringify(body),
    });
    if (!response.ok || response.body === null)
      throw new Error("Computer-use desktop connection is unavailable.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > 8 * 1024 * 1024) throw new Error("Computer-use result exceeds its limit.");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  }
  return {
    status: async () => decodeComputerUseStatus(await request({ operation: "status" })),
    configure: async (settings) => {
      await request({ operation: "configure", settings });
    },
    reserve: async (owner) => {
      const value = await request({ operation: "reserve", owner });
      return (
        typeof value === "object" &&
        value !== null &&
        "reserved" in value &&
        value.reserved === true
      );
    },
    execute: async (owner, command, signal) =>
      decodeComputerControlResult(await request({ operation: "execute", owner, command }, signal)),
    release: async (owner) => {
      await request({ operation: "release", owner });
    },
  };
}
