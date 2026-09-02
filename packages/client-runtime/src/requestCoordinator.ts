import { bindFetchPort } from "./bindFetchPort";

export interface RequestCoordinatorOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly maxConcurrent?: number;
  readonly maxBackground?: number;
  readonly onUnauthorized?: () => Promise<void>;
}

interface ScheduledRead {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
  readonly priority: "foreground" | "background";
  readonly resolve: (response: Response) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * One window-owned read coordinator for every feature client.
 *
 * It coalesces identical snapshots, keeps background observations behind
 * transcript reads, and bounds concurrent background work. Mutations and
 * long-lived streams bypass it so they retain their own cancellation and
 * ordering semantics.
 */
export function createRequestCoordinator(
  options: RequestCoordinatorOptions,
): typeof globalThis.fetch {
  const maxConcurrent = options.maxConcurrent ?? 8;
  const maxBackground = options.maxBackground ?? 2;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Request concurrency must be positive.");
  }
  if (!Number.isSafeInteger(maxBackground) || maxBackground < 1) {
    throw new Error("Background request concurrency must be positive.");
  }
  const foreground: ScheduledRead[] = [];
  const background: ScheduledRead[] = [];
  const inflight = new Map<string, Promise<Response>>();
  let active = 0;
  let activeBackground = 0;
  let renewal: Promise<void> | undefined;
  const fetch = bindFetchPort(options.fetch);

  const fetchObserved: typeof globalThis.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.status !== 401 || options.onUnauthorized === undefined) return response;
    if (renewal === undefined) {
      const started = callUnauthorized(options.onUnauthorized);
      const observed = started.finally(() => {
        if (renewal === observed) renewal = undefined;
      });
      renewal = observed;
    }
    await renewal.catch(() => undefined);
    return response;
  };

  const pump = (): void => {
    while (active < maxConcurrent) {
      const job =
        foreground.shift() ?? (activeBackground < maxBackground ? background.shift() : undefined);
      if (job === undefined) return;
      if (job.init?.signal?.aborted === true) {
        job.reject(abortError());
        continue;
      }
      active += 1;
      if (job.priority === "background") activeBackground += 1;
      Promise.resolve(fetchObserved(job.input, job.init))
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          if (job.priority === "background") activeBackground -= 1;
          pump();
        });
    }
  };

  const schedule = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    priority: "foreground" | "background",
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const job = { input, init, priority, resolve, reject };
      (priority === "foreground" ? foreground : background).push(job);
      pump();
    });

  return async (input, init) => {
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    if (!isCoordinatedRead(method, url) || isLongLivedRead(url)) {
      return fetchObserved(input, init);
    }
    if (method === "POST" && typeof init?.body !== "string") {
      return fetchObserved(input, init);
    }
    const priority = isBackgroundRead(url) ? "background" : "foreground";
    const key = readKey(method, input, init);
    let shared = inflight.get(key);
    if (shared === undefined) {
      shared = schedule(input, withoutSignal(init), priority);
      inflight.set(key, shared);
      void shared
        .finally(() => {
          if (inflight.get(key) === shared) inflight.delete(key);
        })
        .catch(() => undefined);
    }
    const response = await waitForCaller(shared, init?.signal);
    return response.clone();
  };
}

function callUnauthorized(callback: () => Promise<void>): Promise<void> {
  try {
    return callback();
  } catch (error) {
    return Promise.reject(error);
  }
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function readKey(method: string, input: RequestInfo | URL, init: RequestInit | undefined): string {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers !== undefined) {
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  }
  return `${method}\n${requestUrl(input).toString()}\n${[...headers]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n")}\n${typeof init?.body === "string" ? init.body : ""}`;
}

function isCoordinatedRead(method: string, url: URL): boolean {
  return method === "GET" || (method === "POST" && url.pathname === "/api/code/evidence/batch");
}

function withoutSignal(init: RequestInit | undefined): RequestInit | undefined {
  if (init === undefined || init.signal === undefined || init.signal === null) return init;
  const { signal: _signal, ...rest } = init;
  return rest;
}

function isLongLivedRead(url: URL): boolean {
  return (
    url.pathname.endsWith("/events") ||
    url.pathname.includes("/stream/") ||
    url.pathname.endsWith("/changes") ||
    url.pathname.endsWith("/watch")
  );
}

function isBackgroundRead(url: URL): boolean {
  return (
    url.pathname.endsWith("/navigation") ||
    url.pathname.endsWith("/follow-up") ||
    url.pathname.endsWith("/environment") ||
    url.pathname === "/api/extensions/snapshot" ||
    url.pathname === "/api/computer-use/sessions" ||
    url.pathname === "/api/browser/contexts/current" ||
    url.pathname === "/api/agent-runs/parent-summary"
  );
}

async function waitForCaller(
  response: Promise<Response>,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  if (signal === undefined || signal === null) return response;
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    response.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  return new DOMException("The request was aborted.", "AbortError");
}
