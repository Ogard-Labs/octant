import {
  CANVAS_PUBLIC_SHARE_WIRE_VERSION,
  decodeCanvasPublicShareCreateRequest,
  decodeCanvasPublicShareCreated,
  decodeCanvasPublicShareReport,
  decodeCanvasPublicShareRevoked,
  decodeCanvasPublicShareStatus,
  decodeCanvasPublicShareUpdateRequest,
  decodeCanvasPublicShareUpdated,
  type CanvasPublicShareDocument,
  type CanvasPublicShareRefusalCode,
} from "@octant/contracts/canvas-public-share";
import { PRIVATE_HEADERS, type ServiceContext } from "./context.ts";
import { digestsMatch, hashOwnerSecret, isShareId, type StoredShare } from "./store.ts";

const DAY_MS = 86_400_000;
/** Room in a request body for the envelope around the document. */
const BODY_ENVELOPE_BYTES = 16 * 1024;
const REPORT_BODY_MAX_BYTES = 8 * 1024;

const REFUSAL_STATUS: Readonly<Record<CanvasPublicShareRefusalCode, number>> = {
  malformed: 400,
  "too-large": 413,
  unauthorized: 403,
  "not-found": 404,
  gone: 410,
  "rate-limited": 429,
  unavailable: 503,
};

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...PRIVATE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

export function refusal(code: CanvasPublicShareRefusalCode, message: string): Response {
  return jsonResponse(
    {
      schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
      kind: "canvas-public-share-refused",
      code,
      message,
    },
    REFUSAL_STATUS[code],
  );
}

type BodyRead =
  | { readonly status: "read"; readonly text: string }
  | { readonly status: "too-large" };

/** Reads at most `limit` bytes; a larger body is refused without being buffered whole. */
export async function readLimitedBody(request: Request, limit: number): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return { status: "too-large" };
  if (request.body === null) return { status: "read", text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return { status: "too-large" };
    }
    chunks.push(chunk.value);
  }
  return { status: "read", text: Buffer.concat(chunks).toString("utf8") };
}

type Parsed<T> =
  | { readonly status: "parsed"; readonly value: T }
  | { readonly status: "refused"; readonly response: Response };

async function parseBody<T>(
  request: Request,
  limit: number,
  decode: (value: unknown) => T,
): Promise<Parsed<T>> {
  const body = await readLimitedBody(request, limit);
  if (body.status === "too-large") {
    return {
      status: "refused",
      response: refusal("too-large", "The request body is larger than this service accepts."),
    };
  }
  try {
    return { status: "parsed", value: decode(JSON.parse(body.text)) };
  } catch {
    return {
      status: "refused",
      response: refusal("malformed", "The request body does not match the share contract."),
    };
  }
}

function documentByteLength(document: CanvasPublicShareDocument): number {
  return Buffer.byteLength(JSON.stringify(document), "utf8");
}

function expiryOf(
  now: number,
  expiry: { readonly kind: "days"; readonly days: number } | { readonly kind: "never" },
): string | null {
  return expiry.kind === "never" ? null : new Date(now + expiry.days * DAY_MS).toISOString();
}

type Authorized =
  | { readonly status: "authorized"; readonly share: StoredShare }
  | { readonly status: "refused"; readonly response: Response };

/**
 * A wrong or missing secret and an id that does not exist both answer 403, so
 * the owner routes cannot be used to find out which ids are in use. A
 * tombstone holds no secret hash, so a gone link answers 410 to anyone.
 */
function authorizeOwner(ctx: ServiceContext, id: string, request: Request): Authorized {
  const unauthorized: Authorized = {
    status: "refused",
    response: refusal("unauthorized", "The owner secret is missing or wrong."),
  };
  const lookup = ctx.store.lookup(id);
  if (lookup.status === "gone") {
    return {
      status: "refused",
      response: refusal("gone", "This link was revoked or has expired."),
    };
  }
  if (lookup.status === "missing") return unauthorized;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  const secret = match?.[1];
  if (secret === undefined) return unauthorized;
  if (!digestsMatch(hashOwnerSecret(secret), lookup.share.ownerSecretHash)) return unauthorized;
  return { status: "authorized", share: lookup.share };
}

function shareUrl(ctx: ServiceContext, id: string): string {
  return `${ctx.publicOrigin}/s/${id}`;
}

async function createShare(
  request: Request,
  ctx: ServiceContext,
  client: string,
): Promise<Response> {
  if (!ctx.limiter.allow("create", client)) {
    return refusal("rate-limited", "Too many links created. Try again in a minute.");
  }
  const parsed = await parseBody(
    request,
    ctx.config.maxDocumentBytes + BODY_ENVELOPE_BYTES,
    decodeCanvasPublicShareCreateRequest,
  );
  if (parsed.status === "refused") return parsed.response;
  const { document, expiry, password } = parsed.value;
  const byteLength = documentByteLength(document);
  if (byteLength > ctx.config.maxDocumentBytes) {
    return refusal("too-large", "The Canvas is larger than this service accepts.");
  }
  const now = ctx.store.now();
  const passwordHash =
    password === undefined ? null : await Bun.password.hash(password, { algorithm: "argon2id" });
  const ownerSecret = ctx.store.newOwnerSecret();
  const share: StoredShare = {
    document,
    createdAt: ctx.store.iso(now),
    updatedAt: ctx.store.iso(now),
    expiresAt: expiryOf(now, expiry),
    byteLength,
    passwordHash,
    ownerSecretHash: hashOwnerSecret(ownerSecret),
    revision: 1,
    viewCount: 0,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = ctx.store.newId();
    const outcome = ctx.store.create(id, share);
    if (outcome.status === "id-taken") continue;
    if (outcome.status === "unavailable") {
      return refusal("unavailable", "This service is not accepting new links right now.");
    }
    return jsonResponse(
      decodeCanvasPublicShareCreated({
        schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
        kind: "canvas-public-share-created",
        shareId: id,
        url: shareUrl(ctx, id),
        ownerSecret,
        expiresAt: share.expiresAt,
      }),
      201,
    );
  }
  return refusal("unavailable", "This service could not mint a link id. Try again.");
}

