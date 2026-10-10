import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  decodeDiscoveryCommand,
  decodeDiscoverySnapshot,
  decodeWindowId,
  type DiscoveryCommand,
  type DiscoveryCandidate,
  type FirstRunOnboardingStatus,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderRegistryCommand,
} from "@octant/contracts";
import { canLocateRuntimeBinary } from "@octant/domain";
import { isLoopbackHostname } from "../shellRoutes";
import type { LocalPluginImportReceiptStore } from "../extensions/localPluginImportReceiptStore";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { authenticateProjectRequest } from "../projectBindingRoutes";
import type { DiscoveryService } from "./discoveryService";
import { autoRegisterPreferredCandidates } from "./discoveryAutoRegister";
import { locatedBinaryCommand } from "./locatedBinaryCommand";
import { ProviderServiceError } from "./providerService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const DEFAULT_BODY_LIMIT = 1_048_576;

export interface DiscoveryRouteDependencies {
  readonly discoveryService: DiscoveryService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly onConnect?: (
    command: Extract<DiscoveryCommand, { kind: "connect" }>,
    windowId: string,
  ) => Promise<{ instanceId: string }>;
  readonly listInstances?: (windowId: string) => Promise<ReadonlyArray<ProviderInstance>>;
  readonly createFromDiscovery?: (
    candidate: DiscoveryCandidate,
    windowId: string,
    options: { readonly enabled: boolean },
  ) => Promise<{ instanceId: ProviderInstanceId }>;
  readonly readFirstRunOnboarding?: () =>
    | FirstRunOnboardingStatus
    | Promise<FirstRunOnboardingStatus>;
  /** Authenticates the desktop main process when it trades a picked file for a receipt. */
  readonly desktopBridgeSecret?: string;
  /**
   * The window-bound, single-use receipts for executables picked in the native
   * file picker. The same store shape the local plugin folder picker uses: the
   * path stays on the host and the renderer only ever holds the receipt.
   */
  readonly binaryReceipts?: LocalPluginImportReceiptStore;
  readonly readInstance?: (instanceId: ProviderInstanceId) => ProviderInstance | undefined;
  readonly applyProviderCommand?: (
    windowId: string,
    command: ProviderRegistryCommand,
  ) => Promise<unknown>;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createDiscoveryRouteHandler(dependencies: DiscoveryRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/providers/discovery")) return undefined;

    const isScan = url.pathname === "/api/providers/discovery/scan";
    const isConnect = url.pathname === "/api/providers/discovery/connect";
    const isLocate = url.pathname === "/api/providers/discovery/locate-binary";
    const isReceipt = url.pathname === "/api/providers/discovery/binary-receipts";
    if (!isScan && !isConnect && !isLocate && !isReceipt) return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return response(
        { category: "unsupported", message: "Discovery requests must use loopback." },
        400,
        null,
      );
    }

    if (isReceipt) return issueBinaryReceipt(request);

