import { storedBrowserProfile } from "@octant/domain";
import type { StoredBrowserProfile } from "@octant/contracts/browser-profiles";
import type {
  BrowserContextId,
  BrowserContextPolicy,
  BrowserThreadId,
} from "@octant/contracts/browser-automation";
import type { WindowId } from "@octant/contracts/shell";
import { decodeStoredBrowserProfile } from "@octant/contracts/browser-profiles";
import {
  BrowserNavigationBlockedError,
  type BrowserProfileStorePort,
  type BrowserRuntimeObservation,
  type BrowserRuntimePort,
  type BrowserRuntimeAction,
  type BrowserTargetInspection,
} from "./browserRuntimePort";

const TOKEN_HEADER = "x-octant-browser-broker-token";

export interface DesktopBrowserRuntimeOptions {
  readonly brokerUrl: string;
  readonly token: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly eventPollIntervalMs?: number;
  /**
   * The extensions enabled in a stored profile. Electron keeps a loaded extension
   * for the life of the app only, so a page opening in a profile first makes the
   * session's extensions match this list.
   */
  readonly extensionsFor?: (profile: StoredBrowserProfile) => ReadonlyArray<{
    readonly id: string;
    readonly path: string;
    readonly contentHash: string;
  }>;
}

export class DesktopBrowserOwnerUnavailable extends Error {
  constructor() {
    super("Octant desktop Browser owner is unavailable.");
    this.name = "DesktopBrowserOwnerUnavailable";
  }
}

export class DesktopBrowserRuntime implements BrowserRuntimePort {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #eventPollIntervalMs: number;
  readonly #extensionsFor: DesktopBrowserRuntimeOptions["extensionsFor"];
  readonly #exitListeners = new Set<(contextIds?: ReadonlyArray<BrowserContextId>) => void>();
  #eventPoll: ReturnType<typeof setInterval> | undefined;

  constructor(options: DesktopBrowserRuntimeOptions) {
    const url = new URL(options.brokerUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new Error("Octant desktop Browser broker must use loopback HTTP.");
    }
    this.#url = url.toString();
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#eventPollIntervalMs = options.eventPollIntervalMs ?? 250;
    this.#extensionsFor = options.extensionsFor;
  }

  async available(): Promise<boolean> {
    try {
      await this.#request("/v1/available", {});
      return true;
    } catch {
      return false;
    }
  }

  nativeAvailable(): Promise<boolean> {
    return this.available();
  }

