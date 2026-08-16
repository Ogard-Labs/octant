import { createHash, timingSafeEqual } from "node:crypto";
import {
  CodeCheckoutId,
  ManagedRootGrantId,
  WorktreeReceiptId,
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  type BindingRevisionId,
  type CodeRepositoryId,
  type CodeThreadId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { isLoopbackHostname } from "./shellRoutes";
import type { ManagedWorktreeSourceProvenance } from "./code/managedWorktreeReceiptStore";

const DEFAULT_BODY_LIMIT = 1_048_576;
const decodeCheckoutId = Schema.decodeUnknownSync(CodeCheckoutId);
const decodeGrantId = Schema.decodeUnknownSync(ManagedRootGrantId);
const decodeReceiptId = Schema.decodeUnknownSync(WorktreeReceiptId);

interface CreationContext {
  readonly authenticatedWindowId: WindowId;
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly repositoryId: CodeRepositoryId;
  readonly repositoryRoot: string;
  readonly threadId: CodeThreadId;
  readonly checkoutId: typeof CodeCheckoutId.Type;
  readonly branchIntent: string;
  readonly refIntent: string;
  readonly startFromOrigin?: boolean;
  readonly remoteName?: string;
}

interface ManagedRootServicePort {
  readonly planCreation: (
    input: CreationContext,
    signal: AbortSignal,
  ) => Promise<
    | {
        readonly status: "planned";
        readonly grant: { readonly grantId: string; readonly expiresAt: number };
      }
    | { readonly status: "refused"; readonly reason: string }
    | { readonly status: "unavailable" }
  >;
  readonly create: (
    input: CreationContext & { readonly grantId: string },
    signal: AbortSignal,
  ) => Promise<
    | {
        readonly status: "ready";
        readonly receipt: {
          readonly receiptId: string;
          readonly source?: ManagedWorktreeSourceProvenance;
        };
      }
    | { readonly status: "interrupted" | "refused"; readonly reason?: string }
  >;
  readonly cleanup: (
    input: { readonly receiptId: string; readonly confirmedByLocalUser: true },
    signal: AbortSignal,
  ) => Promise<
    | { readonly status: "removed"; readonly receipt: { readonly receiptId: string } }
    | { readonly status: "interrupted" | "refused"; readonly reason?: string }
  >;
}

export interface CodeManagedRootRouteDependencies {
  readonly desktopBridgeSecret: string | undefined;
  readonly resolveRepositoryRoot: (
    projectId: ProjectId,
    bindingRevisionId: BindingRevisionId,
  ) => Promise<string>;
  readonly service: ManagedRootServicePort;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createCodeManagedRootRouteHandler(dependencies: CodeManagedRootRouteDependencies) {
  const maxBody = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const route = routeKind(url.pathname);
    if (route === undefined) return undefined;
    if (dependencies.desktopBridgeSecret === undefined) {
      return failure("unavailable", "Managed Code worktrees are unavailable.", 503);
    }
    if (
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        dependencies.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return failure("unauthorized", "Managed Code worktree request is unauthorized.", 401);
    }
    if (url.search !== "" || request.method !== route.method) {
      return failure("invalid", "Managed Code worktree request is invalid.", 400);
    }
    const decoded = await readJson(request, maxBody);
    if (decoded.kind === "too-large") return failure("invalid", "Request body is too large.", 413);
    if (decoded.kind === "invalid") return failure("invalid", "Request body is invalid.", 400);

    try {
      if (route.kind === "cleanup") {
        const body = decodeCleanup(decoded.value);
        if (!body.confirmedByLocalUser) {
          return failure("unauthorized", "Local cleanup confirmation is required.", 400);
        }
        const result = await dependencies.service.cleanup(
          { receiptId: body.receiptId, confirmedByLocalUser: true },
          request.signal,
        );
        if (result.status !== "removed") return serviceFailure(result.status, result.reason);
        return Response.json({ status: "removed", receiptId: result.receipt.receiptId });
      }

      const body = decodeCreation(decoded.value, route.kind === "create");
      const repositoryRoot = await dependencies.resolveRepositoryRoot(
        body.projectId,
        body.bindingRevisionId,
      );
      const context: CreationContext = {
        authenticatedWindowId: body.windowId,
        projectId: body.projectId,
        bindingRevisionId: body.bindingRevisionId,
        repositoryId: body.repositoryId,
        repositoryRoot,
        threadId: body.threadId,
        checkoutId: body.checkoutId,
        branchIntent: body.branchIntent,
        refIntent: body.refIntent,
        ...(body.startFromOrigin === undefined ? {} : { startFromOrigin: body.startFromOrigin }),
        ...(body.remoteName === undefined ? {} : { remoteName: body.remoteName }),
      };
      if (route.kind === "plan") {
        const result = await dependencies.service.planCreation(context, request.signal);
        if (result.status !== "planned") {
          return serviceFailure(
            result.status,
            result.status === "refused" ? result.reason : undefined,
          );
        }
        return Response.json(
          { grantId: result.grant.grantId, expiresAt: result.grant.expiresAt },
          { status: 201 },
        );
      }
      if (body.grantId === undefined) throw new Error("invalid");
      const result = await dependencies.service.create(
        { ...context, grantId: body.grantId },
        request.signal,
      );
      if (result.status !== "ready") return serviceFailure(result.status, result.reason);
      return Response.json(
        {
          status: "ready",
          receiptId: result.receipt.receiptId,
          checkoutId: body.checkoutId,
          ...(result.receipt.source === undefined ? {} : { source: result.receipt.source }),
        },
        { status: 201 },
      );
    } catch {
      return failure("invalid", "Managed Code worktree request is invalid.", 400);
    }
  };
}

function routeKind(
  pathname: string,
):
  | { readonly kind: "plan"; readonly method: "POST" }
  | { readonly kind: "create"; readonly method: "POST" }
  | { readonly kind: "cleanup"; readonly method: "DELETE" }
  | undefined {
  if (pathname === "/api/desktop/code-managed-root-grants") return { kind: "plan", method: "POST" };
  if (pathname === "/api/desktop/code-managed-worktrees") return { kind: "create", method: "POST" };
  if (pathname === "/api/desktop/code-managed-worktrees/cleanup") {
    return { kind: "cleanup", method: "DELETE" };
  }
  return undefined;
}

function decodeCreation(value: unknown, withGrant: boolean) {
  const keys = [
    "windowId",
    "projectId",
    "bindingRevisionId",
    "repositoryId",
    "threadId",
    "checkoutId",
    "branchIntent",
    "refIntent",
    ...(Object.prototype.hasOwnProperty.call(value, "startFromOrigin") ? ["startFromOrigin"] : []),
    ...(Object.prototype.hasOwnProperty.call(value, "remoteName") ? ["remoteName"] : []),
    ...(withGrant ? ["grantId"] : []),
  ];
  requireKeys(value, keys);
  if (!isIntent(value.branchIntent, 255) || !isIntent(value.refIntent, 512))
    throw new Error("invalid");
  if (value.startFromOrigin !== undefined && typeof value.startFromOrigin !== "boolean") {
    throw new Error("invalid");
  }
  if (value.remoteName !== undefined && !isIntent(value.remoteName, 255)) {
    throw new Error("invalid");
  }
  return {
    windowId: decodeWindowId(value.windowId),
    projectId: decodeProjectId(value.projectId),
    bindingRevisionId: decodeBindingRevisionId(value.bindingRevisionId),
    repositoryId: decodeCodeRepositoryId(value.repositoryId),
    threadId: decodeCodeThreadId(value.threadId),
    checkoutId: decodeCheckoutId(value.checkoutId),
    branchIntent: value.branchIntent,
    refIntent: value.refIntent,
    ...(value.startFromOrigin === undefined ? {} : { startFromOrigin: value.startFromOrigin }),
    ...(value.remoteName === undefined ? {} : { remoteName: value.remoteName }),
    ...(withGrant ? { grantId: decodeGrantId(value.grantId) } : {}),
  };
}

function decodeCleanup(value: unknown) {
  requireKeys(value, ["windowId", "receiptId", "confirmedByLocalUser"]);
  return {
    windowId: decodeWindowId(value.windowId),
    receiptId: decodeReceiptId(value.receiptId),
    confirmedByLocalUser: value.confirmedByLocalUser === true,
  };
}

function requireKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid");
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("invalid");
  }
}

function isIntent(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function secretsEqual(expected: string, actual: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(expected, "utf8").digest(),
    createHash("sha256").update(actual, "utf8").digest(),
  );
}

async function readJson(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" as const };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" as const };
  try {
    return { kind: "ok" as const, value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" as const };
  }
}

function serviceFailure(
  status: "refused" | "interrupted" | "unavailable",
  reason?: string,
): Response {
  if (status === "unavailable") {
    return failure(
      "unavailable",
      "Managed Code worktree operation is temporarily unavailable.",
      503,
    );
  }
  return status === "interrupted"
    ? failure("interrupted", "Managed Code worktree operation was interrupted.", 503)
    : failure("unavailable", reason ?? "Managed Code worktree operation was refused.", 409);
}

function failure(category: string, message: string, status: number): Response {
  return Response.json({ category, message }, { status });
}
