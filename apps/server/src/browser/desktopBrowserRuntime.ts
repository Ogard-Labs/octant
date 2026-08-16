import type {
  BrowserActionRequest,
  BrowserContextId,
  BrowserContextPolicy,
  BrowserThreadId,
} from "@octant/contracts/browser-automation";
import type { WindowId } from "@octant/contracts/shell";
import {
  BrowserNavigationBlockedError,
  type BrowserRuntimeObservation,
  type BrowserRuntimePort,
  type BrowserTargetInspection,
} from "./browserRuntimePort";

const TOKEN_HEADER = "x-octant-browser-broker-token";

export interface DesktopBrowserRuntimeOptions {
  readonly brokerUrl: string;
  readonly token: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly eventPollIntervalMs?: number;
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
  }

  async available(): Promise<boolean> {
    try {
      await this.#request("/v1/available", {});
      return true;
    } catch {
      return false;
    }
  }

  async createContext(
    contextId: BrowserContextId,
    policy: BrowserContextPolicy,
    signal: AbortSignal,
    owner: { readonly windowId: WindowId; readonly threadId: BrowserThreadId },
  ): Promise<"native-live"> {
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

  act(
    contextId: BrowserContextId,
    request: BrowserActionRequest,
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
): DesktopBrowserRuntime | undefined {
  const brokerUrl = env.OCTANT_BROWSER_BROKER_URL;
  const token = env.OCTANT_BROWSER_BROKER_TOKEN;
  if (brokerUrl === undefined || token === undefined) return undefined;
  return new DesktopBrowserRuntime({ brokerUrl, token });
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
