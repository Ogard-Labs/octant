import { randomBytes } from "node:crypto";
import {
  decodeImageGenerationScopeId,
  decodeVideoClipTicketResponse,
  decodeVideoJob,
  decodeVideoJobId,
  decodeVideoJobsResponse,
  type ImageGenerationScopeId,
  type VideoJob,
  type VideoJobId,
  type VideoJobThreadKind,
  type WindowId,
} from "@octant/contracts";
import { principalActsAsHostPerson, type ClientPrincipal } from "../clientPrincipal";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { VideoJobService } from "./videoJobService";

const PREFIX = "/api/video/";
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, range, x-octant-window-capability";
const JOB_ROUTE =
  /^jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(stop|clip-ticket)$/i;
/** Long enough to watch a clip through and seek in it; renewed by asking again. */
export const VIDEO_CLIP_TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_TICKETS = 512;
/** One range response at most; a player asks again for the next part. */
const MAX_RANGE_BYTES = 8 * 1024 * 1024;

interface ClipTicket {
  readonly jobId: VideoJobId;
  readonly windowId: WindowId;
  readonly principal: ClientPrincipal;
  readonly expiresAt: number;
}

export interface VideoRouteHandler {
  (request: Request): Promise<Response | undefined>;
  /** Drops the clip tickets a revoked window holds. */
  readonly revokeWindow: (windowId: WindowId) => void;
}

