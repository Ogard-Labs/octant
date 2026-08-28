import {
  decodeHostBackupRequest,
  decodeHostLifecycleRequest,
  type HostBackupOutcome,
  type HostControlPolicy,
  type HostControlStatus,
  type HostLifecycleAction,
  type HostLifecycleOutcome,
  type HostRestoreOutcome,
} from "@octant/contracts/host-control";
import type { HostDataMap } from "@octant/contracts/host-data-map";
import {
  composeHostDataMap,
  type HostDataMapCredentialStoreInput,
  type HostDataMapProjectInput,
} from "./hostDataMap";
import {
  decodePurgeThreadsRequest,
  decodeSetThreadRetentionRequest,
  type PurgeThreadsRequest,
  type SetThreadRetentionRequest,
} from "@octant/contracts/thread-retention";
import type { ThreadRetentionService } from "./threadRetentionService";
import {
  authorizeHostControlAction,
  deriveHostLifecycleControls,
  type HostControlOperation,
  type HostControlServiceModeInput,
  type HostLifecycleControls,
} from "@octant/domain";
import { boundHostRuntimeDiagnostics, type HostRuntimeDiagnostics } from "@octant/host-runtime";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

/**
 * The one authenticated web entry point for host
 * control. It serves the Settings host card for an authorized local
 * principal — compact identity, owner mode, service policy, versions,
 * readiness, capabilities, and lifecycle/backup/recovery controls.
 *
 * Authority model:
 * - loopback only, allow-listed renderer origin, and the window-capability
 *   header as the local-authenticated-user gate (mirrors
 *   `./diagnosticsExportRoutes.ts`);
 * - `authorizeHostControlAction` re-checks the shared least-authority
 *   catalogue before every effect, so a remote device can never reach a
 *   lifecycle mutation even if transport policy regressed;
 * - the handler is registered only on the loopback route chain, outside the
 *   shared product dispatch used by the remote gateway, and
 *   `/api/host-control` is a remote local-only prefix — three independent
 *   layers keep this surface off the remote listener.
 *
 * Status, lifecycle, backup, and restore never carry secrets or raw host
 * paths: the control endpoint and backup destination stay in local
 * diagnostic tooling. The data-map read is the exception that names
 * locations — never values — so Settings can show what this host stores.
 */

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 8_192;

const ROUTES = {
  status: "/api/host-control/status",
  dataMap: "/api/host-control/data-map",
  lifecycle: "/api/host-control/lifecycle",
  backup: "/api/host-control/backup",
  restore: "/api/host-control/restore",
  retention: "/api/host-control/thread-retention",
  purge: "/api/host-control/thread-purge",
} as const;

const GET_ROUTES = new Set<string>([ROUTES.status, ROUTES.dataMap]);

const RESTORE_GUIDANCE =
  "Stop the Octant host, then run the offline restore command with --confirm.";

export interface HostControlServicePolicyPort {
  read(): Promise<{ readonly enabled: boolean; readonly updatedAt: string }>;
  setEnabled(enabled: boolean): Promise<{ readonly enabled: boolean; readonly updatedAt: string }>;
}

export interface HostControlBackupReceipt {
  readonly label: string;
  readonly migrationVersion: number;
  readonly journalHead: number;
  readonly byteLength: number;
}

export interface HostControlRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** Live owner diagnostics; `undefined` until the server is composed. */
  readonly diagnostics: () => HostRuntimeDiagnostics | undefined;
  /**
   * Persisted automatic-startup policy. Production owners inject the store.
   * Omitting it is a test seam that reports `unavailable` instead of
   * pretending a policy is wired.
   */
  readonly servicePolicy?: HostControlServicePolicyPort;
  /** Graceful owner drain request (the same authority the control socket uses). */
  readonly requestOwnerStop?: () => void;
  readonly backup?: (label: string) => HostControlBackupReceipt;
  /**
   * Verified host-runtime locations and Project list for the data map.
   * Omitting it is a test seam: every location category reports `unknown`.
   */
  readonly dataMap?: HostDataMapRouteDependencies;
  readonly threadRetention?: ThreadRetentionService;
  readonly now?: () => number;
  /** Defers the drain until after the response is written. Test seam. */
  readonly scheduleStop?: (callback: () => void) => void;
}

