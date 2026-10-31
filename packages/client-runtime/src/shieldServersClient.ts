import { decodeHostAnswer } from "@octant/contracts";
import {
  type ShieldServersCommand,
  ShieldServersCommandResult,
  ShieldServersView,
} from "@octant/contracts/shield-servers";
import { bindFetchPort } from "./bindFetchPort";

/**
 * Settings › Servers: the servers a person registered with Octant Shield and
 * whether their SSH agent is there to use. A refused change is a value the
 * caller shows; only a transport failure throws.
 */

export interface ShieldServersClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ShieldServersClient {
  read(signal?: AbortSignal): Promise<ShieldServersView>;
  command(command: ShieldServersCommand, signal?: AbortSignal): Promise<ShieldServersCommandResult>;
}

export class ShieldServersClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ShieldServersClientFailure";
    this.status = status;
  }
}

const PATH = "/api/shield/servers";

export function createShieldServersClient(
  options: ShieldServersClientOptions,
): ShieldServersClient {
  const fetch = bindFetchPort(options.fetch);
  const target = new URL(PATH, options.baseUrl).toString();
  const send = async (init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(target, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
      });
    } catch {
      throw new ShieldServersClientFailure("Servers are unavailable.", 0);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ShieldServersClientFailure("The servers answer is malformed.", response.status);
    }
    const refusal =
      typeof body === "object" &&
      body !== null &&
      (body as { kind?: unknown }).kind === "shield-servers-refused";
    if (!response.ok && !refusal) {
      const message =
        typeof (body as { error?: unknown } | null)?.error === "string"
          ? (body as { error: string }).error
          : "The servers request failed.";
      throw new ShieldServersClientFailure(message, response.status);
    }
    return body;
  };
  return {
    async read(signal) {
      const body = await send({ method: "GET", ...(signal === undefined ? {} : { signal }) });
      return decodeHostAnswer(ShieldServersView)((body as { view?: unknown }).view);
    },
    async command(command, signal) {
      return decodeHostAnswer(ShieldServersCommandResult)(
        await send({
          method: "POST",
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    },
  };
}
