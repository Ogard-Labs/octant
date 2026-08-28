import { randomBytes, randomUUID } from "node:crypto";
import {
  readBridgeSecretFile,
  readHostInfoFile,
  type BridgeSecretFileInput,
} from "./bridgeSecretFile";

export interface LocalControlRequest {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
}

export interface LocalControlResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface OpenedLocalControlSession {
  readonly kind: "opened";
  /** The identity the server issued this session's authority for. */
  readonly windowId: string;
  readonly send: (request: LocalControlRequest) => Promise<LocalControlResponse>;
  readonly close: () => Promise<void>;
}

export type LocalControlSession =
  | OpenedLocalControlSession
  | { readonly kind: "refuses"; readonly reason: string };

export interface OpenLocalControlSessionInput {
  readonly host: BridgeSecretFileInput;
  readonly fetch?: typeof fetch;
}

/**
 * Open one short-lived local administration session against a running server.
 *
 * The CLI is an ordinary loopback client: it presents the host's local secret,
 * registers its own window authority, and sends every product request under
 * that capability so the server keeps deciding authority before any side
 * effect. The authority is revoked when the command finishes.
 */
export async function openLocalControlSession(
  input: OpenLocalControlSessionInput,
): Promise<LocalControlSession> {
  const call = input.fetch ?? fetch;
  const secret = await readBridgeSecretFile(input.host);
  const info = await readHostInfoFile(input.host);
  if (secret === undefined || info === undefined) {
    return {
      kind: "refuses",
      reason: "Octant is not running on this host. Start it with `octant server start`.",
    };
  }
  const windowId = randomUUID();
  const capability = randomBytes(32).toString("base64url");
  const authorityUrl = new URL("/api/desktop/window-authorities", info.url).toString();
  const registration = await call(authorityUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-octant-desktop-secret": secret },
    body: JSON.stringify({ windowId, capability }),
  }).catch(() => undefined);
  if (registration === undefined || registration.status !== 204) {
    return { kind: "refuses", reason: "Octant refused this command's local authority." };
  }
  return {
    kind: "opened",
    windowId,
    send: async (request) => {
      // A server that stops answering mid-command is a refused request, not a
      // crash: the caller prints why the command did not run.
      const response = await call(new URL(request.path, info.url).toString(), {
        method: request.method,
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }).catch(() => undefined);
      if (response === undefined) {
        return {
          status: 0,
          body: { message: "Octant stopped answering on this host before the command finished." },
        };
      }
      return { status: response.status, body: await readBody(response).catch(() => undefined) };
    },
    close: async () => {
      try {
        await call(authorityUrl, {
          method: "DELETE",
          headers: { "content-type": "application/json", "x-octant-desktop-secret": secret },
          body: JSON.stringify({ windowId }),
        });
      } catch {
        // The authority expires on its own; a failed revocation is not a
        // reason to fail a command that already succeeded.
      }
    },
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function failureMessage(response: LocalControlResponse, fallback: string): string {
  const body = response.body;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return fallback;
}