export interface HostDataMapRouteDependencies {
  readonly dataDirectory: string;
  readonly platform: "darwin" | "linux";
  readonly credentialStore?: HostDataMapCredentialStoreInput;
  readonly listProjects?: () => ReadonlyArray<HostDataMapProjectInput>;
}

export function createHostControlRouteHandler(
  dependencies: HostControlRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  const now = dependencies.now ?? Date.now;
  const scheduleStop =
    dependencies.scheduleStop ?? ((callback: () => void) => void setTimeout(callback, 0));

  return async (request) => {
    const url = new URL(request.url);
    if (!Object.values(ROUTES).includes(url.pathname as (typeof ROUTES)[keyof typeof ROUTES])) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Host control requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.search !== "") {
      return failure("Host control request is invalid.", 400, origin);
    }

    const route = url.pathname as (typeof ROUTES)[keyof typeof ROUTES];
    if (route === ROUTES.retention) {
      if (request.method !== "GET" && request.method !== "POST") {
        return failure("HTTP method is not supported for this route.", 405, origin);
      }
    } else {
      const expectedMethod = GET_ROUTES.has(route) ? "GET" : "POST";
      if (request.method !== expectedMethod) {
        return failure("HTTP method is not supported for this route.", 405, origin);
      }
    }

    try {
      authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Host control is unauthorized.", 401, origin);
      }
      return failure("Host control request is invalid.", 400, origin);
    }

    if (route === ROUTES.status) {
      return authorized("status", origin, () => handleStatus(dependencies, origin));
    }
    if (route === ROUTES.dataMap) {
      return authorized("data-map", origin, () => handleDataMap(dependencies, origin));
    }
    if (route === ROUTES.retention && request.method === "GET") {
      return authorized("retention", origin, () => handleReadRetention(dependencies, origin));
    }

    const decoded = await readJson(request, BODY_LIMIT);
    if (decoded.kind === "too-large") {
      return failure("Request body is too large.", 413, origin);
    }
    if (decoded.kind === "invalid") {
      return failure("Request body must be valid JSON.", 400, origin);
    }

    if (route === ROUTES.lifecycle) {
      let body;
      try {
        body = decodeHostLifecycleRequest(decoded.value);
      } catch {
        return failure("Host lifecycle request is invalid.", 400, origin);
      }
      return authorized(body.action, origin, () =>
        handleLifecycle(dependencies, body.action, origin, scheduleStop),
      );
    }
    if (route === ROUTES.backup) {
      let body;
      try {
        body = decodeHostBackupRequest(decoded.value);
      } catch {
        return failure("Host backup request is invalid.", 400, origin);
      }
      return authorized("backup", origin, () =>
        handleBackup(dependencies, body.label ?? "manual", origin),
      );
    }
    if (route === ROUTES.retention) {
      let body;
      try {
        body = decodeSetThreadRetentionRequest(decoded.value);
      } catch {
        return failure("Thread retention request is invalid.", 400, origin);
      }
      return authorized("retention", origin, () => handleSetRetention(dependencies, body, origin));
    }
    if (route === ROUTES.purge) {
      let body;
      try {
        body = decodePurgeThreadsRequest(decoded.value);
      } catch {
        return failure("Thread purge request is invalid.", 400, origin);
      }
      return authorized("purge", origin, () => handlePurgeThreads(dependencies, body, origin));
    }
    if (!isEmptyRecord(decoded.value)) {
      return failure("Host restore request is invalid.", 400, origin);
    }
    return authorized("restore", origin, () => handleRestore(origin));
  };
}

/**
 * Defense in depth: the window-capability check already guarantees a local
 * window, but every effectful path must be provably gated by the shared
 * least-authority catalogue used by remote-device, provider, and extension
 * callers.
 */
async function authorized(
  operation: HostControlOperation,
  origin: string | null,
  handle: () => Response | Promise<Response>,
): Promise<Response> {
  const decision = authorizeHostControlAction({ principalKind: "local-window", operation });
  if (decision.kind === "deny") {
    return failure("Host control is unauthorized.", 401, origin);
  }
  return handle();
}

