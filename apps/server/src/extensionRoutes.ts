import { principalAuthorityKind } from "./clientPrincipal";
import { principalActsAsHostPerson } from "./clientPrincipal";
import type { McpOAuthClientRegistration } from "@octant/contracts/host-oauth";
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
  decodeExtensionProjectPinRequest,
  decodeMcpServerSignInRequest,
  decodeMcpServerConnectionRequest,
  decodeUserAddedMcpServerRequest,
  type McpServerConnectionListing,
  type McpServerReconnectResult,
  type DiscoveredAgentToolingListing,
  type RuntimeCompactionDefaults,
  type ExtensionProjectPinListing,
  type McpServerSignInView,
  type McpClientSetupInput,
  type UserAddedMcpServerRequest,
} from "@octant/contracts/extension-rpc";
import { isAbsolute } from "node:path";
import { decodeWindowId, SkillFolderPath, type EventActor } from "@octant/contracts";
import { eventActorForPrincipal } from "./principalEventActor";
import { Schema } from "effect";
import { AgentPluginsError } from "@octant/plugin-host/agent-plugins";
import { admitDesktopBroker, admitsWindow } from "./desktopBrokerAdmission";
import { ClientPrincipalError, resolveLocalWindowPrincipal } from "./clientPrincipal";
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
  execute(
    command: ExtensionCommand,
    signal?: AbortSignal,
    actor?: EventActor,
  ): Promise<ExtensionCommandResult>;
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
  /** Plugins pinned to Projects, and the Projects a local window may pin to. */
  readonly extensionProjectPins?: {
    list(): ExtensionProjectPinListing;
    set(
      projectId: string,
      extensionId: string,
      pinned: boolean,
      actor?: EventActor,
    ): "recorded" | "refused";
  };
  /** Sign-in to a hosted server a person added, through the host OAuth runner. */
  readonly mcpServerSignIn?: {
    prepareClient?(
      extensionId: string,
      componentId: string,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
    saveClient?(
      extensionId: string,
      componentId: string,
      setup: McpClientSetupInput,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
    configureClient(
      extensionId: string,
      componentId: string,
      registration: McpOAuthClientRegistration,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
    status(
      extensionId: string,
      componentId: string,
      principalKind: "local-window" | "remote-device",
    ): Promise<McpServerSignInView>;
    begin(
      extensionId: string,
      componentId: string,
      principalKind: "local-window" | "remote-device",
      actor?: EventActor,
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
      actor?: EventActor,
    ): Promise<McpServerSignInView>;
  };
  /**
   * How each installed MCP server is connecting, read from retained facts.
   * A paired device may read it; only a local window may reconnect.
   */
  readonly mcpServerConnections?: {
    list(): Promise<McpServerConnectionListing>;
    reconnect(extensionId: string, componentId: string): Promise<McpServerReconnectResult>;
  };
  /** Lists what other agent tools on this computer know, for the person to add. */
  readonly agentToolingDiscovery?: {
    list(): Promise<DiscoveredAgentToolingListing>;
    server(id: string): UserAddedMcpServerRequest | undefined;
    refusal(id: string): DiscoveredServerRefusal | undefined;
    pluginPath(id: string): string | undefined;
    compactionDefaults(): Promise<RuntimeCompactionDefaults>;
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
    revoke(grantId: string, actor?: EventActor): "revoked" | "not-found";
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
      const admission = admitDesktopBroker({
        request,
        desktopBridgeSecret: options.desktopBridgeSecret,
        windowAuthorityStore: options.windowAuthorityStore,
        now: now(),
      });
      if (
        request.method !== "POST" ||
        options.desktopBridgeSecret === undefined ||
        options.localPluginImportReceipts === undefined ||
        admission.status !== "admitted"
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
      if (
        body.kind !== "ok" ||
        (!hasExactKeys(body.value, ["absolutePath", "windowId"]) &&
          !(
            hasExactKeys(body.value, ["absolutePath", "windowId", "purpose"]) &&
            body.value.purpose === "skill-folder"
          ))
      ) {
        return response(failure("invalid", "Local plugin receipt request is invalid."), 400, null);
      }
      const absolutePath = body.value.absolutePath;
      if (typeof absolutePath !== "string" || !isAbsolute(absolutePath)) {
        return response(failure("invalid", "Local plugin path must be absolute."), 400, null);
      }
      if (!admitsWindow(admission, body.value.windowId)) {
        return response(
          failure("unauthorized", "Local plugin folder receipt is unauthorized."),
          401,
          null,
        );
      }
      try {
        const receipt = options.localPluginImportReceipts.issue({
          windowId: String(decodeWindowId(body.value.windowId)),
          absolutePath,
          now: now(),
          ...(body.value.purpose === "skill-folder" ? { purpose: "skill-folder" as const } : {}),
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
    // Who the journal names for what this request changes: the device, when a
    // device asked.
    const actor = eventActorForPrincipal(principalContext.principal);
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
        kind: principalAuthorityKind(principalContext.principal),
        scopeId: principalContext.scopeId,
        actor,
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
      if (
        !principalActsAsHostPerson(principalContext.principal) ||
        options.toolGrants === undefined
      ) {
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
        { revoked: options.toolGrants.revoke(grantRequest.grantId, actor) === "revoked" },
        200,
        origin,
      );
    }
    if (url.pathname === "/api/extensions/snapshot") {
      try {
        const snapshot = options.service.snapshot();
        if (principalActsAsHostPerson(principalContext.principal))
          return response(snapshot, 200, origin);
        const { skillRoots: _localRootDiagnostics, ...remoteSnapshot } = snapshot;
        return response(remoteSnapshot, 200, origin);
      } catch {
        return response(failure("failed", "Extension snapshot failed."), 500, origin);
      }
    }
    if (url.pathname === "/api/extensions/skill-folder-selection") {
      if (
        principalContext.principal.kind !== "local-window" ||
        options.localPluginImportReceipts === undefined
      )
        return response(
          failure("unauthorized", "Choose a skill folder in the local desktop window."),
          401,
          origin,
        );
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large")
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      if (
        body.kind !== "ok" ||
        !hasExactKeys(body.value, ["receiptId"]) ||
        typeof body.value.receiptId !== "string"
      )
        return response(failure("invalid", "Skill folder receipt is invalid."), 400, origin);
      try {
        const current = resolveLocalWindowPrincipal({
          request,
          body: body.value,
          store: options.windowAuthorityStore,
          now: now(),
        });
        if (current.windowId !== principalContext.principal.windowId) throw new Error("changed");
      } catch {
        return response(
          failure("unauthorized", "Skill folder selection is unauthorized."),
          401,
          origin,
        );
      }
      const path = options.localPluginImportReceipts.consume({
        receiptId: body.value.receiptId,
        windowId: String(principalContext.principal.windowId),
        purpose: "skill-folder",
        now: now(),
      });
      try {
        const folderPath = Schema.decodeUnknownSync(SkillFolderPath)(path);
        return Response.json({ folderPath }, { status: 200, headers: corsHeaders(origin) });
      } catch {
        return response(
          failure(
            "invalid",
            "Skill folder receipt expired or is unavailable. Choose the folder again.",
          ),
          400,
          origin,
        );
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
      if (!principalActsAsHostPerson(principalContext.principal)) {
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
        actor,
      );
    }
    if (url.pathname === "/api/extensions/project-pins") {
      // A pin changes what every turn in a Project carries, so only a local
      // window sets one; a paired device may read the list.
      if (options.extensionProjectPins === undefined) {
        return response(
          failure("unavailable", "Pinning plugins to a Project is unavailable."),
          503,
          origin,
        );
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      let pin;
      try {
        if (body.kind !== "ok") throw new Error("invalid");
        pin = decodeExtensionProjectPinRequest(body.value);
      } catch {
        return response(failure("invalid", "The pin request is invalid."), 400, origin);
      }
      if (pin.kind === "set") {
        if (!principalActsAsHostPerson(principalContext.principal)) {
          return response(
            failure("unauthorized", "Pinning a plugin requires the Octant window on this host."),
            401,
            origin,
          );
        }
        const outcome = options.extensionProjectPins.set(
          String(pin.projectId),
          String(pin.extensionId),
          pin.pinned,
          actor,
        );
        if (outcome === "refused") {
          return response(
            failure("invalid", "That plugin cannot be pinned to that Project."),
            400,
            origin,
          );
        }
      }
      return response(options.extensionProjectPins.list(), 200, origin);
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
      // A device the host's own person paired is judged as a local window is.
      const principalKind = principalActsAsHostPerson(principalContext.principal)
        ? "local-window"
        : "remote-device";
      const extensionId = String(signIn.extensionId);
      const componentId = String(signIn.componentId);
      try {
        if (signIn.kind === "prepare-client" || signIn.kind === "save-client") {
          if (principalKind !== "local-window")
            return response(
              failure("unauthorized", "Set up the client from the Octant window on this host."),
              401,
              origin,
            );
          const view =
            signIn.kind === "prepare-client"
              ? await options.mcpServerSignIn.prepareClient?.(
                  extensionId,
                  componentId,
                  principalKind,
                )
              : await options.mcpServerSignIn.saveClient?.(
                  extensionId,
                  componentId,
                  signIn.setup,
                  principalKind,
                );
          return response(
            view ?? {
              kind: "refused",
              reason: "unavailable",
              message: "Client setup is unavailable on this host.",
            },
            200,
            origin,
          );
        }
        if (signIn.kind === "configure-client") {
          if (principalKind !== "local-window")
            return response(
              failure("unauthorized", "Set up the client from the Octant window on this host."),
              401,
              origin,
            );
          return response(
            await options.mcpServerSignIn.configureClient(
              extensionId,
              componentId,
              signIn.registration,
              principalKind,
            ),
            200,
            origin,
          );
        }
        if (signIn.kind === "status") {
          return response(
            await options.mcpServerSignIn.status(extensionId, componentId, principalKind),
            200,
            origin,
          );
        }
        if (signIn.kind === "begin") {
          return response(
            await options.mcpServerSignIn.begin(extensionId, componentId, principalKind, actor),
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
          await options.mcpServerSignIn.signOut(extensionId, componentId, principalKind, actor),
          200,
          origin,
        );
      } catch {
        return response(failure("failed", "The sign-in could not be read."), 500, origin);
      }
    }
    if (url.pathname === "/api/extensions/connections") {
      if (options.mcpServerConnections === undefined) {
        return response(failure("unavailable", "Server connections are unavailable."), 503, origin);
      }
      const body = await readBody(request, maximumBodySize);
      if (body.kind === "too-large") {
        return response(failure("invalid", "Extension request is too large."), 413, origin);
      }
      let connection;
      try {
        if (body.kind !== "ok") throw new Error("invalid");
        connection = decodeMcpServerConnectionRequest(body.value);
      } catch {
        return response(failure("invalid", "The connection request is invalid."), 400, origin);
      }
      // A device the host's own person paired is judged as a local window is.
      const principalKind = principalActsAsHostPerson(principalContext.principal)
        ? "local-window"
        : "remote-device";
      // Reconnect drops a live session on this host, so it is a person's act
      // at this machine; a paired device reads the state only.
      if (connection.kind === "reconnect" && principalKind !== "local-window") {
        return response(
          failure("unauthorized", "Reconnect a server from the Octant window on this host."),
          401,
          origin,
        );
      }
      try {
        return response(
          connection.kind === "list"
            ? await options.mcpServerConnections.list()
            : await options.mcpServerConnections.reconnect(
                String(connection.extensionId),
                String(connection.componentId),
              ),
          200,
          origin,
        );
      } catch {
        return response(
          failure("failed", "The server connections could not be read."),
          500,
          origin,
        );
      }
    }
    if (url.pathname === "/api/extensions/discovered") {
      // What another tool on this computer knows is read for a local window
      // only, like the folder import it leads to; a paired device sees none
      // of it. Adding a found server is the same act as adding one by hand.
      if (!principalActsAsHostPerson(principalContext.principal)) {
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
      if (discovered.kind === "compaction-defaults") {
        try {
          return response(await options.agentToolingDiscovery.compactionDefaults(), 200, origin);
        } catch {
          return response(
            failure("failed", "The other tools' files could not be read."),
            500,
            origin,
          );
        }
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
          actor,
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
      url.pathname !== "/api/extensions/npm" &&
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
      (url.pathname === "/api/extensions/npm" && !isNpmCommand(command)) ||
      (url.pathname === "/api/extensions/skills" && !isSkillCommand(command))
    ) {
      return response(
        failure("invalid", "Extension command is unavailable on this route."),
        400,
        origin,
      );
    }
    if (!principalActsAsHostPerson(principalContext.principal)) {
      // Remote forwarding never admits these, and the route refuses them too,
      // so no path from a paired device installs, trusts, or switches on a
      // package. Inspecting an outside provider driver is the first step of
      // admitting one, and inspection is remembered for install, so it stays
      // with a local window as well.
      if (url.pathname === "/api/extensions/lifecycle") {
        return response(
          failure("unauthorized", "Changing a package requires the Octant window on this host."),
          401,
          origin,
        );
      }
      // Skills are read from and written to folders on this computer. Only
      // the listener's forward list kept a restricted device from them; the
      // route now forwards for the host's own person, so it refuses the rest.
      if (url.pathname === "/api/extensions/skills") {
        return response(
          failure("unauthorized", "Skills are managed by the host's own person."),
          401,
          origin,
        );
      }
      // A lookup may fetch a provider driver, and what it fetches is
      // remembered for install, so it stays with a local window like the rest.
      if (url.pathname === "/api/extensions/npm") {
        return response(
          failure(
            "unauthorized",
            "Looking up an npm package requires the Octant window on this host.",
          ),
          401,
          origin,
        );
      }
      if (
        (command.kind === "inspect-package" || command.kind === "preview-package") &&
        command.source.kind === "local-folder" &&
        options.localPluginFolderRegistry?.get(command.source.sourceRef)?.format ===
          "outside-provider-driver"
      ) {
        return response(
          failure(
            "unauthorized",
            "Reviewing a provider driver requires the Octant window on this host.",
          ),
          401,
          origin,
        );
      }
    }
    try {
      return response(await options.service.execute(command, request.signal, actor), 200, origin);
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
    command.kind === "trust-new-publisher" ||
    command.kind === "forget-publisher" ||
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

function isNpmCommand(command: ExtensionCommand): boolean {
  return command.kind === "resolve-npm-package" || command.kind === "check-npm-update";
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
    | RuntimeCompactionDefaults
    | McpServerSignInView
    | McpServerConnectionListing
    | McpServerReconnectResult
    | ExtensionProjectPinListing,
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
  actor: EventActor,
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
        // The person just typed this server in, so their one confirmation
        // installs, trusts and turns it on, as the one-step install of any
        // plugin does; the journal still records each step. With Add only
        // the server is installed and the other two steps stay theirs.
        ...(added.installOnly === true ? {} : { trust: true, enable: true }),
      },
      signal,
      actor,
    );
  } catch {
    return await abandon(failure("failed", "The server could not be installed."));
  }
  if (installed.kind !== "extension-state-updated") return await abandon(installed);
  const current = installed;
  const installedState = current.snapshot.packages.find(
    (candidate) => candidate.extensionId === entry.extensionId,
  );
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
