import {
  decodeValidationCompositionFailure,
  decodeValidationEvidenceRequest,
  decodeValidationEvidenceSnapshot,
  type ValidationCompositionFailure,
  type ValidationEvidenceRequest,
  type ValidationEvidenceSnapshot,
} from "@octant/contracts/validation-rpc";
import type { ToolActionAuthority, WindowId } from "@octant/contracts";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const DEFAULT_BODY_LIMIT = 1_048_576;

/**
 * Typed result of loading a validation evidence snapshot. The loader never
 * treats unknown data as success: it returns an explicit failure category
 * when evidence is unauthorized, unavailable, or replay-denied.
 */
export type ValidationEvidenceLoadResult =
  | { readonly kind: "snapshot"; readonly snapshot: ValidationEvidenceSnapshot }
  | {
      readonly kind: "failure";
      readonly failure: ValidationCompositionFailure;
    };

export interface ValidationEvidenceRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly authorize: (
    windowId: WindowId,
    authority: ToolActionAuthority,
  ) => boolean | Promise<boolean>;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
  /**
   * Optional store-backed snapshot loader backed by the validation evidence
   * projection. When absent, the route fails closed with an honest
   * unavailable failure instead of inventing evidence. The loader enforces
   * authority scoping and cursor validity before returning evidence.
   */
  readonly loadSnapshot?: (
    request: ValidationEvidenceRequest,
  ) => Promise<ValidationEvidenceLoadResult> | ValidationEvidenceLoadResult;
}

export function createValidationEvidenceRouteHandler(
  dependencies: ValidationEvidenceRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/validation/evidence") return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure(
        { category: "invalid", message: "Validation evidence requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure(
        { category: "invalid", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure(
        { category: "invalid", message: "Validation evidence requires POST." },
        405,
        origin,
      );
    }
    if (url.search !== "") {
      return failure(
        { category: "invalid", message: "Validation evidence request is invalid." },
        400,
        origin,
      );
    }

    let authenticatedWindowId: WindowId;
    try {
      authenticatedWindowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure(
          { category: "unauthorized", message: "Validation evidence request is unauthorized." },
          401,
          origin,
        );
      }
      return failure(
        { category: "invalid", message: "Validation evidence request is invalid." },
        400,
        origin,
      );
    }

    const decodedBody = await readJson(request, bodyLimit);
    if (decodedBody.kind === "too-large") {
      return failure({ category: "invalid", message: "Request body is too large." }, 413, origin);
    }
    if (decodedBody.kind === "invalid") {
      return failure(
        { category: "invalid", message: "Validation evidence request body is invalid." },
        400,
        origin,
      );
    }

    let evidenceRequest: ValidationEvidenceRequest;
    try {
      evidenceRequest = decodeValidationEvidenceRequest(decodedBody.value);
    } catch {
      return failure(
        { category: "invalid", message: "Validation evidence request is invalid." },
        400,
        origin,
      );
    }

    if (!(await dependencies.authorize(authenticatedWindowId, evidenceRequest.authority))) {
      return failure(
        { category: "unauthorized", message: "Validation evidence request is unauthorized." },
        401,
        origin,
      );
    }

    if (dependencies.loadSnapshot === undefined) {
      return failure(
        {
          category: "unavailable",
          message:
            "Validation evidence store is not available on this host yet. Evidence panes remain honest and fail closed.",
        },
        503,
        origin,
      );
    }

    let result: ValidationEvidenceLoadResult;
    try {
      result = await dependencies.loadSnapshot(evidenceRequest);
    } catch {
      return failure(
        {
          category: "unavailable",
          message: "Validation evidence service is unavailable.",
        },
        503,
        origin,
      );
    }

    if (result.kind === "failure") {
      const status = failureStatus(result.failure);
      return failure(result.failure, status, origin);
    }

    let encoded: string;
    try {
      encoded = JSON.stringify(decodeValidationEvidenceSnapshot(result.snapshot));
    } catch {
      return failure(
        {
          category: "unavailable",
          message: "Validation evidence service is unavailable.",
        },
        503,
        origin,
      );
    }
    return new Response(encoded, {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders(origin) },
    });
  };
}

function failureStatus(failure: ValidationCompositionFailure): number {
  switch (failure.category) {
    case "unauthorized":
      return 401;
    case "replay-denied":
      return 409;
    case "stale":
    case "superseded":
      return 409;
    case "missing":
      return 404;
    case "budget-exceeded":
      return 409;
    case "unavailable":
      return 503;
    case "invalid":
      return 400;
  }
}

function failure(
  body: {
    category: ValidationCompositionFailure["category"];
    message: string;
  },
  status: number,
  origin: string | null,
): Response {
  const payload = decodeValidationCompositionFailure(body);
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  if (text.length === 0) return { kind: "ok", value: {} };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const url = new URL(origin);
    return (
      origin === url.origin &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
