import {
  MAX_GENERATED_IMAGE_BYTES,
  THREAD_IMAGE_CHUNK_BYTES,
  decodeImageArtifactId,
  decodeImageGenerationEnqueueRequest,
  decodeImageGenerationJobsResponse,
  decodeImageGenerationProfilesResponse,
  decodeImageGenerationSaveRequest,
  decodeImageGenerationSaveResult,
  decodeImageGenerationScopeId,
  decodeImageJob,
  decodeImageJobId,
  type ImageArtifactId,
  type ImageArtifactMediaType,
  type ImageGenerationSaveResult,
  type ImageGenerationScopeId,
  type ImageGenerationSettings,
  type ImageJobId,
  type ImageJobThreadKind,
  type ProviderInstance,
  type WindowId,
  type OutsideImageProviderInstance,
} from "@octant/contracts";
import { listEligibleImageProfiles } from "@octant/domain";
import { authenticateRoutePrincipal, retainRouteAdmissionCurrent } from "../principalRouteContext";
import { principalActsAsHostPerson, type ClientPrincipal } from "../clientPrincipal";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ImageJobService, ImageJobServiceError } from "./imageJobService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const JSON_BODY_LIMIT = 8_388_608;
const THREAD_IMAGE_CACHE_TTL_MS = 30_000;
const ARTIFACT_PATH =
  /^jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(cancel|save))?$/i;

export interface ImageRouteHandler {
  (request: Request): Promise<Response | undefined>;
  readonly evictScope: (scopeId: ImageGenerationScopeId) => void;
  readonly close: () => void;
}