function handleDataMap(
  dependencies: HostControlRouteDependencies,
  origin: string | null,
): Response {
  const raw = dependencies.diagnostics();
  if (raw === undefined) {
    return failure("Host control is unavailable while the owner is starting.", 503, origin);
  }
  const diagnostics = boundHostRuntimeDiagnostics(raw);
  const serviceMode = decodeServiceMode(diagnostics.identity.serviceMode);
  if (serviceMode === undefined) {
    return failure("Host control is unavailable while the owner is starting.", 503, origin);
  }
  const dataMap = dependencies.dataMap;
  const report: HostDataMap = composeHostDataMap({
    hostId: diagnostics.identity.hostId,
    serviceMode,
    ...(dataMap === undefined
      ? {}
      : {
          platform: dataMap.platform,
          dataDirectory: dataMap.dataDirectory,
          ...(dataMap.credentialStore === undefined
            ? {}
            : { credentialStore: dataMap.credentialStore }),
          ...(dataMap.listProjects === undefined ? {} : { projects: dataMap.listProjects() }),
        }),
  });
  return json(report, 200, origin);
}

async function handleStatus(
  dependencies: HostControlRouteDependencies,
  origin: string | null,
): Promise<Response> {
  const composed = await composeStatus(dependencies);
  if (composed === undefined) {
    return failure("Host control is unavailable while the owner is starting.", 503, origin);
  }
  return json(composed, 200, origin);
}

async function composeStatus(
  dependencies: HostControlRouteDependencies,
): Promise<HostControlStatus | undefined> {
  const raw = dependencies.diagnostics();
  if (raw === undefined) return undefined;
  const diagnostics = boundHostRuntimeDiagnostics(raw);
  const serviceMode = decodeServiceMode(diagnostics.identity.serviceMode);
  if (serviceMode === undefined) return undefined;
  const policy = await readPolicy(dependencies.servicePolicy);
  const lifecycle = lifecycleControls(dependencies, serviceMode, policy);
  return {
    identity: {
      hostId: diagnostics.identity.hostId,
      instanceId: diagnostics.identity.instanceId,
      serviceMode,
    },
    versions: { server: diagnostics.version.server, wire: diagnostics.version.wire },
    policy,
    readiness: {
      store: { state: diagnostics.store.state, integrity: diagnostics.store.integrity },
      replay: {
        journalHead: diagnostics.replay.journalHead,
        projections: diagnostics.replay.projections,
      },
      clientsConnected: diagnostics.clients.connected,
      uptimeSeconds: diagnostics.uptimeSeconds ?? 0,
    },
    capabilities: diagnostics.capabilities,
    work: {
      active: diagnostics.work.active,
      attentionRequired: diagnostics.work.attentionRequired,
    },
    lifecycle,
  };
}

async function handleLifecycle(
  dependencies: HostControlRouteDependencies,
  action: HostLifecycleAction,
  origin: string | null,
  scheduleStop: (callback: () => void) => void,
): Promise<Response> {
  const raw = dependencies.diagnostics();
  const serviceMode = raw === undefined ? undefined : decodeServiceMode(raw.identity.serviceMode);
  if (serviceMode === undefined) {
    return failure("Host control is unavailable while the owner is starting.", 503, origin);
  }
  const policy = await readPolicy(dependencies.servicePolicy);
  const controls = lifecycleControls(dependencies, serviceMode, policy);

  if (action === "enable" || action === "disable") {
    const availability = controls[action];
    if (availability.kind === "unavailable" || dependencies.servicePolicy === undefined) {
      return json(
        refusal(action, "policy-unavailable", policyUnavailableGuidance(availability)),
        200,
        origin,
      );
    }
    try {
      await dependencies.servicePolicy.setEnabled(action === "enable");
    } catch {
      return json(
        refusal(
          action,
          "policy-unavailable",
          "The service policy could not be written. Repair the policy file permissions and retry.",
        ),
        200,
        origin,
      );
    }
    return json(
      accepted(
        action,
        action === "enable"
          ? "Automatic startup is enabled for this host."
          : "Automatic startup is disabled; explicit foreground run remains available.",
      ),
      200,
      origin,
    );
  }

  if (action === "restart" && controls.restart.kind === "unavailable") {
    return json(refusal(action, "restart-unavailable", controls.restart.reason), 200, origin);
  }
  if (dependencies.requestOwnerStop === undefined) {
    return json(
      refusal(action, "unsupported", "This owner does not accept web lifecycle requests."),
      200,
      origin,
    );
  }
  const requestOwnerStop = dependencies.requestOwnerStop;
  scheduleStop(() => requestOwnerStop());
  return json(
    accepted(
      action,
      action === "restart"
        ? "The host is draining; the service manager will start it again."
        : "The host is draining and will stop.",
    ),
    200,
    origin,
  );
}

