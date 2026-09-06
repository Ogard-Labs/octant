import {
  decodeImageArtifactId,
  decodeImageGenerationEnqueueRequest,
  decodeImageGenerationJobsResponse,
  decodeImageGenerationProfilesResponse,
  decodeImageGenerationSaveRequest,
  decodeImageGenerationSaveResult,
  decodeImageGenerationScopeId,
  decodeImageJob,
  decodeImageJobId,
  type ImageGenerationSaveResult,
  type ImageGenerationScopeId,
  type ImageGenerationSettings,
  type ImageJobId,
  type ImageJobThreadKind,
  type ProviderInstance,
  type WindowId,
} from "@octant/contracts";
import { listEligibleImageProfiles } from "@octant/domain";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ImageJobService, ImageJobServiceError } from "./imageJobService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const JSON_BODY_LIMIT = 8_388_608;
const ARTIFACT_PATH =
  /^jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(cancel|save))?$/i;

export interface ImageRouteDependencies {
  readonly jobs: ImageJobService;
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readImageGenerationSettings: () => ImageGenerationSettings;
  readonly authorizeScope: (
    windowId: WindowId,
    threadKind: ImageJobThreadKind,
    scopeId: ImageGenerationScopeId,
  ) => Promise<boolean>;
  readonly saveToProject: (input: {
    readonly windowId: WindowId;
    readonly threadKind: ImageJobThreadKind;
    readonly scopeId: ImageGenerationScopeId;
    readonly relativePath: string;
    readonly bytes: Uint8Array;
    readonly mime: string;
  }) => Promise<ImageGenerationSaveResult>;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  readonly maxJsonBodySize?: number;
}

/**
 * Composer and preview entry for image generation. Window authority first;
 * every job is then re-checked against the thread the window can already Open.
 */
