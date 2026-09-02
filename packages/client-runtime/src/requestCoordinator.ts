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

interface BufferedResponse {
  readonly body: ArrayBuffer;
  readonly headers: Headers;
  readonly status: number;
  readonly statusText: string;
}

interface SharedRead {
  readonly controller: AbortController;
  readonly response: Promise<BufferedResponse>;
  participants: number;
}

const COORDINATED_POST_READ_PATHS = new Set([
  "/api/code/board",
  "/api/code/evidence/batch",
  "/api/code/project-pull-requests",
  "/api/code/project-pull-requests/detail",
  "/api/code/terminals/inspect",
  "/api/context/inspect",
  "/api/usage/dashboard",
  "/api/usage/query",
  "/api/work/board",
]);

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
  const inflight = new Map<string, SharedRead>();
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
    const signal = requestSignal(input, init);
    if (signal?.aborted === true) throw abortError();
    let shared = inflight.get(key);
    if (shared === undefined) {
      const controller = new AbortController();
      const scheduled = detachCallerSignal(input, init, controller.signal);
      const response = schedule(scheduled.input, scheduled.init, priority).then(bufferResponse);
      shared = { controller, participants: 0, response };
      inflight.set(key, shared);
      void response
        .finally(() => {
          if (inflight.get(key) === shared) inflight.delete(key);
        })
        .catch(() => undefined);
    }
    shared.participants += 1;
    try {
      const response = await waitForCaller(shared.response, signal);
      return responseFromBuffer(response);
    } finally {
      shared.participants -= 1;
      if (shared.participants === 0 && inflight.get(key) === shared) {
        inflight.delete(key);
        shared.controller.abort();
      }
    }
  };
}

async function bufferResponse(response: Response): Promise<BufferedResponse> {
  return {
    body: await response.arrayBuffer(),
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  };
}

function responseFromBuffer(response: BufferedResponse): Response {
  const body = response.body.byteLength === 0 ? null : response.body.slice(0);
  return new Response(body, {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
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
  return method === "GET" || (method === "POST" && COORDINATED_POST_READ_PATHS.has(url.pathname));
}

function withoutSignal(init: RequestInit | undefined): RequestInit | undefined {
  if (init === undefined || init.signal === undefined || init.signal === null) return init;
  const { signal: _signal, ...rest } = init;
  return rest;
}

function requestSignal(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): AbortSignal | null | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

function detachCallerSignal(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
): { readonly input: RequestInfo | URL; readonly init: RequestInit } {
  return {
    input: input instanceof Request ? new Request(input, { signal }) : input,
    init: { ...withoutSignal(init), signal },
  };
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
    (COORDINATED_POST_READ_PATHS.has(url.pathname) &&
      url.pathname !== "/api/code/evidence/batch") ||
    url.pathname === "/api/extensions/snapshot" ||
    url.pathname === "/api/computer-use/sessions" ||
    url.pathname === "/api/browser/contexts/current" ||
    url.pathname === "/api/agent-runs/parent-summary"
  );
}

async function waitForCaller<T>(
  response: Promise<T>,
  signal: AbortSignal | null | undefined,
): Promise<T> {
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
