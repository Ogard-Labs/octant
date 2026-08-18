import {
  decodeArtifactMirrorResult,
  decodeArtifactMirrorSettings,
  type ArtifactMirrorCommand,
  type ArtifactMirrorResult,
  type ArtifactMirrorSettings,
} from "@octant/contracts/artifact-mirror";
import { bindFetchPort } from "./bindFetchPort";

export interface ArtifactMirrorClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class ArtifactMirrorClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ArtifactMirrorClientFailure";
    this.status = status;
  }
}

export interface ArtifactMirrorClient {
  settings(signal?: AbortSignal): Promise<ArtifactMirrorSettings>;
  execute(command: ArtifactMirrorCommand, signal?: AbortSignal): Promise<ArtifactMirrorResult>;
}

/**
 * Reads and changes where artifacts are mirrored.
 *
 * A refusal comes back as a decoded `mirror-refused` result rather than an
 * exception: "that folder has not been approved" is an answer the person should
 * read, not a transport failure.
 */
export function createArtifactMirrorClient(
  options: ArtifactMirrorClientOptions,
): ArtifactMirrorClient {
  const url = new URL("/api/artifacts/mirror", options.baseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new ArtifactMirrorClientFailure("Artifact mirror base URL must be loopback.", 0);
  }
  const fetch = bindFetchPort(options.fetch);

  const send = async (init: RequestInit, unavailable: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          "x-octant-window-capability": options.windowCapability,
        },
      });
    } catch {
      throw new ArtifactMirrorClientFailure(unavailable, 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ArtifactMirrorClientFailure(
        readString(body, "error") ?? unavailable,
        response.status,
      );
    }
    return body;
  };

  return {
    async settings(signal) {
      const body = await send(
        { method: "GET", ...(signal === undefined ? {} : { signal }) },
        "Artifact mirroring is unavailable.",
      );
      return decodeArtifactMirrorSettings(readField(body, "settings"));
    },

    async execute(command, signal) {
      const body = await send(
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "The artifact mirror command failed.",
      );
      return decodeArtifactMirrorResult(body);
    },
  };
}

function readField(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function readString(body: unknown, key: string): string | undefined {
  const value = readField(body, key);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