export function createImageRouteHandler(dependencies: ImageRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/image/")) return undefined;
    const route = url.pathname.slice("/api/image/".length);

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Image API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Image request is unauthorized.", 401, origin);
      }
      return failure("Image request is invalid.", 400, origin);
    }

    try {
      if (route === "profiles" && request.method === "GET") {
        const instances = dependencies.listInstances();
        const body = decodeImageGenerationProfilesResponse({
          profiles: listEligibleImageProfiles(
            instances,
            dependencies.readImageGenerationSettings().customSources,
          ),
        });
        return json(body, 200, origin);
      }

      if (route === "jobs" && request.method === "GET") {
        const threadKind = parseThreadKind(url.searchParams.get("threadKind"));
        const scopeId = parseScopeId(url.searchParams.get("scopeId"));
        if (threadKind === undefined || scopeId === undefined) {
          return failure("Image job list requires a thread.", 400, origin);
        }
        if (!(await dependencies.authorizeScope(windowId, threadKind, scopeId))) {
          return failure("Image jobs are unavailable.", 404, origin);
        }
        const body = decodeImageGenerationJobsResponse({
          jobs: dependencies.jobs.listByScope(scopeId),
        });
        return json(body, 200, origin);
      }

      if (route === "jobs" && request.method === "POST") {
        const decoded = await readJson(request, jsonLimit);
        if (decoded.kind === "too-large") return failure("Request body is too large.", 413, origin);
        if (decoded.kind === "invalid") {
          return failure("Request body must be valid JSON.", 400, origin);
        }
        let enqueue;
        try {
          enqueue = decodeImageGenerationEnqueueRequest(decoded.value);
        } catch {
          return failure("Image generation request is invalid.", 400, origin);
        }
        if (!(await dependencies.authorizeScope(windowId, enqueue.threadKind, enqueue.scopeId))) {
          return failure("Image jobs are unavailable.", 404, origin);
        }
        const references = decodeReferences(enqueue.references);
        if (references === undefined) {
          return failure("A reference image is invalid.", 400, origin);
        }
        const job = await dependencies.jobs.enqueue({
          threadKind: enqueue.threadKind,
          scopeId: enqueue.scopeId,
          profileInstanceId: enqueue.profileInstanceId,
          modelId: enqueue.modelId,
          prompt: enqueue.prompt,
          ...(enqueue.variantCount === undefined ? {} : { variantCount: enqueue.variantCount }),
          ...(enqueue.quality === undefined ? {} : { quality: enqueue.quality }),
          ...(enqueue.size === undefined ? {} : { size: enqueue.size }),
          ...(enqueue.aspectRatio === undefined ? {} : { aspectRatio: enqueue.aspectRatio }),
          ...(enqueue.resolution === undefined ? {} : { resolution: enqueue.resolution }),
          ...(enqueue.parentArtifactRef === undefined
            ? {}
            : { parentArtifactRef: enqueue.parentArtifactRef }),
          ...(references.length === 0 ? {} : { references }),
        });
        return json(decodeImageJob(job), 200, origin);
      }

      const artifactMatch = ARTIFACT_PATH.exec(route);
      if (artifactMatch !== undefined && artifactMatch !== null) {
        const jobId = decodeImageJobId(artifactMatch[1]);
        const attachmentId = decodeImageArtifactId(artifactMatch[2]);
        const action = artifactMatch[3];
        const job = dependencies.jobs.get(jobId);
        if (job === undefined) return failure("Image jobs are unavailable.", 404, origin);
        if (!(await dependencies.authorizeScope(windowId, job.threadKind, job.scopeId))) {
          return failure("Image jobs are unavailable.", 404, origin);
        }

        if (action === "save" && request.method === "POST") {
          const decoded = await readJson(request, 8_192);
          if (decoded.kind === "too-large")
            return failure("Request body is too large.", 413, origin);
          if (decoded.kind === "invalid") {
            return failure("Request body must be valid JSON.", 400, origin);
          }
          let saveRequest;
          try {
            saveRequest = decodeImageGenerationSaveRequest(decoded.value);
          } catch {
            return failure("Image save request is invalid.", 400, origin);
          }
          const artifact = await dependencies.jobs.readArtifact(jobId, attachmentId);
          if (artifact === undefined)
            return failure("The generated image is unavailable.", 404, origin);
          const result = await dependencies.saveToProject({
            windowId,
            threadKind: job.threadKind,
            scopeId: job.scopeId,
            relativePath: saveRequest.relativePath,
            bytes: artifact.bytes,
            mime: artifact.mime,
          });
          return json(
            decodeImageGenerationSaveResult(result),
            result.status === "saved" ? 200 : 403,
            origin,
          );
        }

        if (request.method === "GET" && action === undefined) {
          const artifact = await dependencies.jobs.readArtifact(jobId, attachmentId);
          if (artifact === undefined)
            return failure("The generated image is unavailable.", 404, origin);
          return new Response(Uint8Array.from(artifact.bytes), {
            status: 200,
            headers: {
              ...corsHeaders(origin),
              "content-type": artifact.mime,
              "cache-control": "private, max-age=0, no-store",
            },
          });
        }
      }

      const cancelMatch =
        /^jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/cancel$/i.exec(
          route,
        );
      if (cancelMatch !== null && request.method === "POST") {
        const jobId = decodeImageJobId(cancelMatch[1]);
        const job = dependencies.jobs.get(jobId);
        if (job === undefined) return failure("Image jobs are unavailable.", 404, origin);
        if (!(await dependencies.authorizeScope(windowId, job.threadKind, job.scopeId))) {
          return failure("Image jobs are unavailable.", 404, origin);
        }
        const cancelled = await dependencies.jobs.cancel(jobId);
        return json(decodeImageJob(cancelled), 200, origin);
      }

      if (route.startsWith("jobs/") && request.method === "GET") {
        const jobId = parseJobId(route.slice("jobs/".length));
        if (jobId === undefined) return failure("Image jobs are unavailable.", 404, origin);
        const job = dependencies.jobs.get(jobId);
        if (job === undefined) return failure("Image jobs are unavailable.", 404, origin);
        if (!(await dependencies.authorizeScope(windowId, job.threadKind, job.scopeId))) {
          return failure("Image jobs are unavailable.", 404, origin);
        }
        return json(decodeImageJob(job), 200, origin);
      }
    } catch (error) {
      if (isImageJobServiceError(error)) {
        const status =
          error.category === "ineligible" ? 403 : error.category === "conflict" ? 409 : 400;
        return failure(error.message, status, origin);
      }
      return failure("Image request failed.", 500, origin);
    }

    return failure("Image request is invalid.", 405, origin);
  };
}

function parseThreadKind(value: string | null): ImageJobThreadKind | undefined {
  if (value === "chat-thread" || value === "work-thread" || value === "code-thread") return value;
  return undefined;
}

function parseScopeId(value: string | null): ImageGenerationScopeId | undefined {
  if (value === null) return undefined;
  try {
    return decodeImageGenerationScopeId(value);
  } catch {
    return undefined;
  }
}

function parseJobId(value: string): ImageJobId | undefined {
  try {
    return decodeImageJobId(value);
  } catch {
    return undefined;
  }
}

function decodeReferences(
  references: ReadonlyArray<{ readonly mediaType: string; readonly base64: string }> | undefined,
):
  | ReadonlyArray<{
      readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      readonly bytes: Uint8Array;
    }>
  | undefined {
  if (references === undefined) return [];
  const decoded: Array<{
    readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    readonly bytes: Uint8Array;
  }> = [];
  for (const reference of references) {
    try {
      const bytes = Uint8Array.from(Buffer.from(reference.base64, "base64"));
      if (bytes.length === 0) return undefined;
      decoded.push({
        mediaType: reference.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        bytes,
      });
    } catch {
      return undefined;
    }
  }
  return decoded;
}

function isImageJobServiceError(error: unknown): error is ImageJobServiceError {
  return error instanceof Error && error.name === "ImageJobServiceError";
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

async function readJson(
  request: Request,
  limit: number,
): Promise<
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" }
> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > limit) return { kind: "too-large" };
  }
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > limit) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(buffer)) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}
