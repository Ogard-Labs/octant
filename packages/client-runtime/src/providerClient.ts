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
  readonly reason?: ProviderFailure["reason"];
  readonly diagnostic?: ProviderFailure["diagnostic"];

  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderClientFailure";
    this.category = failure.category;
    if (failure.reason !== undefined) this.reason = failure.reason;
    if (failure.diagnostic !== undefined) this.diagnostic = failure.diagnostic;
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
        "bootstrap",
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
        "command",
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
        "probe",
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
  operation: ProviderClientOperation,
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
    reportDecodeFailure(operation, response.status, "json", undefined);
    throw protocol();
  }
  if (!response.ok) {
    let failure: ProviderFailure;
    try {
      failure = decodeProviderFailure(body);
    } catch (error) {
      reportDecodeFailure(operation, response.status, "failure-body", error);
      throw protocol();
    }
    throw new ProviderClientFailure(failure);
  }
  try {
    return decode(body);
  } catch (error) {
    reportDecodeFailure(operation, response.status, "success-body", error);
    throw protocol();
  }
}

type ProviderClientOperation = "bootstrap" | "command" | "probe";

/**
 * Name what failed to decode. The person still sees the generic invalid
 * response message, but a shape mismatch between server and client was
 * otherwise silent: Check connection on a ChatGPT plan endpoint showed
 * "Provider returned an invalid response." with nothing in any log to say
 * which side or which field. Only schema paths and issue kinds are logged,
 * never a decoded value, so no credential or message text can leak.
 */
function reportDecodeFailure(
  operation: ProviderClientOperation,
  httpStatus: number,
  stage: "json" | "failure-body" | "success-body",
  error: unknown,
): void {
  console.warn("[provider-client] could not decode the provider service response", {
    operation,
    httpStatus,
    stage,
    issues: decodeIssuePaths(error),
  });
}

function decodeIssuePaths(error: unknown): ReadonlyArray<string> {
  const found = new Set<string>();
  const walk = (issue: unknown, path: ReadonlyArray<string>): void => {
    if (found.size >= 8 || typeof issue !== "object" || issue === null) return;
    const node = issue as {
      readonly _tag?: unknown;
      readonly path?: unknown;
      readonly issue?: unknown;
      readonly issues?: unknown;
    };
    if (node._tag === "Pointer") {
      const segments = Array.isArray(node.path) ? node.path : [node.path];
      walk(node.issue, [...path, ...segments.map(String)]);
      return;
    }
    const children =
      node.issues !== undefined
        ? Array.isArray(node.issues)
          ? node.issues
          : [node.issues]
        : node.issue !== undefined
          ? [node.issue]
          : [];
    if (children.length === 0) {
      found.add(`${path.length === 0 ? "(root)" : path.join(".")}: ${String(node._tag)}`);
      return;
    }
    for (const child of children) walk(child, path);
  };
  if (typeof error === "object" && error !== null && "issue" in error) walk(error.issue, []);
  return [...found];
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
