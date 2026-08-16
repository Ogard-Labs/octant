import type {
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionSnapshot,
  ExtensionToolApproval,
  ExtensionToolApprovalDecision,
} from "@octant/contracts/extension-rpc";
import {
  decodeExtensionCommand,
  decodeExtensionToolApprovalDecision,
} from "@octant/contracts/extension-rpc";
import { isAbsolute } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { AgentPluginsError } from "@octant/extensions/agent-plugins";
import { ClientPrincipalError } from "./clientPrincipal";
import { resolvePrincipalRouteContext, type PrincipalRouteContext } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";
import type { LocalPluginFolderRegistry } from "./extensions/localPluginFolderRegistry";
import type { LocalPluginImportReceiptStore } from "./extensions/localPluginImportReceiptStore";

export interface ExtensionRouteService {
  snapshot(): ExtensionSnapshot;
  execute(command: ExtensionCommand, signal?: AbortSignal): Promise<ExtensionCommandResult>;
}

export function createExtensionRouteHandler(options: {
  readonly service: ExtensionRouteService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
  readonly desktopBridgeSecret?: string;
  readonly localPluginFolderRegistry?: LocalPluginFolderRegistry;
  readonly localPluginImportReceipts?: LocalPluginImportReceiptStore;
  readonly toolApprovals?: {
    list(windowId: ReturnType<typeof decodeWindowId>): ReadonlyArray<ExtensionToolApproval>;
    decide(
      windowId: ReturnType<typeof decodeWindowId>,
      decision: ExtensionToolApprovalDecision,
    ): boolean;
  };
}): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  const maximumBodySize = options.maxRequestBodySize ?? 1_048_576;
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/extensions/")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return response(failure("invalid", "Extension API requires loopback."), 400, origin);
    }
    if (url.pathname === "/api/extensions/import-local-receipts") {
      if (
        request.method !== "POST" ||
        origin !== null ||
        options.desktopBridgeSecret === undefined ||
        options.localPluginImportReceipts === undefined ||
        !secretsEqual(
          options.desktopBridgeSecret,
          request.headers.get("x-octant-desktop-secret") ?? "",
        )
      ) {
        return response(
          failure("unauthorized", "Local plugin folder receipt is unauthorized."),
          401,
          null,
        );
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, null);
      }
      if (body.kind !== "ok" || !hasExactKeys(body.value, ["absolutePath", "windowId"])) {
        return response(failure("invalid", "Local plugin receipt request is invalid."), 400, null);
      }
      const absolutePath = body.value.absolutePath;
      if (typeof absolutePath !== "string" || !isAbsolute(absolutePath)) {
        return response(failure("invalid", "Local plugin path must be absolute."), 400, null);
      }
      try {
        const receipt = options.localPluginImportReceipts.issue({
          windowId: String(decodeWindowId(body.value.windowId)),
          absolutePath,
          now: now(),
        });
        return Response.json(receipt, { status: 201 });
      } catch {
        return response(failure("invalid", "Local plugin receipt request is invalid."), 400, null);
      }
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return response(failure("invalid", "Renderer origin is not allowed."), 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let principalContext: PrincipalRouteContext;
    try {
      principalContext = resolvePrincipalRouteContext({
        request,
        store: options.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return response(
        failure(
          error instanceof ClientPrincipalError ? "unauthorized" : "invalid",
          "Extension API request is unauthorized.",
        ),
        error instanceof ClientPrincipalError ? 401 : 400,
        origin,
      );
    }
    if (request.method !== "POST") {
      return response(failure("invalid", "Extension API requires POST."), 405, origin);
    }
    if (url.pathname === "/api/extensions/tool-approvals") {
      if (
        principalContext.principal.kind !== "local-window" ||
        options.toolApprovals === undefined
      ) {
        return response(
          failure("unauthorized", "Extension tool approval is unavailable."),
          401,
          origin,
        );
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      if (body.kind !== "ok") {
        return response(failure("invalid", "Extension approval request is invalid."), 400, origin);
      }
      if (hasExactKeys(body.value, ["kind"]) && body.value.kind === "list") {
        return response(
          options.toolApprovals.list(decodeWindowId(principalContext.principal.windowId)),
          200,
          origin,
        );
      }
      try {
        if (
          typeof body.value !== "object" ||
          body.value === null ||
          (body.value as { kind?: unknown }).kind !== "decide"
        ) {
          throw new Error("invalid");
        }
        const { kind: _kind, ...rawDecision } = body.value as Record<string, unknown>;
        const decision = decodeExtensionToolApprovalDecision(rawDecision);
        const accepted = options.toolApprovals.decide(
          decodeWindowId(principalContext.principal.windowId),
          decision,
        );
        return response({ accepted }, accepted ? 200 : 409, origin);
      } catch {
        return response(failure("invalid", "Extension approval decision is invalid."), 400, origin);
      }
    }
    if (url.pathname === "/api/extensions/snapshot") {
      try {
        return response(options.service.snapshot(), 200, origin);
      } catch {
        return response(failure("failed", "Extension snapshot failed."), 500, origin);
      }
    }
    if (url.pathname === "/api/extensions/import-local") {
      if (principalContext.principal.kind !== "local-window") {
        return response(
          failure("unauthorized", "Local plugin import requires a local folder picker."),
          401,
          origin,
        );
      }
      if (options.localPluginFolderRegistry === undefined) {
        return response(failure("unavailable", "Local plugin import is unavailable."), 503, origin);
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      if (body.kind === "invalid") {
        return response(failure("invalid", "Extension request body is invalid."), 400, origin);
      }
      const receiptId =
        hasExactKeys(body.value, ["receiptId"]) && typeof body.value.receiptId === "string"
          ? body.value.receiptId
          : undefined;
      if (receiptId === undefined || options.localPluginImportReceipts === undefined) {
        return response(failure("invalid", "Local plugin receipt is invalid."), 400, origin);
      }
      const absolutePath = options.localPluginImportReceipts.consume({
        receiptId,
        windowId: String(principalContext.principal.windowId),
        now: now(),
      });
      if (absolutePath === undefined) {
        return response(failure("invalid", "Local plugin receipt is invalid."), 400, origin);
      }
      try {
        const registered = await options.localPluginFolderRegistry.register(absolutePath);
        const inspected = await options.service.execute(
          { kind: "inspect-package", source: registered.source },
          request.signal,
        );
        return response(inspected, 200, origin);
      } catch (error) {
        if (error instanceof AgentPluginsError) {
          return response(failure("invalid", error.message), 400, origin);
        }
        return response(
          failure("invalid", "Local plugin folder could not be imported."),
          400,
          origin,
        );
      }
    }
    if (
      url.pathname !== "/api/extensions/inspect" &&
      url.pathname !== "/api/extensions/preview" &&
      url.pathname !== "/api/extensions/catalog" &&
      url.pathname !== "/api/extensions/state" &&
      url.pathname !== "/api/extensions/lifecycle" &&
      url.pathname !== "/api/extensions/skills"
    ) {
      return undefined;
    }
    const body = await readBody(request, maximumBodySize);
    if (body.kind === "too-large") {
      return response(failure("invalid", "Extension request is too large."), 413, origin);
    }
    if (body.kind === "invalid") {
      return response(failure("invalid", "Extension request body is invalid."), 400, origin);
    }
    let command: ExtensionCommand;
    try {
      command = decodeExtensionCommand(body.value);
    } catch {
      return response(failure("invalid", "Extension command is invalid."), 400, origin);
    }
    if (
      (url.pathname === "/api/extensions/inspect" && command.kind !== "inspect-package") ||
      (url.pathname === "/api/extensions/preview" && command.kind !== "preview-package") ||
      (url.pathname === "/api/extensions/catalog" && command.kind !== "search-catalog") ||
      (url.pathname === "/api/extensions/state" && command.kind !== "query-effective-state") ||
      (url.pathname === "/api/extensions/lifecycle" && !isLifecycleCommand(command)) ||
      (url.pathname === "/api/extensions/skills" && !isSkillCommand(command))
    ) {
      return response(
        failure("invalid", "Extension command is unavailable on this route."),
        400,
        origin,
      );
    }
    try {
      return response(await options.service.execute(command, request.signal), 200, origin);
    } catch {
      return response(failure("failed", "Extension command failed."), 500, origin);
    }
  };
}

function isLifecycleCommand(command: ExtensionCommand): boolean {
  return (
    command.kind === "install-package" ||
    command.kind === "update-package" ||
    command.kind === "rollback-package" ||
    command.kind === "uninstall-package" ||
    command.kind === "set-source-trust" ||
    command.kind === "set-plugin-desired" ||
    command.kind === "set-component-desired" ||
    command.kind === "install-skill" ||
    command.kind === "update-skill" ||
    command.kind === "remove-skill" ||
    command.kind === "reconcile-skills"
  );
}

function isSkillCommand(command: ExtensionCommand): boolean {
  return (
    command.kind === "search-skills" ||
    command.kind === "preview-skill" ||
    command.kind === "install-skill" ||
    command.kind === "update-skill" ||
    command.kind === "remove-skill" ||
    command.kind === "reconcile-skills"
  );
}

async function readBody(
  request: Request,
  maximumBodySize: number,
): Promise<
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" }
> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBodySize) {
    return { kind: "too-large" };
  }
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return { kind: "invalid" };
    if (bytes.byteLength > maximumBodySize) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: "invalid" };
  }
}

function failure(
  category:
    | "invalid"
    | "unauthorized"
    | "blocked"
    | "stale"
    | "unavailable"
    | "interrupted"
    | "waiting"
    | "failed",
  message: string,
): ExtensionCommandResult {
  return { kind: "extension-command-failed", failure: { category, message } };
}

function response(
  value:
    | ExtensionCommandResult
    | ExtensionSnapshot
    | ReadonlyArray<ExtensionToolApproval>
    | { readonly accepted: boolean },
  status: number,
  origin: string | null,
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
  };
}

function secretsEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
