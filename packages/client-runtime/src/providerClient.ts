import {
  decodeProviderFailure,
  decodeProviderProbeResult,
  decodeProviderRegistryCommand,
  decodeProviderRegistryCommandResult,
  decodeProviderRegistrySnapshot,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderProbeResult,
  type ProviderRegistryCommand,
  type ProviderRegistryCommandResult,
  type ProviderRegistrySnapshot,
} from "@octant/contracts";

export interface ProviderClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ProviderClient {
  bootstrap(): Promise<ProviderRegistrySnapshot>;
  execute(command: ProviderRegistryCommand): Promise<ProviderRegistryCommandResult>;
  probe(instanceId: ProviderInstanceId): Promise<ProviderProbeResult>;
}

export class ProviderClientFailure extends Error {
  readonly category: ProviderFailure["category"];

  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderClientFailure";
    this.category = failure.category;
  }
}

export function createProviderClient(options: ProviderClientOptions): ProviderClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    bootstrap() {
      return request(
        options.fetch,
        new URL("/api/providers/bootstrap", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeProviderRegistrySnapshot,
      );
    },
    async execute(command) {
      let validated: ProviderRegistryCommand;
      try {
        validated = decodeProviderRegistryCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        options.fetch,
        new URL("/api/providers/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeProviderRegistryCommandResult,
      );
    },
    probe(instanceId) {
      return request(
        options.fetch,
        new URL(
          `/api/providers/${encodeURIComponent(instanceId)}/probe`,
          options.baseUrl,
        ).toString(),
        { method: "POST", headers },
        decodeProviderProbeResult,
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw unavailable();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw protocol();
  }
  if (!response.ok) {
    try {
      throw new ProviderClientFailure(decodeProviderFailure(body));
    } catch (error) {
      if (error instanceof ProviderClientFailure) throw error;
      throw protocol();
    }
  }
  try {
    return decode(body);
  } catch {
    throw protocol();
  }
}

function invalidCommand(): ProviderClientFailure {
  return new ProviderClientFailure({
    category: "protocol",
    message: "Provider command is invalid.",
  });
}

function unavailable(): ProviderClientFailure {
  return new ProviderClientFailure({
    category: "unavailable",
    message: "Octant Provider service is unavailable.",
  });
}

function protocol(): ProviderClientFailure {
  return new ProviderClientFailure({
    category: "protocol",
    message: "Provider service returned an invalid response.",
  });
}
