import { isCanonicalLaunchSessionToken } from "@octant/contracts/launch-session";
import { decodeWindowId, type WindowId } from "@octant/contracts/shell";
import { useCallback, useEffect, useRef, useState } from "react";

export type LaunchSessionStatus = "idle" | "loading" | "ready" | "failed";

export interface LaunchSessionResult {
  readonly status: LaunchSessionStatus;
  readonly capability?: string;
  readonly windowId?: WindowId;
  readonly failureMessage?: string;
  readonly authentication?: "launch-token" | "local-session";
  readonly renew?: () => Promise<void>;
}

export interface UseLaunchSessionOptions {
  readonly serverUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly href?: string;
  readonly onExchanged?: () => void;
  readonly storage?: LaunchSessionStorage;
  /** Stable for one browser tab; copied session storage must not merge two tabs. */
  readonly clientContextId?: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const STORAGE_KEY_PREFIX = "octant:launch-session:";
const LAUNCH_REQUEST_TIMEOUT_MS = 15_000;
const WINDOW_NAME_PREFIX = "octant-client-context:";
const launchExchanges = new Map<
  string,
  Promise<{ readonly status: number; readonly body: unknown }>
>();

export interface LaunchSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): LaunchSessionStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function readStoredAuthority(
  storage: LaunchSessionStorage | undefined,
  serverUrl: string,
  clientContextId: string,
):
  | {
      capability: string;
      windowId: WindowId;
      authentication: "launch-token" | "local-session";
    }
  | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(STORAGE_KEY_PREFIX + serverUrl);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as {
      capability?: string;
      windowId?: string;
      authentication?: string;
      clientContextId?: string;
    };
    const capability = parsed.capability;
    if (capability === undefined || !isCanonicalLaunchSessionToken(capability)) return undefined;
    if (typeof parsed.windowId !== "string") return undefined;
    if (parsed.clientContextId !== clientContextId) return undefined;
    try {
      return {
        capability,
        windowId: decodeWindowId(parsed.windowId),
        authentication:
          parsed.authentication === "local-session" ? "local-session" : "launch-token",
      };
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

function writeStoredAuthority(
  storage: LaunchSessionStorage | undefined,
  serverUrl: string,
  capability: string,
  windowId: WindowId,
  authentication: "launch-token" | "local-session",
  clientContextId: string,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(
      STORAGE_KEY_PREFIX + serverUrl,
      JSON.stringify({ capability, windowId, authentication, clientContextId }),
    );
  } catch {
    // best-effort persistence
  }
}

function defaultClientContextId(): string {
  const current = window.name;
  if (current.startsWith(WINDOW_NAME_PREFIX)) {
    const value = current.slice(WINDOW_NAME_PREFIX.length);
    if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  }
  const created = globalThis.crypto.randomUUID();
  window.name = `${WINDOW_NAME_PREFIX}${created}`;
  return created;
}

export function readLaunchTokenFromHref(href: string): string | undefined {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return undefined;
  const params = new URLSearchParams(href.slice(hashIndex + 1));
  const token = params.get("launchToken");
  if (token === null || !TOKEN_PATTERN.test(token)) return undefined;
  return token;
}

function exchangeLaunchToken(
  fetch: typeof globalThis.fetch,
  serverUrl: string,
  launchToken: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const endpoint = new URL("/api/shell/launch-session", serverUrl);
  const key = `${endpoint.toString()}#${launchToken}`;
  return sharedExchange(key, fetch, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ launchToken }),
  });
}

function exchangeLocalSession(
  fetch: typeof globalThis.fetch,
  serverUrl: string,
  previous?: {
    readonly capability: string;
    readonly windowId: WindowId;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const endpoint = new URL("/api/shell/local-session", serverUrl);
  const body = JSON.stringify(
    previous === undefined
      ? {}
      : { windowId: String(previous.windowId), capability: previous.capability },
  );
  return sharedExchange(
    `${endpoint.toString()}#local:${previous?.capability ?? "fresh"}`,
    fetch,
    endpoint,
    { method: "POST", headers: { "content-type": "application/json" }, body },
  );
}

function decodeLocalSessionAuthority(
  value: unknown,
): { readonly windowId: WindowId; readonly capability: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("capability" in value) || !isCanonicalLaunchSessionToken(value.capability)) {
    return undefined;
  }
  if (!("authentication" in value) || value.authentication !== "local-session") {
    return undefined;
  }
  if (!("windowId" in value) || typeof value.windowId !== "string") return undefined;
  try {
    return { windowId: decodeWindowId(value.windowId), capability: value.capability };
  } catch {
    return undefined;
  }
}