    const origin = request.headers.get("origin");
    if (origin !== null && !isAllowedOrigin(origin)) {
      return response(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return response(
        { category: "unsupported", message: "HTTP method is not supported for discovery." },
        400,
        origin,
      );
    }

    if (url.search !== "") {
      return response(
        { category: "invalid-configuration", message: "Discovery request is invalid." },
        400,
        origin,
      );
    }

    // Authenticate window
    let body: unknown = {};
    if (isConnect || isLocate) {
      const read = await readJson(request, bodyLimit);
      if (read.kind === "too-large") {
        return response(
          { category: "invalid-configuration", message: "Request body is too large." },
          413,
          origin,
        );
      }
      if (read.kind === "invalid") {
        return response(
          { category: "invalid-configuration", message: "Discovery request body is invalid." },
          400,
          origin,
        );
      }
      body = read.value;
    }

    let windowId: string;
    try {
      windowId = authenticateProjectRequest({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return response(
          { category: "unauthorized", message: "Discovery request is unauthorized." },
          401,
          origin,
        );
      }
      return response(
        { category: "invalid-configuration", message: "Discovery request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isScan) {
        let snapshot = await dependencies.discoveryService.scan();
        const listInstances = dependencies.listInstances;
        const createFromDiscovery = dependencies.createFromDiscovery;
        if (listInstances !== undefined && createFromDiscovery !== undefined) {
          const result = await autoRegisterPreferredCandidates({
            snapshot,
            listInstances: () => listInstances(windowId),
            createFromDiscovery: async (candidate, options) =>
              (await createFromDiscovery(candidate, windowId, options)).instanceId,
            // Missing onboarding is fail-closed: never enable from an unwired host.
            firstRunOnboarding: (await dependencies.readFirstRunOnboarding?.()) ?? "completed",
          });
          snapshot = result.snapshot;
        }
        return response(
          { kind: "scan-completed", snapshot: decodeDiscoverySnapshot(snapshot) },
          200,
          origin,
        );
      }

      if (isLocate) return await locateBinary(body, windowId, origin);

      // isConnect
      let command: DiscoveryCommand;
      try {
        command = decodeDiscoveryCommand(body);
      } catch {
        return response(
          { category: "invalid-configuration", message: "Discovery connect command is invalid." },
          400,
          origin,
        );
      }

      if (command.kind !== "connect") {
        return response(
          { category: "invalid-configuration", message: "Expected a connect command." },
          400,
          origin,
        );
      }

      if (dependencies.onConnect === undefined) {
        return response(
          { category: "unsupported", message: "Discovery connect is not available." },
          503,
          origin,
        );
      }

      const known = dependencies.discoveryService.getLastScanCandidates?.() ?? [];
      const match = known.find(
        (candidate) =>
          candidate.driverKind === command.driverKind &&
          candidate.binaryPath === command.binaryPath,
      );
      if (match === undefined) {
        return response(
          {
            category: "unknown-candidate",
            message: "Connect requires a candidate from the latest discovery scan on this host.",
          },
          400,
          origin,
        );
      }

      const result = await dependencies.onConnect(command, windowId);
      return response({ kind: "candidate-connected", instanceId: result.instanceId }, 200, origin);
    } catch {
      return response(
        { category: "unavailable", message: "Discovery service is unavailable." },
        503,
        origin,
      );
    }
  };

  /**
   * The desktop main process trades the file the native picker returned for a
   * receipt bound to the window that opened the picker. Only a caller holding
   * the desktop bridge secret, with no renderer origin, reaches this, so a
   * renderer cannot mint a receipt for a path of its own choosing.
   */
  async function issueBinaryReceipt(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== null ||
      dependencies.desktopBridgeSecret === undefined ||
      dependencies.binaryReceipts === undefined ||
      !secretsEqual(
        dependencies.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return response(
        { category: "unauthorized", message: "Binary receipt request is unauthorized." },
        401,
        null,
      );
    }
    const read = await readJson(request, bodyLimit);
    if (read.kind === "too-large") {
      return response(
        { category: "invalid-configuration", message: "Request body is too large." },
        413,
        null,
      );
    }
    const value = read.kind === "ok" ? read.value : undefined;
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "absolutePath,windowId" ||
      typeof value.absolutePath !== "string" ||
      !isAbsolute(value.absolutePath)
    ) {
      return response(
        { category: "invalid-configuration", message: "Binary receipt request is invalid." },
        400,
        null,
      );
    }
    try {
      const receipt = dependencies.binaryReceipts.issue({
        windowId: String(decodeWindowId(value.windowId)),
        absolutePath: value.absolutePath,
        now: now(),
      });
      return Response.json(receipt, { status: 201 });
    } catch {
      return response(
        { category: "invalid-configuration", message: "Binary receipt request is invalid." },
        400,
        null,
      );
    }
  }

  async function locateBinary(
    body: unknown,
    windowId: string,
    origin: string | null,
  ): Promise<Response> {
    let command: DiscoveryCommand;
    try {
      command = decodeDiscoveryCommand(body);
    } catch {
      return response(
        { category: "invalid-configuration", message: "Locate binary request is invalid." },
        400,
        origin,
      );
    }
    if (command.kind !== "locate-binary") {
      return response(
        { category: "invalid-configuration", message: "Expected a locate-binary command." },
        400,
        origin,
      );
    }
    if (
      dependencies.binaryReceipts === undefined ||
      dependencies.readInstance === undefined ||
      dependencies.applyProviderCommand === undefined
    ) {
      return response(
        { category: "unsupported", message: "Locate binary is not available on this host." },
        503,
        origin,
      );
    }
    // The receipt is the only way a path reaches this route: one the picker
    // issued to this window, not yet used, and not expired.
    const binaryPath = dependencies.binaryReceipts.consume({
      receiptId: command.receiptId,
      windowId,
      now: now(),
    });
    if (binaryPath === undefined) {
      return response(
        {
          category: "unauthorized",
          message: "Choose the binary again; that selection is no longer valid.",
        },
        401,
        origin,
      );
    }
    const instance = dependencies.readInstance(command.instanceId);
    if (instance === undefined || !canLocateRuntimeBinary(instance.driverKind)) {
      return response(
        { category: "unsupported", message: "This provider does not run a local binary." },
        400,
        origin,
      );
    }
    const checked = await dependencies.discoveryService.checkPickedBinary(
      instance.driverKind,
      binaryPath,
    );
    if (checked.status === "refused") {
      return response({ category: "invalid-configuration", message: checked.message }, 400, origin);
    }
    const providerCommand = locatedBinaryCommand(instance, binaryPath);
    if (providerCommand === undefined) {
      return response(
        { category: "unsupported", message: "This provider does not run a local binary." },
        400,
        origin,
      );
    }
    try {
      await dependencies.applyProviderCommand(windowId, providerCommand);
    } catch (error) {
      if (error instanceof ProviderServiceError) {
        return response(
          { category: "invalid-configuration", message: error.failure.message },
          400,
          origin,
        );
      }
      throw error;
    }
    return response(
      { kind: "binary-located", instanceId: instance.id, version: checked.version },
      200,
      origin,
    );
  }
}

function secretsEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function response(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin))
    headers.set("access-control-allow-origin", origin);
  return headers;
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
