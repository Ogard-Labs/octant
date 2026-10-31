import { decodeHostAnswer } from "@octant/contracts";
import {
  type SafeNetworksCommand,
  SafeNetworksCommandResult,
  SafeNetworksView,
} from "@octant/contracts/safe-networks";
import { bindFetchPort } from "./bindFetchPort";

/**
 * Settings › Access › Safe networks: the places a person trusts for the
 * account and for one Project, and the hosts that Project's runtimes were
 * recently refused. A refused change is a value the caller shows; only a
 * transport failure throws.
 */

export interface SafeNetworksClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface SafeNetworksClient {
  read(projectId?: string, signal?: AbortSignal): Promise<SafeNetworksView>;
  command(
    command: SafeNetworksCommand,
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<SafeNetworksCommandResult>;
}

export class SafeNetworksClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SafeNetworksClientFailure";
    this.status = status;
  }
}

const PATH = "/api/access/safe-networks";

export function createSafeNetworksClient(options: SafeNetworksClientOptions): SafeNetworksClient {
  const fetch = bindFetchPort(options.fetch);
  const url = (projectId: string | undefined) => {
    const target = new URL(PATH, options.baseUrl);
    if (projectId !== undefined) target.searchParams.set("projectId", projectId);
    return target.toString();
  };
  const send = async (target: string, init: RequestInit): Promise<unknown> => {
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
      throw new SafeNetworksClientFailure("Safe networks are unavailable.", 0);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SafeNetworksClientFailure(
        "The safe networks answer is malformed.",
        response.status,
      );
    }
    const refusal =
      typeof body === "object" &&
      body !== null &&
      (body as { kind?: unknown }).kind === "safe-networks-refused";
    if (!response.ok && !refusal) {
      const message =
        typeof (body as { error?: unknown } | null)?.error === "string"
          ? (body as { error: string }).error
          : "The safe networks request failed.";
      throw new SafeNetworksClientFailure(message, response.status);
    }
    return body;
  };
  return {
    async read(projectId, signal) {
      const body = await send(url(projectId), {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeHostAnswer(SafeNetworksView)((body as { view?: unknown }).view);
    },
    async command(command, projectId, signal) {
      return decodeHostAnswer(SafeNetworksCommandResult)(
        await send(url(projectId), {
          method: "POST",
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    },
  };
}