async function updateShare(request: Request, ctx: ServiceContext, id: string): Promise<Response> {
  const authorized = authorizeOwner(ctx, id, request);
  if (authorized.status === "refused") return authorized.response;
  const parsed = await parseBody(
    request,
    ctx.config.maxDocumentBytes + BODY_ENVELOPE_BYTES,
    decodeCanvasPublicShareUpdateRequest,
  );
  if (parsed.status === "refused") return parsed.response;
  const { document, expiry, password } = parsed.value;
  const byteLength = documentByteLength(document);
  if (byteLength > ctx.config.maxDocumentBytes) {
    return refusal("too-large", "The Canvas is larger than this service accepts.");
  }
  const now = ctx.store.now();
  // An absent password keeps the link's existing one; an update never removes it.
  const passwordHash =
    password === undefined
      ? undefined
      : await Bun.password.hash(password, { algorithm: "argon2id" });
  const outcome = ctx.store.replace(id, (current) => ({
    ...current,
    document,
    byteLength,
    expiresAt: expiryOf(now, expiry),
    updatedAt: ctx.store.iso(now),
    passwordHash: passwordHash ?? current.passwordHash,
    revision: current.revision + 1,
  }));
  if (outcome.status === "missing") return refusal("gone", "This link was revoked or has expired.");
  if (outcome.status === "unavailable") {
    return refusal("unavailable", "This service is not accepting larger links right now.");
  }
  const { share } = outcome;
  return jsonResponse(
    decodeCanvasPublicShareUpdated({
      schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
      kind: "canvas-public-share-updated",
      shareId: id,
      url: shareUrl(ctx, id),
      expiresAt: share.expiresAt,
      updatedAt: share.updatedAt,
      passwordProtected: share.passwordHash !== null,
    }),
    200,
  );
}

async function reportShare(request: Request, ctx: ServiceContext, id: string, client: string) {
  if (!ctx.limiter.allow("report", client)) {
    return refusal("rate-limited", "Too many reports. Try again in a minute.");
  }
  const parsed = await parseBody(request, REPORT_BODY_MAX_BYTES, decodeCanvasPublicShareReport);
  if (parsed.status === "refused") return parsed.response;
  const lookup = ctx.store.lookup(id);
  if (lookup.status === "missing") return refusal("not-found", "There is no such link.");
  if (lookup.status === "gone") return refusal("gone", "This link was revoked or has expired.");
  ctx.store.addReport({ shareId: id, reason: parsed.value.reason, detail: parsed.value.detail });
  return jsonResponse({ status: "accepted" }, 202);
}

/** The `/api/v1/shares` routes. Returns undefined for a path that is not one of them. */
export async function handleApi(
  request: Request,
  url: URL,
  ctx: ServiceContext,
  client: string,
): Promise<Response | undefined> {
  const match = /^\/api\/v1\/shares(?:\/([^/]+)(\/reports)?)?$/.exec(url.pathname);
  if (match === null) return undefined;
  const id = match[1];
  const reports = match[2] !== undefined;
  if (id === undefined) {
    return request.method === "POST"
      ? createShare(request, ctx, client)
      : refusal("not-found", "There is no such route.");
  }
  if (reports) {
    return request.method === "POST" && isShareId(id)
      ? reportShare(request, ctx, id, client)
      : refusal("not-found", "There is no such route.");
  }
  if (request.method !== "PUT" && request.method !== "DELETE" && request.method !== "GET") {
    return refusal("not-found", "There is no such route.");
  }
  if (!ctx.limiter.allow("owner", client)) {
    return refusal("rate-limited", "Too many requests. Try again in a minute.");
  }
  if (request.method === "PUT") return updateShare(request, ctx, id);
  const authorized = authorizeOwner(ctx, id, request);
  if (authorized.status === "refused") return authorized.response;
  if (request.method === "DELETE") {
    ctx.store.remove(id, "revoked");
    return jsonResponse(
      decodeCanvasPublicShareRevoked({
        schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
        kind: "canvas-public-share-revoked",
        shareId: id,
      }),
      200,
    );
  }
  const { share } = authorized;
  return jsonResponse(
    decodeCanvasPublicShareStatus({
      schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
      kind: "canvas-public-share-status",
      shareId: id,
      url: shareUrl(ctx, id),
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
      expiresAt: share.expiresAt,
      passwordProtected: share.passwordHash !== null,
      byteLength: share.byteLength,
      viewCount: share.viewCount,
    }),
    200,
  );
}