  readonly profiles: BrowserProfileStorePort = {
    list: async () => {
      const payload = await this.#request<unknown>("/v1/profiles/list", {});
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("profiles" in payload) ||
        !Array.isArray(payload.profiles)
      ) {
        throw new Error("Octant desktop Browser broker rejected the request.");
      }
      return payload.profiles.flatMap((entry: unknown) => {
        try {
          const row = entry as { profile: unknown; sizeBytes: unknown };
          const profile = decodeStoredBrowserProfile(row.profile);
          return typeof row.sizeBytes === "number" && Number.isInteger(row.sizeBytes)
            ? [{ profile, sizeBytes: Math.max(0, row.sizeBytes) }]
            : [];
        } catch {
          return [];
        }
      });
    },
    clear: async (profile, scope) => {
      await this.#request("/v1/profiles/clear", { profile, scope });
    },
    syncExtensions: async (profile, extensions) => {
      await this.#request("/v1/extensions/sync", { profile, extensions });
    },
  };

  async createContext(
    contextId: BrowserContextId,
    policy: BrowserContextPolicy,
    signal: AbortSignal,
    owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId },
  ): Promise<"native-live"> {
    const stored = storedBrowserProfile(policy.profile);
    if (stored !== undefined && this.#extensionsFor !== undefined) {
      // A page that cannot get its extensions still opens: the journal says what
      // is enabled, and the next sync makes the session match.
      await this.profiles
        .syncExtensions(stored, this.#extensionsFor(stored))
        .catch(() => undefined);
    }
    await this.#request("/v1/contexts/create", { contextId, policy, owner }, signal);
    return "native-live";
  }

  inspectTarget(
    contextId: BrowserContextId,
    selector: string,
    signal: AbortSignal,
  ): Promise<BrowserTargetInspection> {
    return this.#request("/v1/contexts/inspect-target", { contextId, selector }, signal);
  }

  peek(contextId: BrowserContextId, signal: AbortSignal): Promise<BrowserRuntimeObservation> {
    return this.#request("/v1/contexts/peek", { contextId }, signal);
  }

  act(
    contextId: BrowserContextId,
    request: BrowserRuntimeAction,
    signal: AbortSignal,
  ): Promise<BrowserRuntimeObservation> {
    return this.#request(
      "/v1/contexts/act",
      {
        contextId,
        request: {
          kind: request.kind,
          ...(request.target === undefined ? {} : { target: request.target }),
          ...(request.value === undefined ? {} : { value: request.value }),
          ...(request.point === undefined ? {} : { point: request.point }),
          ...(request.deltaX === undefined ? {} : { deltaX: request.deltaX }),
          ...(request.deltaY === undefined ? {} : { deltaY: request.deltaY }),
        },
      },
      signal,
    );
  }

  async closeContext(contextId: BrowserContextId): Promise<void> {
    await this.#request("/v1/contexts/close", { contextId });
  }

  async closeAll(): Promise<void> {
    await this.#request("/v1/contexts/close-all", {});
  }

  onProcessExit(listener: (contextIds?: ReadonlyArray<BrowserContextId>) => void): () => void {
    this.#exitListeners.add(listener);
    this.#eventPoll ??= setInterval(() => void this.#pollGoneContexts(), this.#eventPollIntervalMs);
    this.#eventPoll.unref?.();
    return () => {
      this.#exitListeners.delete(listener);
      if (this.#exitListeners.size === 0 && this.#eventPoll !== undefined) {
        clearInterval(this.#eventPoll);
        this.#eventPoll = undefined;
      }
    };
  }

  async #pollGoneContexts(): Promise<void> {
    try {
      const payload = await this.#request<unknown>("/v1/contexts/gone", {});
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("contextIds" in payload) ||
        !Array.isArray(payload.contextIds)
      ) {
        return;
      }
      const contextIds = payload.contextIds.filter(
        (value): value is BrowserContextId =>
          typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
      );
      if (contextIds.length === 0) return;
      for (const listener of this.#exitListeners) listener(contextIds);
    } catch {
      // The broker may be stopping. Ordinary availability checks own recovery.
    }
  }

  async #request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetch(new URL(path, this.#url).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: this.#token },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 409) throw new DesktopBrowserOwnerUnavailable();
    if (response.status === 422) {
      const blocked = await navigationBlockedUrl(response);
      if (blocked !== undefined) throw new BrowserNavigationBlockedError(blocked);
    }
    if (!response.ok) throw new Error("Octant desktop Browser broker rejected the request.");
    return (await response.json()) as T;
  }
}

export function createDesktopBrowserRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv,
  extra: Pick<DesktopBrowserRuntimeOptions, "extensionsFor"> = {},
): DesktopBrowserRuntime | undefined {
  const brokerUrl = env.OCTANT_BROWSER_BROKER_URL;
  const token = env.OCTANT_BROWSER_BROKER_TOKEN;
  if (brokerUrl === undefined || token === undefined) return undefined;
  return new DesktopBrowserRuntime({ brokerUrl, token, ...extra });
}

async function navigationBlockedUrl(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      payload.error === "navigation-blocked" &&
      "url" in payload &&
      typeof payload.url === "string"
    ) {
      return payload.url;
    }
  } catch {
    // Not the structured refusal; fall through to the generic broker error.
  }
  return undefined;
}