export interface ImageRouteDependencies {
  readonly jobs: ImageJobService;
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  /** Whether the host admits an outside image profile's driver now; absent admits none. */
  readonly admitsOutsideImageDriver?: (instance: OutsideImageProviderInstance) => boolean;
  readonly readImageGenerationSettings: () => ImageGenerationSettings;
  readonly authorizeScope: (
    windowId: WindowId,
    threadKind: ImageJobThreadKind,
    scopeId: ImageGenerationScopeId,
    principal?: ClientPrincipal,
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
export function createImageRouteHandler(dependencies: ImageRouteDependencies): ImageRouteHandler {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  const threadImageCache = new VerifiedThreadImageCache(now, THREAD_IMAGE_CACHE_TTL_MS);

  const handle = async (request: Request): Promise<Response | undefined> => {
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

    let context;
    try {
      context = authenticateRoutePrincipal({
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

    const windowId = context.scopeId;
    const remote = context.principal.kind !== "local-window";
    if (
      remote &&
      (!principalActsAsHostPerson(context.principal) ||
        request.method !== "GET" ||
        (route !== "jobs" && route !== "thread-artifact"))
    )
      return failure("Image jobs are unavailable.", 404, origin);
    const current = retainRouteAdmissionCurrent({
      request,
      context,
      store: dependencies.windowAuthorityStore,
      now,
    });
    try {
      if (route === "profiles" && request.method === "GET") {
        const instances = dependencies.listInstances();
        const body = decodeImageGenerationProfilesResponse({
          profiles: listEligibleImageProfiles(
            instances,
            dependencies.readImageGenerationSettings().customSources,
            dependencies.admitsOutsideImageDriver,
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
        if (
          (remote && threadKind === "image-library") ||
          !(await dependencies.authorizeScope(windowId, threadKind, scopeId, context.principal)) ||
          !current()
        ) {
          return failure("Image jobs are unavailable.", 404, origin);
        }
        const body = decodeImageGenerationJobsResponse({
          jobs: dependencies.jobs
            .listByScope(scopeId)
            .filter((job) => !remote || job.threadKind === threadKind),
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

      if (route === "thread-artifact" && request.method === "GET") {
        const jobId = parseJobId(url.searchParams.get("jobId") ?? "");
        const rawAttachmentId = url.searchParams.get("attachmentId");
        const job = jobId === undefined ? undefined : dependencies.jobs.get(jobId);
        const attachment =
          job?.status === "completed"
            ? job.artifacts.find((item) => String(item.attachmentId) === rawAttachmentId)
            : undefined;
        if (
          !job ||
          job.status !== "completed" ||
          !attachment ||
          job.threadKind === "image-library"
        ) {
          if (jobId !== undefined) {
            if (!job || job.status !== "completed") {
              threadImageCache.evictJob(jobId);
            } else if (!attachment && rawAttachmentId !== null) {
              threadImageCache.evictAttachment(jobId, rawAttachmentId);
            }
          }
          return failure("The generated image is unavailable.", 404, origin);
        }
        const canRead = async () =>
          (await dependencies.authorizeScope(
            windowId,
            job.threadKind,
            job.scopeId,
            context.principal,
          )) && current();
        if (!(await canRead())) return failure("The generated image is unavailable.", 404, origin);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset >= attachment.size ||
          offset % THREAD_IMAGE_CHUNK_BYTES !== 0
        )
          return failure("Image offset is invalid.", 416, origin);
        const cacheKey: VerifiedThreadImageKey = {
          jobId: String(job.id),
          scopeId: String(job.scopeId),
          attachmentId: String(attachment.attachmentId),
          hash: attachment.hash,
          size: attachment.size,
          mime: attachment.mime,
        };
        const cacheGeneration = threadImageCache.generation;
        const cached = threadImageCache.read(cacheKey);
        const artifact =
          cached ?? (await dependencies.jobs.readArtifact(job.id, attachment.attachmentId));
        if (!artifact || !(await canRead()))
          return failure("The generated image is unavailable.", 404, origin);
        const currentJob = dependencies.jobs.get(job.id);
        const currentAttachment =
          currentJob?.status === "completed"
            ? currentJob.artifacts.find(
                (item) => String(item.attachmentId) === String(attachment.attachmentId),
              )
            : undefined;
        const attachmentStillMatches =
          currentJob !== undefined &&
          currentAttachment !== undefined &&
          currentJob.threadKind === job.threadKind &&
          String(currentJob.scopeId) === String(job.scopeId) &&
          currentAttachment.hash === attachment.hash &&
          currentAttachment.size === attachment.size &&
          currentAttachment.mime === attachment.mime;
        if (
          !attachmentStillMatches ||
          artifact.bytes.byteLength !== attachment.size ||
          artifact.mime !== attachment.mime
        ) {
          threadImageCache.evictAttachment(job.id, attachment.attachmentId);
          return failure("The generated image is unavailable.", 404, origin);
        }
        if (cached === undefined && artifact.bytes.byteLength <= MAX_GENERATED_IMAGE_BYTES) {
          threadImageCache.store(cacheKey, artifact, cacheGeneration);
        }
        const end = Math.min(offset + THREAD_IMAGE_CHUNK_BYTES, attachment.size);
        return new Response(artifact.bytes.slice(offset, end), {
          status: 206,
          headers: {
            ...corsHeaders(origin),
            "content-type": artifact.mime,
            "content-range": `bytes ${offset}-${end - 1}/${attachment.size}`,
            "cache-control": "no-store",
          },
        });
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
          error.category === "ineligible" || error.category === "spend-ceiling"
            ? 403
            : error.category === "conflict"
              ? 409
              : 400;
        if (error.refusal !== undefined) {
          return json({ error: error.message, refusal: error.refusal }, status, origin);
        }
        return failure(error.message, status, origin);
      }
      return failure("Image request failed.", 500, origin);
    }

    return failure("Image request is invalid.", 405, origin);
  };

  return Object.assign(handle, {
    evictScope: (scopeId: ImageGenerationScopeId) => {
      threadImageCache.evictScope(scopeId);
    },
    close: () => {
      threadImageCache.close();
    },
  });
}

interface VerifiedThreadImageKey {
  readonly jobId: string;
  readonly scopeId: string;
  readonly attachmentId: string;
  readonly hash: string;
  readonly size: number;
  readonly mime: ImageArtifactMediaType;
}

interface VerifiedThreadImageEntry {
  readonly key: VerifiedThreadImageKey;
  readonly bytes: Uint8Array;
  readonly mime: ImageArtifactMediaType;
  readonly cachedAt: number;
  readonly expiresAt: number;
}

/**
 * Single-entry short-lived cache of verified thread image bytes.
 *
 * Chunked `GET /api/image/thread-artifact` reads slice a generated image in
 * 4 MiB responses up to `MAX_GENERATED_IMAGE_BYTES`. Holding only the latest
 * verified read briefly avoids repeated full-file disk reads and SHA-256 passes
 * across slices while bounding memory to one image; every chunk still checks
 * authorization and current job metadata before slicing bytes out.
 */
class VerifiedThreadImageCache {
  readonly #now: () => number;
  readonly #ttlMs: number;
  #entry: VerifiedThreadImageEntry | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #closed = false;

  constructor(now: () => number, ttlMs: number) {
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  get generation(): number {
    return this.#generation;
  }

  read(
    key: VerifiedThreadImageKey,
  ): { readonly bytes: Uint8Array; readonly mime: ImageArtifactMediaType } | undefined {
    const entry = this.#entry;
    if (entry === undefined) return undefined;
    const currentNow = this.#now();
    if (currentNow < entry.cachedAt || currentNow >= entry.expiresAt) {
      this.#clearEntry();
      return undefined;
    }
    if (!sameVerifiedThreadImageKey(entry.key, key)) return undefined;
    if (entry.bytes.byteLength !== key.size || entry.mime !== key.mime) {
      this.#clearEntry();
      return undefined;
    }
    return { bytes: entry.bytes, mime: entry.mime };
  }

  store(
    key: VerifiedThreadImageKey,
    artifact: { readonly bytes: Uint8Array; readonly mime: ImageArtifactMediaType },
    expectedGeneration: number,
  ): void {
    if (this.#closed || this.#generation !== expectedGeneration) return;
    if (
      this.#ttlMs <= 0 ||
      artifact.bytes.byteLength === 0 ||
      artifact.bytes.byteLength > MAX_GENERATED_IMAGE_BYTES ||
      artifact.bytes.byteLength !== key.size ||
      artifact.mime !== key.mime
    ) {
      return;
    }
    this.#clearEntry();
    const cachedAt = this.#now();
    const entry: VerifiedThreadImageEntry = {
      key,
      bytes: artifact.bytes,
      mime: artifact.mime,
      cachedAt,
      expiresAt: cachedAt + this.#ttlMs,
    };
    this.#entry = entry;
    const timer = setTimeout(() => {
      if (this.#entry === entry) this.#clearEntry();
    }, this.#ttlMs);
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
      timer.unref();
    }
    this.#timer = timer;
  }

  evictJob(jobId: ImageJobId): void {
    this.#generation += 1;
    if (this.#entry !== undefined && this.#entry.key.jobId === String(jobId)) {
      this.#clearEntry();
    }
  }

  evictAttachment(jobId: ImageJobId, attachmentId: string | ImageArtifactId): void {
    this.#generation += 1;
    if (
      this.#entry !== undefined &&
      this.#entry.key.jobId === String(jobId) &&
      this.#entry.key.attachmentId === String(attachmentId)
    ) {
      this.#clearEntry();
    }
  }

  evictScope(scopeId: ImageGenerationScopeId): void {
    this.#generation += 1;
    if (this.#entry !== undefined && this.#entry.key.scopeId === String(scopeId)) {
      this.#clearEntry();
    }
  }

  close(): void {
    this.#closed = true;
    this.#generation += 1;
    this.#clearEntry();
  }

  #clearEntry(): void {
    this.#entry = undefined;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

function sameVerifiedThreadImageKey(
  left: VerifiedThreadImageKey,
  right: VerifiedThreadImageKey,
): boolean {
  return (
    left.jobId === right.jobId &&
    left.scopeId === right.scopeId &&
    left.attachmentId === right.attachmentId &&
    left.hash === right.hash &&
    left.size === right.size &&
    left.mime === right.mime
  );
}

function parseThreadKind(value: string | null): ImageJobThreadKind | undefined {
  if (
    value === "chat-thread" ||
    value === "work-thread" ||
    value === "code-thread" ||
    value === "image-library"
  ) {
    return value;
  }
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
