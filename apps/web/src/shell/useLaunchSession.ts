import { isCanonicalLaunchSessionToken } from "@octant/contracts/launch-session";
import { decodeWindowId, type WindowId } from "@octant/contracts/shell";
import { useEffect, useState } from "react";

export type LaunchSessionStatus = "idle" | "loading" | "ready" | "failed";

export interface LaunchSessionResult {
  readonly status: LaunchSessionStatus;
  readonly capability?: string;
  readonly windowId?: WindowId;
  readonly failureMessage?: string;
  readonly authentication?: "launch-token" | "development-bypass";
}

export interface UseLaunchSessionOptions {
  readonly serverUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly href?: string;
  readonly onExchanged?: () => void;
  readonly storage?: LaunchSessionStorage;
  readonly allowDevelopmentBootstrap?: boolean;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const STORAGE_KEY_PREFIX = "octant:launch-session:";
const LAUNCH_REQUEST_TIMEOUT_MS = 15_000;
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
):
  | {
      capability: string;
      windowId: WindowId;
      authentication: "launch-token" | "development-bypass";
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
    };
    const capability = parsed.capability;
    if (capability === undefined || !isCanonicalLaunchSessionToken(capability)) return undefined;
    if (typeof parsed.windowId !== "string") return undefined;
    try {
      return {
        capability,
        windowId: decodeWindowId(parsed.windowId),
        authentication:
          parsed.authentication === "development-bypass" ? "development-bypass" : "launch-token",
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
  authentication: "launch-token" | "development-bypass",
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(
      STORAGE_KEY_PREFIX + serverUrl,
      JSON.stringify({ capability, windowId, authentication }),
    );
  } catch {
    // best-effort persistence
  }
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

function exchangeDevelopmentSession(
  fetch: typeof globalThis.fetch,
  serverUrl: string,
  previous?: {
    readonly capability: string;
    readonly windowId: WindowId;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const endpoint = new URL("/api/shell/development-session", serverUrl);
  const body = JSON.stringify(
    previous === undefined
      ? {}
      : { windowId: String(previous.windowId), capability: previous.capability },
  );
  return sharedExchange(
    `${endpoint.toString()}#development:${previous?.capability ?? "fresh"}`,
    fetch,
    endpoint,
    { method: "POST", headers: { "content-type": "application/json" }, body },
  );
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
      const stored = readStoredAuthority(storage, serverUrl);
      // Development capabilities belong to one host process. Thread and
      // Project history survives a dev-host restart, but the previous
      // capability intentionally does not, so the token-free development URL
      // must ask the current host for fresh window authority on every page
      // load instead of restoring sessionStorage first.
      if (options.allowDevelopmentBootstrap === true) {
        const fetch = options.fetch ?? globalThis.fetch;
        let cancelled = false;
        setResult({ status: "loading" });
        void (async () => {
          try {
            const reusable = stored?.authentication === "development-bypass" ? stored : undefined;
            const response = await exchangeDevelopmentSession(fetch, serverUrl, reusable);
            if (cancelled) return;
            if (response.status !== 200) {
              setResult({
                status: "failed",
                failureMessage:
                  "Development authentication is unavailable. Restart with `octant web --dev`.",
              });
              return;
            }
            const body = response.body as {
              windowId: string;
              capability: string;
              authentication?: string;
            };
            if (
              cancelled ||
              !isCanonicalLaunchSessionToken(body.capability) ||
              body.authentication !== "development-bypass"
            ) {
              if (!cancelled) {
                setResult({
                  status: "failed",
                  failureMessage: "Development authentication response is invalid.",
                });
              }
              return;
            }
            const windowId = decodeWindowId(body.windowId);
            writeStoredAuthority(
              storage,
              serverUrl,
              body.capability,
              windowId,
              "development-bypass",
            );
            setResult({
              status: "ready",
              capability: body.capability,
              windowId,
              authentication: "development-bypass",
            });
          } catch {
            if (!cancelled) {
              setResult({
                status: "failed",
                failureMessage: "Octant could not establish development authentication.",
              });
            }
          }
        })();
        return () => {
          cancelled = true;
        };
      }
      if (stored !== undefined) setResult({ status: "ready", ...stored });
      else setResult({ status: "idle" });
      return;
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
        writeStoredAuthority(storage, serverUrl, body.capability, windowId, "launch-token");
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
  }, [options.serverUrl, options.href, options.storage, options.allowDevelopmentBootstrap]);

  return result;
}
