import type {
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionSnapshot,
  ExtensionToolApproval,
  ExtensionToolApprovalDecision,
  ExtensionToolGrant,
  ExtensionToolGrantRequest,
} from "@octant/contracts/extension-rpc";
import {
  decodeExtensionCommand,
  decodeExtensionToolApprovalDecision,
  decodeExtensionToolGrantRequest,
  decodeDiscoveredAgentToolingRequest,
  decodeMcpServerSignInRequest,
  decodeUserAddedMcpServerRequest,
  type DiscoveredAgentToolingListing,
  type McpServerSignInView,
  type UserAddedMcpServerRequest,
} from "@octant/contracts/extension-rpc";
import { isAbsolute } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { AgentPluginsError } from "@octant/plugin-host/agent-plugins";
import { ClientPrincipalError } from "./clientPrincipal";
import { resolvePrincipalRouteContext, type PrincipalRouteContext } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";
import type { ExtensionSource } from "@octant/contracts/extensions";
import type { LocalPluginFolderRegistry } from "./extensions/localPluginFolderRegistry";
import type { LocalPluginImportReceiptStore } from "./extensions/localPluginImportReceiptStore";
import type { ExtensionToolApprovalAnswerer } from "./extensions/extensionToolApprovalService";
import type { DiscoveredServerRefusal } from "./extensions/agentToolingDiscovery";
import { UserAddedMcpServerError } from "./extensions/userAddedMcpServers";

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
  /** Writes the package for an MCP server a person adds by hand. */
  readonly userAddedMcpServers?: {
    add(request: UserAddedMcpServerRequest): Promise<{ readonly source: ExtensionSource }>;
    remove(sourceRef: string): Promise<void>;
  };
  /** Sign-in to a hosted server a person added, through the host OAuth runner. */
  readonly mcpServerSignIn?: {
    status(
      extensionId: string,
      componentId: string,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
    begin(
      extensionId: string,
      componentId: string,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
    poll(
      extensionId: string,
      componentId: string,
      attemptId: string,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
    signOut(
      extensionId: string,
      componentId: string,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
  };
  /** Lists what other agent tools on this computer know, for the person to add. */
  readonly agentToolingDiscovery?: {
    list(): Promise<DiscoveredAgentToolingListing>;
    server(id: string): UserAddedMcpServerRequest | undefined;
    refusal(id: string): DiscoveredServerRefusal | undefined;
    pluginPath(id: string): string | undefined;
  };
  /**
   * MCP tool prompts, listed and answered by a local window or a paired
   * device. The service decides which prompts each may see and answer, and
   * refuses a paired device's request to remember an answer.
   */
  readonly toolApprovals?: {
    list(answerer: ExtensionToolApprovalAnswerer): ReadonlyArray<ExtensionToolApproval>;
    decide(
      answerer: ExtensionToolApprovalAnswerer,
      decision: ExtensionToolApprovalDecision,
    ): boolean;
  };
  /**
   * Remembered tool approvals, for a local window to read and take away.
   * There is deliberately no way to add one here: a grant is recorded only
   * by answering a prompt through `toolApprovals`.
   */
  readonly toolGrants?: {
    list(): ReadonlyArray<ExtensionToolGrant>;
    revoke(grantId: string): "revoked" | "not-found";
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
      if (options.toolApprovals === undefined) {
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
      const answerer: ExtensionToolApprovalAnswerer = {
        kind: principalContext.principal.kind,
        scopeId: principalContext.scopeId,
      };
      if (hasExactKeys(body.value, ["kind"]) && body.value.kind === "list") {
        return response(options.toolApprovals.list(answerer), 200, origin);
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
        const accepted = options.toolApprovals.decide(answerer, decision);
        return response({ accepted }, accepted ? 200 : 409, origin);
      } catch {
        return response(failure("invalid", "Extension approval decision is invalid."), 400, origin);
      }
    }
    if (url.pathname === "/api/extensions/tool-grants") {
      if (principalContext.principal.kind !== "local-window" || options.toolGrants === undefined) {
        return response(
          failure("unauthorized", "Remembered tool approvals are unavailable."),
          401,
          origin,
        );
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      let grantRequest: ExtensionToolGrantRequest;
      try {
        if (body.kind !== "ok") throw new Error("invalid");
        grantRequest = decodeExtensionToolGrantRequest(body.value);
      } catch {
        return response(
          failure("invalid", "Remembered tool approval request is invalid."),
          400,
          origin,
        );
      }
      if (grantRequest.kind === "list") {
        return response(options.toolGrants.list(), 200, origin);
      }
      // Revoking a grant that is already gone is not a failure: it is gone.
      return response(
        { revoked: options.toolGrants.revoke(grantRequest.grantId) === "revoked" },
        200,
        origin,
      );
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
        return response(withLoaderNotes(inspected, registered.notes), 200, origin);
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
    if (url.pathname === "/api/extensions/user-servers") {
      // Adding a server names a command this host will run or an address it
      // will send a key to, so only a local window may do it, never a paired
      // device, and the whole add is one local act: the package is written,
      // installed, trusted and enabled without a second prompt.
      if (principalContext.principal.kind !== "local-window") {
        return response(
          failure("unauthorized", "Adding an MCP server requires the Octant window on this host."),
          401,
          origin,
        );
      }
      if (options.userAddedMcpServers === undefined) {
        return response(
          failure("unavailable", "Adding an MCP server is unavailable."),
          503,
          origin,
        );
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      let added: UserAddedMcpServerRequest;
      try {
        if (body.kind !== "ok") throw new Error("invalid");
        added = decodeUserAddedMcpServerRequest(body.value);
      } catch {
        return response(failure("invalid", "The server details are invalid."), 400, origin);
      }
      return addUserMcpServer(
        options.service,
        options.userAddedMcpServers,
        added,
        request.signal,
        origin,
      );
    }
    if (url.pathname === "/api/extensions/sign-in") {
      // A sign-in opens the system browser on this host and stores a grant
      // in its broker; a paired device may read the state but never start,
      // finish, or end one.
      if (options.mcpServerSignIn === undefined) {
        return response(
          failure("unavailable", "Signing in to a server is unavailable."),
          503,
          origin,
        );
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      let signIn;
      try {
        if (body.kind !== "ok") throw new Error("invalid");
        signIn = decodeMcpServerSignInRequest(body.value);
      } catch {
        return response(failure("invalid", "The sign-in request is invalid."), 400, origin);
      }
      const principalKind =
        principalContext.principal.kind === "local-window" ? "local-window" : "remote-device";
      const extensionId = String(signIn.extensionId);
      const componentId = String(signIn.componentId);
      try {
        if (signIn.kind === "status") {
          return response(
            await options.mcpServerSignIn.status(extensionId, componentId, principalKind),
            200,
            origin,
          );
        }
        if (signIn.kind === "begin") {
          return response(
            await options.mcpServerSignIn.begin(extensionId, componentId, principalKind),
            200,
            origin,
          );
        }
        if (signIn.kind === "poll") {
          return response(
            await options.mcpServerSignIn.poll(
              extensionId,
              componentId,
              signIn.attemptId,
              principalKind,
            ),
            200,
            origin,
          );
        }
        return response(
          await options.mcpServerSignIn.signOut(extensionId, componentId, principalKind),
          200,
          origin,
        );
      } catch {
        return response(failure("failed", "The sign-in could not be read."), 500, origin);
      }
    }
    if (url.pathname === "/api/extensions/discovered") {
      // What another tool on this computer knows is read for a local window
      // only, like the folder import it leads to; a paired device sees none
      // of it. Adding a found server is the same act as adding one by hand.
      if (principalContext.principal.kind !== "local-window") {
        return response(
          failure(
            "unauthorized",
            "Finding servers on this computer requires the Octant window on it.",
          ),
          401,
          origin,
        );
      }
      if (options.agentToolingDiscovery === undefined) {
        return response(
          failure("unavailable", "Finding servers on this computer is unavailable."),
          503,
          origin,
        );
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      let discovered;
      try {
        if (body.kind !== "ok") throw new Error("invalid");
        discovered = decodeDiscoveredAgentToolingRequest(body.value);
      } catch {
        return response(failure("invalid", "The request is invalid."), 400, origin);
      }
      if (discovered.kind === "list") {
        try {
          return response(await options.agentToolingDiscovery.list(), 200, origin);
        } catch {
          return response(
            failure("failed", "The other tools' files could not be read."),
            500,
            origin,
          );
        }
      }
      if (discovered.kind === "add-server") {
        const found = options.agentToolingDiscovery.server(discovered.id);
        if (found === undefined || options.userAddedMcpServers === undefined) {
          return response(
            failure("stale", "That server is no longer listed. Look again."),
            404,
            origin,
          );
        }
        const refusal = options.agentToolingDiscovery.refusal(discovered.id);
        if (refusal !== undefined) {
          const names = refusal.names.join(", ");
          return response(
            failure(
              "invalid",
              refusal.kind === "unsupported-placeholders"
                ? `Octant does not copy ${names} into this server's command or address. Add it by hand with the value filled in.`
                : `This server needs a value for ${names}. Add it by hand and enter it there.`,
            ),
            400,
            origin,
          );
        }
        return addUserMcpServer(
          options.service,
          options.userAddedMcpServers,
          found,
          request.signal,
          origin,
        );
      }
      const path = options.agentToolingDiscovery.pluginPath(discovered.id);
      if (path === undefined || options.localPluginFolderRegistry === undefined) {
        return response(
          failure("stale", "That plugin is no longer listed. Look again."),
          404,
          origin,
        );
      }
      try {
        const registered = await options.localPluginFolderRegistry.register(path);
        const inspected = await options.service.execute(
          { kind: "inspect-package", source: registered.source },
          request.signal,
        );
        return response(withLoaderNotes(inspected, registered.notes), 200, origin);
      } catch (error) {
        if (error instanceof AgentPluginsError) {
          return response(failure("invalid", error.message), 400, origin);
        }
        return response(
          failure("invalid", "The plugin folder could not be imported."),
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
    command.kind === "review-skill" ||
    command.kind === "trust-skill-source" ||
    command.kind === "set-skill-desired" ||
    command.kind === "select-skill-collision" ||
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
    | ReadonlyArray<ExtensionToolGrant>
    | { readonly accepted: boolean }
    | { readonly revoked: boolean }
    | DiscoveredAgentToolingListing
    | McpServerSignInView,
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

/**
 * Adds a server the person named: the host writes its package, then installs,
 * trusts and switches it on as one act, because the person just asked for
 * exactly that; the ladder still records each step.
 */
/**
 * What the loader left out of another tool's plugin rides on the inspection's
 * own diagnostics, so the review that precedes Install shows the omission.
 */
function withLoaderNotes(
  inspected: ExtensionCommandResult,
  notes: ReadonlyArray<string>,
): ExtensionCommandResult {
  if (notes.length === 0 || inspected.kind !== "package-inspected") return inspected;
  const added = notes.map((note, index) => ({
    code: `plugin-left-out-${index + 1}`,
    message: note.replaceAll("/", " ").replaceAll("\\", " ").slice(0, 1024),
  }));
  return {
    ...inspected,
    preview: {
      ...inspected.preview,
      diagnostics: [...inspected.preview.diagnostics, ...added].slice(0, 128),
    },
  };
}

async function addUserMcpServer(
  service: ExtensionRouteService,
  store: {
    add(request: UserAddedMcpServerRequest): Promise<{ readonly source: ExtensionSource }>;
    remove(sourceRef: string): Promise<void>;
  },
  added: UserAddedMcpServerRequest,
  signal: AbortSignal,
  origin: string | null,
): Promise<Response> {
  let source: ExtensionSource;
  try {
    source = (await store.add(added)).source;
  } catch (error) {
    // Like every other extension command, a refusal is a typed result the
    // client decodes, so it travels as a 200 and the dialog can show the
    // host's own words. The failure vocabulary has no "conflict", so a taken
    // name is an invalid request.
    if (error instanceof UserAddedMcpServerError) {
      const category =
        error.category === "unavailable"
          ? "unavailable"
          : error.category === "failed"
            ? "failed"
            : "invalid";
      return response(failure(category, error.message), 200, origin);
    }
    return response(failure("invalid", "The server could not be added."), 200, origin);
  }
  // `add` wrote and registered the package, so any refusal or failure before
  // it is installed removes it again; otherwise the same name would report a
  // conflict on every retry.
  const abandon = async (result: ExtensionCommandResult) => {
    if ("sourceRef" in source) await store.remove(source.sourceRef).catch(() => undefined);
    return response(result, 200, origin);
  };
  let inspected: ExtensionCommandResult;
  try {
    inspected = await service.execute({ kind: "inspect-package", source }, signal);
  } catch {
    return await abandon(failure("failed", "The server could not be inspected."));
  }
  if (inspected.kind !== "package-inspected") return await abandon(inspected);
  const entry = inspected.preview.entry;
  let installed: ExtensionCommandResult;
  try {
    installed = await service.execute(
      {
        kind: "install-package",
        extensionId: entry.extensionId,
        packageId: entry.packageId,
        version: entry.version,
        digest: entry.digest,
      },
      signal,
    );
  } catch {
    return await abandon(failure("failed", "The server could not be installed."));
  }
  if (installed.kind !== "extension-state-updated") return await abandon(installed);
  // The person just typed this server in, so trusting and switching it on is
  // what they asked for; the ladder still records each step.
  let current = installed;
  const enable = async (command: Readonly<Record<string, unknown>>) => {
    const state = current.snapshot.packages.find(
      (candidate) => candidate.extensionId === entry.extensionId,
    );
    if (state === undefined) return;
    const result = await service.execute(
      decodeExtensionCommand({
        ...command,
        commandVersion: 1,
        extensionId: String(entry.extensionId),
        expectedStateVersion: Number(state.stateVersion),
      }),
      signal,
    );
    if (result.kind === "extension-state-updated") current = result;
  };
  await enable({ kind: "set-source-trust", trusted: true });
  await enable({ kind: "set-plugin-desired", desired: true });
  const installedState = current.snapshot.packages.find(
    (candidate) => candidate.extensionId === entry.extensionId,
  );
  for (const component of installedState?.components ?? []) {
    if (component.component.kind !== "mcp-server") continue;
    await enable({
      kind: "set-component-desired",
      componentId: component.component.id,
      desired: true,
    });
  }
  const addedComponent = installedState?.components.find(
    (component) => component.component.kind === "mcp-server",
  );
  return response(
    {
      ...current,
      addedPackage: {
        extensionId: entry.extensionId,
        ...(addedComponent === undefined ? {} : { componentId: addedComponent.component.id }),
      },
    },
    200,
    origin,
  );
}
