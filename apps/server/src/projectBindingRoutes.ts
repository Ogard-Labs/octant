import { createHash, timingSafeEqual } from "node:crypto";
import { decodeWindowId, type ProjectFailure, type WindowId } from "@octant/contracts";
import type { BindingReceiptStorePort } from "./bindingReceiptStore";
import type { ProjectRootPort } from "./projectRootPort";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import {
  isCanonical256BitToken,
  WindowAuthorityError,
  type WindowAuthorityStore,
} from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;

export interface ProjectBindingRouteDependencies {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly bindingReceiptStore: BindingReceiptStorePort;
  readonly projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
  readonly onWindowRevoked?: (windowId: WindowId) => void;
}

export function createProjectBindingRouteHandler(dependencies: ProjectBindingRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const maxBody = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isAuthorityRoute = url.pathname === "/api/desktop/window-authorities";
    const isReceiptRoute = url.pathname === "/api/desktop/project-binding-receipts";
    if (!isAuthorityRoute && !isReceiptRoute) return undefined;
    if (dependencies.desktopBridgeSecret === undefined) {
      return failure("unavailable", "Desktop Project binding is unavailable.", 503);
    }
    if (
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        dependencies.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return failure("unauthorized", "Desktop Project binding is unauthorized.", 401);
    }
    if (url.search !== "") {
      return failure("invalid", "Desktop Project binding request is invalid.", 400);
    }
    if (isReceiptRoute && request.method !== "POST") {
      return failure("unsupported", "HTTP method is not supported for this route.", 400);
    }
    if (isAuthorityRoute && request.method !== "POST" && request.method !== "DELETE") {
      return failure("unsupported", "HTTP method is not supported for this route.", 400);
    }

    const decoded = await readJson(request, maxBody);
    if (decoded.kind === "too-large") return failure("invalid", "Request body is too large.", 413);
    if (decoded.kind === "invalid") return failure("invalid", "Request body is invalid.", 400);

    try {
      if (isAuthorityRoute && request.method === "POST") {
        const body = decodeAuthorityRegistration(decoded.value);
        dependencies.windowAuthorityStore.register({ ...body, now: now() });
        return new Response(null, { status: 204 });
      }
      if (isAuthorityRoute) {
        const body = decodeAuthorityRevocation(decoded.value);
        dependencies.windowAuthorityStore.revoke(body.windowId);
        dependencies.onWindowRevoked?.(body.windowId);
        return new Response(null, { status: 204 });
      }
      const body = decodeReceiptRequest(decoded.value);
      const canonicalBinding = await dependencies.projectRootPort.validate(
        body.projectType,
        body.path,
      );
      const receipt = dependencies.bindingReceiptStore.issue({
        windowId: body.windowId,
        projectType: body.projectType,
        canonicalBinding,
        now: now(),
      });
      return Response.json(receipt, { status: 201 });
    } catch (error) {
      const category = getErrorCategory(error);
      const clockRecovery = error instanceof WindowAuthorityError;
      return failure(
        category,
        safeMessage(category, clockRecovery),
        category === "unavailable" && clockRecovery ? 503 : category === "conflict" ? 409 : 400,
      );
    }
  };
}

export function authenticateProjectRequest(input: {
  readonly request: Request;
  readonly body: unknown;
  readonly store: WindowAuthorityStore;
  readonly now: number;
}): WindowId {
  const url = new URL(input.request.url);
  if (
    url.searchParams.has("windowId") ||
    (isRecord(input.body) && Object.prototype.hasOwnProperty.call(input.body, "windowId"))
  ) {
    throw new Error("Project requests cannot supply window identity.");
  }
  return authenticateRouteWindowId({
    request: input.request,
    store: input.store,
    now: input.now,
  });
}

function secretsEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function decodeAuthorityRegistration(value: unknown): {
  windowId: WindowId;
  capability: string;
  rendererIdentity?: string;
} {
  requireKeysWithOptional(value, ["windowId", "capability"], ["rendererIdentity"]);
  if (!isCanonical256BitToken(value.capability)) throw new Error("invalid");
  if (value.rendererIdentity !== undefined && !isCanonical256BitToken(value.rendererIdentity)) {
    throw new Error("invalid");
  }
  return {
    windowId: decodeWindowId(value.windowId),
    capability: value.capability,
    ...(value.rendererIdentity === undefined ? {} : { rendererIdentity: value.rendererIdentity }),
  };
}

function decodeAuthorityRevocation(value: unknown): { windowId: WindowId } {
  requireKeys(value, ["windowId"]);
  return { windowId: decodeWindowId(value.windowId) };
}

function decodeReceiptRequest(value: unknown): {
  windowId: WindowId;
  projectType: "work" | "code";
  path: string;
} {
  requireKeys(value, ["windowId", "projectType", "path"]);
  if (value.projectType !== "work" && value.projectType !== "code") throw new Error("invalid");
  if (typeof value.path !== "string" || value.path.length === 0) throw new Error("invalid");
  return {
    windowId: decodeWindowId(value.windowId),
    projectType: value.projectType,
    path: value.path,
  };
}

function requireKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid");
  }
}

function requireKeysWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid");
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw new Error("invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCategory(error: unknown): ProjectFailure["category"] {
  if (isRecord(error) && typeof error.category === "string") {
    if (
      ["invalid", "unauthorized", "unsupported", "unavailable", "conflict"].includes(error.category)
    ) {
      return error.category as ProjectFailure["category"];
    }
  }
  return "invalid";
}

function safeMessage(category: ProjectFailure["category"], clockRecovery = false): string {
  return category === "unavailable"
    ? clockRecovery
      ? "Desktop Project binding is unavailable while host time recovery is required."
      : "The selected Project root is unavailable."
    : "Desktop Project binding request is invalid.";
}

function failure(category: ProjectFailure["category"], message: string, status: number): Response {
  return Response.json({ category, message }, { status });
}