export interface VideoRouteDependencies {
  readonly jobs: Pick<VideoJobService, "getById" | "listByScope" | "stop" | "readClipRange">;
  readonly authorizeScope: (
    windowId: WindowId,
    threadKind: VideoJobThreadKind,
    scopeId: ImageGenerationScopeId,
    principal?: ClientPrincipal,
  ) => Promise<boolean>;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * A thread's video jobs, Stop, and its clips. Window authority first, then the
 * thread each job belongs to. Clips are served on a short-lived ticket because
 * a `<video>` element cannot send the window's credential; each ranged request
 * on a ticket checks the issuing window's authority over the thread again, so
 * a window that loses the thread loses the clip at its next request.
 */
export function createVideoRouteHandler(dependencies: VideoRouteDependencies): VideoRouteHandler {
  const now = dependencies.now ?? Date.now;
  const tickets = new Map<string, ClipTicket>();

  const sweep = () => {
    const at = now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= at) tickets.delete(key);
    while (tickets.size >= MAX_TICKETS) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      tickets.delete(oldest);
    }
  };

  const authorizedJob = async (
    jobId: VideoJobId,
    windowId: WindowId,
    principal: ClientPrincipal,
  ): Promise<VideoJob | undefined> => {
    const job = dependencies.jobs.getById(jobId);
    if (job === undefined) return undefined;
    return (await dependencies.authorizeScope(windowId, job.threadKind, job.scopeId, principal))
      ? job
      : undefined;
  };

  const serveClip = async (url: URL, request: Request, origin: string | null) => {
    const key = url.searchParams.get("ticket") ?? "";
    const ticket = tickets.get(key);
    if (ticket === undefined || ticket.expiresAt <= now()) {
      tickets.delete(key);
      return failure("This clip address has expired.", 404, origin);
    }
    if (
      ticket.principal.kind === "local-window" &&
      !dependencies.windowAuthorityStore
        .listWindowIds(now())
        .some((id) => String(id) === String(ticket.windowId))
    ) {
      tickets.delete(key);
      return failure("This clip address has expired.", 404, origin);
    }
    const job = await authorizedJob(ticket.jobId, ticket.windowId, ticket.principal);
    if (job === undefined || job.clip === undefined) {
      return failure("The clip is unavailable.", 404, origin);
    }
    const size = job.clip.size;
    const range = parseRange(request.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { ...corsHeaders(origin), "content-range": `bytes */${String(size)}` },
      });
    }
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, start + MAX_RANGE_BYTES - 1);
    const read = await dependencies.jobs.readClipRange(job, { start, end });
    if (read === undefined) return failure("The clip is unavailable.", 404, origin);
    const partial = range !== undefined || read.end < read.size - 1;
    return new Response(Uint8Array.from(read.bytes), {
      status: partial ? 206 : 200,
      headers: {
        ...corsHeaders(origin),
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-length": String(read.bytes.byteLength),
        ...(partial
          ? {
              "content-range": `bytes ${String(read.start)}-${String(read.end)}/${String(read.size)}`,
            }
          : {}),
        "cache-control": "private, max-age=0, no-store",
      },
    });
  };

  const handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const route = url.pathname.slice(PREFIX.length);
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Video API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    // The ticket is the whole credential here: it was issued to an
    // authenticated window, and the thread is checked again below.
    if (route === "clip" && request.method === "GET") return serveClip(url, request, origin);

    let context;
    try {
      context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Video request is unauthorized.", 401, origin)
        : failure("Video request is invalid.", 400, origin);
    }
    const windowId = context.scopeId;
    const principal = context.principal;
    const remote = principal.kind !== "local-window";
    // A paired client watches and downloads clips of threads it can open; it
    // does not stop jobs.
    if (remote && !principalActsAsHostPerson(principal)) {
      return failure("Video jobs are unavailable.", 404, origin);
    }

    try {
      if (route === "jobs" && request.method === "GET") {
        const threadKind = parseThreadKind(url.searchParams.get("threadKind"));
        const scopeId = parseScopeId(url.searchParams.get("scopeId"));
        if (threadKind === undefined || scopeId === undefined) {
          return failure("Video job list requires a thread.", 400, origin);
        }
        if (!(await dependencies.authorizeScope(windowId, threadKind, scopeId, principal))) {
          return failure("Video jobs are unavailable.", 404, origin);
        }
        return json(
          decodeVideoJobsResponse({
            jobs: dependencies.jobs
              .listByScope(scopeId)
              .filter((job) => job.threadKind === threadKind),
          }),
          200,
          origin,
        );
      }
      const match = JOB_ROUTE.exec(route);
      if (match !== null && request.method === "POST") {
        const action = match[2];
        if (remote && action === "stop") return failure("Video jobs are unavailable.", 404, origin);
        const job = await authorizedJob(decodeVideoJobId(match[1]), windowId, principal);
        if (job === undefined) return failure("Video jobs are unavailable.", 404, origin);
        if (action === "stop") {
          dependencies.jobs.stop(job.id);
          return json(decodeVideoJob(dependencies.jobs.getById(job.id) ?? job), 200, origin);
        }
        if (job.status !== "completed" || job.clip === undefined) {
          return failure("The clip is not ready.", 409, origin);
        }
        sweep();
        const key = randomBytes(32).toString("base64url");
        const expiresAt = now() + VIDEO_CLIP_TICKET_TTL_MS;
        tickets.set(key, { jobId: job.id, windowId, principal, expiresAt });
        return json(
          decodeVideoClipTicketResponse({
            url: `${PREFIX}clip?ticket=${key}`,
            expiresAt: new Date(expiresAt).toISOString(),
          }),
          200,
          origin,
        );
      }
    } catch {
      return failure("Video request failed.", 500, origin);
    }
    return failure("Video request is invalid.", 405, origin);
  };

  return Object.assign(handle, {
    revokeWindow: (windowId: WindowId) => {
      for (const [key, ticket] of tickets) {
        if (String(ticket.windowId) === String(windowId)) tickets.delete(key);
      }
    },
  });
}

/** One `bytes=` range, open-ended or suffix; several ranges are served as the first. */
export function parseRange(
  header: string | null,
  size: number,
): { readonly start: number; readonly end: number } | "unsatisfiable" | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)/.exec(header.trim());
  if (match === null) return undefined;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return undefined;
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
}

function parseThreadKind(value: string | null): VideoJobThreadKind | undefined {
  return value === "chat-thread" || value === "work-thread" || value === "code-thread"
    ? value
    : undefined;
}

function parseScopeId(value: string | null): ImageGenerationScopeId | undefined {
  if (value === null) return undefined;
  try {
    return decodeImageGenerationScopeId(value);
  } catch {
    return undefined;
  }
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-range, accept-ranges, content-length",
  };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname === "127.0.0.1" || url.hostname === "localhost"
      : false;
  } catch {
    return false;
  }
}