function handleBackup(
  dependencies: HostControlRouteDependencies,
  label: string,
  origin: string | null,
): Response {
  if (dependencies.backup === undefined) {
    return json(backupFailed(), 503, origin);
  }
  let receipt: HostControlBackupReceipt;
  try {
    receipt = dependencies.backup(label);
  } catch {
    return json(backupFailed(), 503, origin);
  }
  const outcome: HostBackupOutcome = {
    kind: "created",
    label,
    migrationVersion: receipt.migrationVersion,
    journalHead: receipt.journalHead,
    byteLength: receipt.byteLength,
  };
  return json(outcome, 200, origin);
}

function handleReadRetention(
  dependencies: HostControlRouteDependencies,
  origin: string | null,
): Response {
  if (dependencies.threadRetention === undefined) {
    return failure("Thread retention is unavailable while the owner is starting.", 503, origin);
  }
  return json(dependencies.threadRetention.readState(), 200, origin);
}

function handleSetRetention(
  dependencies: HostControlRouteDependencies,
  request: SetThreadRetentionRequest,
  origin: string | null,
): Response {
  if (dependencies.threadRetention === undefined) {
    return failure("Thread retention is unavailable while the owner is starting.", 503, origin);
  }
  const outcome = dependencies.threadRetention.setWindow(request, "local-window");
  return json(outcome, "kind" in outcome ? 403 : 200, origin);
}

async function handlePurgeThreads(
  dependencies: HostControlRouteDependencies,
  request: PurgeThreadsRequest,
  origin: string | null,
): Promise<Response> {
  if (dependencies.threadRetention === undefined) {
    return failure("Thread retention is unavailable while the owner is starting.", 503, origin);
  }
  const outcome = await dependencies.threadRetention.purge(request, "local-window");
  return json(outcome, "kind" in outcome ? 403 : 200, origin);
}

function handleRestore(origin: string | null): Response {
  const outcome: HostRestoreOutcome = { kind: "refused-online", guidance: RESTORE_GUIDANCE };
  return json(outcome, 200, origin);
}

function lifecycleControls(
  dependencies: HostControlRouteDependencies,
  serviceMode: HostControlServiceModeInput,
  policy: HostControlPolicy,
): HostLifecycleControls {
  const derived = deriveHostLifecycleControls({
    serviceMode,
    policy: policy.kind === "known" ? { kind: "known", enabled: policy.enabled } : policy,
  });
  if (dependencies.servicePolicy === undefined) {
    const unavailable = {
      kind: "unavailable" as const,
      reason: "The service policy store is not wired on this host.",
    };
    return { ...derived, enable: unavailable, disable: unavailable };
  }
  return derived;
}

async function readPolicy(
  servicePolicy: HostControlServicePolicyPort | undefined,
): Promise<HostControlPolicy> {
  if (servicePolicy === undefined) {
    return { kind: "unavailable", reason: "The service policy store is not wired on this host." };
  }
  try {
    const policy = await servicePolicy.read();
    return { kind: "known", enabled: policy.enabled, updatedAt: policy.updatedAt };
  } catch {
    return { kind: "unavailable", reason: "The service policy could not be read." };
  }
}

function decodeServiceMode(value: string): HostControlServiceModeInput | undefined {
  return value === "desktop" || value === "foreground" || value === "web" || value === "service"
    ? value
    : undefined;
}

function accepted(action: HostLifecycleAction, message: string): HostLifecycleOutcome {
  return { kind: "accepted", action, message };
}

function refusal(
  action: HostLifecycleAction,
  code: "restart-unavailable" | "policy-unavailable" | "unsupported",
  guidance: string,
): HostLifecycleOutcome {
  return { kind: "refused", action, code, guidance };
}

function policyUnavailableGuidance(availability: {
  readonly kind: string;
  readonly reason?: string;
}): string {
  return availability.kind === "unavailable" && availability.reason !== undefined
    ? availability.reason
    : "The service policy could not be read, so startup policy cannot change here.";
}

function backupFailed(): HostBackupOutcome {
  return { kind: "failed", code: "backup-failed" };
}

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

async function readJson(request: Request, limit: number): Promise<ReadJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > limit) {
    return { kind: "too-large" };
  }
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > limit) return { kind: "too-large" };
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
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
      parsed.protocol === "app:"
    );
  } catch {
    return false;
  }
}
