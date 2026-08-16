import {
  decodeNavigatorAssistantCommandResult,
  decodeNavigatorAssistantSnapshot,
  type NavigatorAssistantCommand,
  type NavigatorAssistantCommandResult,
  type NavigatorAssistantSnapshot,
  type SettingsDeepLink,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface NavigatorAssistantClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface NavigatorAssistantClient {
  snapshot(signal?: AbortSignal): Promise<NavigatorAssistantSnapshot>;
  execute(
    command: NavigatorAssistantCommand,
    signal?: AbortSignal,
  ): Promise<NavigatorAssistantCommandResult>;
}

/**
 * A Navigator request the host refused, carrying the host's own category and —
 * when the fix is a setting — the exact Settings destination, so the surface
 * offers that fix instead of re-deriving Navigator policy in the renderer.
 */
export class NavigatorAssistantClientFailure extends Error {
  readonly status: number;
  readonly category: "unconfigured" | "invalid" | "conflict" | "unavailable" | "unknown";
  readonly settingsTarget: SettingsDeepLink | undefined;

  constructor(
    message: string,
    status: number,
    category: NavigatorAssistantClientFailure["category"] = "unknown",
    settingsTarget?: SettingsDeepLink,
  ) {
    super(message);
    this.name = "NavigatorAssistantClientFailure";
    this.status = status;
    this.category = category;
    this.settingsTarget = settingsTarget;
  }
}

/**
 * Client for the host-owned Navigator surface.
 *
 * The host owns readiness, the bound conversation, and the model every turn
 * runs on; this client only carries the window capability and decodes the
 * host's typed answer before returning it, so a renderer can never render a
 * Navigator state the host did not report.
 */
export function createNavigatorAssistantClient(
  options: NavigatorAssistantClientOptions,
): NavigatorAssistantClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async snapshot(signal) {
      const body = await send(
        fetch,
        new URL("/api/navigator-assistant/snapshot", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Navigator is unavailable.",
      );
      return decodeNavigatorAssistantSnapshot(body);
    },

    async execute(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/navigator-assistant/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Navigator command failed.",
      );
      return decodeNavigatorAssistantCommandResult(body);
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
    throw new NavigatorAssistantClientFailure(unavailableMessage, 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new NavigatorAssistantClientFailure(
      readString(body, "error") ?? readString(body, "message") ?? unavailableMessage,
      response.status,
      readCategory(body),
      readSettingsTarget(body),
    );
  }
  return body;
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readCategory(body: unknown): NavigatorAssistantClientFailure["category"] {
  const category = readString(body, "category");
  return category === "unconfigured" ||
    category === "invalid" ||
    category === "conflict" ||
    category === "unavailable"
    ? category
    : "unknown";
}

/**
 * The deep link is decoded, not trusted: a malformed target would otherwise
 * become a Settings navigation to nowhere. An absent or invalid target simply
 * leaves the failure without one.
 */
function readSettingsTarget(body: unknown): SettingsDeepLink | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const target = (body as { readonly settingsTarget?: unknown }).settingsTarget;
  if (typeof target !== "object" || target === null) return undefined;
  const section = readString(target, "section");
  if (section === undefined) return undefined;
  const setting = readString(target, "setting");
  return {
    section,
    ...(setting === undefined ? {} : { setting }),
  } as SettingsDeepLink;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new NavigatorAssistantClientFailure("Navigator base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new NavigatorAssistantClientFailure("Navigator base URL must be loopback.", 0);
  }
}
