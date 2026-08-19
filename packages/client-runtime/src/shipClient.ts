import {
  decodeShipResult,
  type ShipCommand,
  type ShipResult,
  type ShipTarget,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ShipClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ShipClient {
  targets(signal?: AbortSignal): Promise<ReadonlyArray<ShipTarget>>;
  execute(command: ShipCommand, signal?: AbortSignal): Promise<ShipResult>;
}

export class ShipClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ShipClientFailure";
    this.status = status;
  }
}

/**
 * Client for the host's publication surface.
 *
 * The host decides everything: which targets exist, whether this build may be
 * published, and what a refusal says. A refusal arrives as a typed result
 * rather than an exception, because "that approval was for something else" is
 * something a person reads.
 */
export function createShipClient(options: ShipClientOptions): ShipClient {
  const fetch = bindFetchPort(options.fetch);

  return {
    async targets(signal) {
      const body = await send(
        fetch,
        new URL("/api/ship/targets", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Ship targets are unavailable.",
      );
      const result = decodeShipResult({
        kind: "ship-targets",
        targets: (body as { targets?: unknown }).targets ?? [],
      });
      return result.kind === "ship-targets" ? result.targets : [];
    },

    async execute(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/ship/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Ship command failed.",
      );
      return decodeShipResult(body);
    },
  };
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  unavailableMessage: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ShipClientFailure(unavailableMessage, 0);
  }
  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message = (body as { error?: unknown }).error;
    throw new ShipClientFailure(
      typeof message === "string" ? message : unavailableMessage,
      response.status,
    );
  }
  return body;
}