function sharedExchange(
  key: string,
  fetch: typeof globalThis.fetch,
  endpoint: URL,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const existing = launchExchanges.get(key);
  if (existing !== undefined) return existing;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Launch session request timed out."));
    }, LAUNCH_REQUEST_TIMEOUT_MS);
  });
  const request = fetch(endpoint, { ...init, signal: controller.signal }).then(
    async (response) => ({
      status: response.status,
      body: response.status === 200 ? await response.json() : undefined,
    }),
  );
  const exchange = Promise.race([request, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  launchExchanges.set(key, exchange);
  void exchange
    .finally(() => {
      queueMicrotask(() => {
        if (launchExchanges.get(key) === exchange) launchExchanges.delete(key);
      });
    })
    .catch(() => undefined);
  return exchange;
}

export function useLaunchSession(options: UseLaunchSessionOptions): LaunchSessionResult {
  const [result, setResult] = useState<LaunchSessionResult>({ status: "idle" });
  const [defaultContextId] = useState(defaultClientContextId);
  const clientContextId = options.clientContextId ?? defaultContextId;
  const renewalRef = useRef<Promise<void> | undefined>(undefined);

  const renew = useCallback((): Promise<void> => {
    const existing = renewalRef.current;
    if (existing !== undefined) return existing;
    const serverUrl = options.serverUrl;
    if (serverUrl === undefined)
      return Promise.reject(new Error("Local Machine URL is unavailable."));
    const storage = options.storage ?? defaultStorage();
    const fetch = options.fetch ?? globalThis.fetch;
    const stored = readStoredAuthority(storage, serverUrl, clientContextId);
    const reusable = stored?.authentication === "local-session" ? stored : undefined;
    const renewal = (async () => {
      const response = await exchangeLocalSession(fetch, serverUrl, reusable);
      if (response.status !== 200) throw new Error("Local Machine access is unavailable.");
      const authority = decodeLocalSessionAuthority(response.body);
      if (authority === undefined) throw new Error("Local Machine response is invalid.");
      writeStoredAuthority(
        storage,
        serverUrl,
        authority.capability,
        authority.windowId,
        "local-session",
        clientContextId,
      );
      setResult({
        status: "ready",
        capability: authority.capability,
        windowId: authority.windowId,
        authentication: "local-session",
      });
    })();
    renewalRef.current = renewal;
    void renewal
      .finally(() => {
        if (renewalRef.current === renewal) renewalRef.current = undefined;
      })
      .catch(() => undefined);
    return renewal;
  }, [clientContextId, options.fetch, options.serverUrl, options.storage]);

  useEffect(() => {
    const href = options.href ?? window.location.href;
    const launchToken = readLaunchTokenFromHref(href);
    const serverUrl = options.serverUrl;
    const storage = options.storage ?? defaultStorage();
    if (serverUrl === undefined) {
      setResult({ status: "idle" });
      return;
    }
    if (launchToken === undefined) {
      const stored = readStoredAuthority(storage, serverUrl, clientContextId);
      const fetch = options.fetch ?? globalThis.fetch;
      let cancelled = false;
      setResult({ status: "loading" });
      void (async () => {
        try {
          const reusable = stored?.authentication === "local-session" ? stored : undefined;
          const response = await exchangeLocalSession(fetch, serverUrl, reusable);
          if (cancelled) return;
          if (response.status !== 200) {
            setResult({
              status: "failed",
              failureMessage: "Local Machine access is unavailable.",
            });
            return;
          }
          const authority = decodeLocalSessionAuthority(response.body);
          if (cancelled || authority === undefined) {
            if (!cancelled) {
              setResult({
                status: "failed",
                failureMessage: "Local Machine response is invalid.",
              });
            }
            return;
          }
          writeStoredAuthority(
            storage,
            serverUrl,
            authority.capability,
            authority.windowId,
            "local-session",
            clientContextId,
          );
          setResult({
            status: "ready",
            capability: authority.capability,
            windowId: authority.windowId,
            authentication: "local-session",
          });
        } catch {
          if (!cancelled) {
            setResult({
              status: "failed",
              failureMessage: "Octant could not establish local Machine access.",
            });
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    const fetch = options.fetch ?? globalThis.fetch;
    let cancelled = false;
    setResult({ status: "loading" });
    void (async () => {
      try {
        const response = await exchangeLaunchToken(fetch, serverUrl, launchToken);
        if (cancelled) return;
        if (response.status !== 200) {
          setResult({
            status: "failed",
            failureMessage: "Octant launch session is invalid or expired.",
          });
          return;
        }
        const body = response.body as { windowId: string; capability: string };
        if (cancelled) return;
        if (!isCanonicalLaunchSessionToken(body.capability)) {
          setResult({ status: "failed", failureMessage: "Octant launch session is invalid." });
          return;
        }
        let windowId: WindowId;
        try {
          windowId = decodeWindowId(body.windowId);
        } catch {
          setResult({ status: "failed", failureMessage: "Octant launch session is invalid." });
          return;
        }
        writeStoredAuthority(
          storage,
          serverUrl,
          body.capability,
          windowId,
          "launch-token",
          clientContextId,
        );
        setResult({
          status: "ready",
          capability: body.capability,
          windowId,
          authentication: "launch-token",
        });
        options.onExchanged?.();
      } catch {
        if (!cancelled) {
          setResult({
            status: "failed",
            failureMessage: "Octant could not reach its launch session service.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientContextId, options.serverUrl, options.href, options.storage]);

  return result.authentication === "local-session" ? { ...result, renew } : result;
}
