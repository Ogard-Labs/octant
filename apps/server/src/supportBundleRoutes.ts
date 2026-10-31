import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { decodeSupportBundleExportRequest, type SupportBundleSaveOutcome } from "@octant/contracts";
import { authorizeDiagnosticsExportActor, buildSupportBundleZip } from "@octant/domain";
import { isAllowedOrigin } from "./diagnosticsExportRoutes";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import {
  exportSupportBundle,
  previewSupportBundle,
  type StageSupportBundleDelivery,
  type SupportBundleSources,
} from "./supportBundleService";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

/**
 * The support bundle's routes: a read of what a bundle would hold, the export
 * that hands the files to the caller, and the desktop app's save, where the
 * host writes the file at the path the native dialog chose. All are
 * loopback-only and sit on the local administration chain beside host control,
 * never in the product dispatch the remote gateway shares, so a paired device
 * cannot reach them even if route policy regressed. The first two need a local
 * window; the save needs the desktop secret and refuses any browser origin.
 */

const PREVIEW_PATH = "/api/diagnostics/bundle/preview";
const EXPORT_PATH = "/api/diagnostics/bundle";
const SAVE_PATH = "/api/diagnostics/bundle/save";
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_024;

export interface SupportBundleRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly sources: () => SupportBundleSources;
  /**
   * Authenticates the desktop main process when it hands over the path the
   * person chose in the native save dialog. Absent, that route answers 401.
   */
  readonly desktopBridgeSecret?: string;
  readonly now?: () => number;
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
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function secretsEqual(expected: string, actual: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(expected, "utf8").digest(),
    createHash("sha256").update(actual, "utf8").digest(),
  );
}

/** Writes the zip beside its destination first and moves it into place on commit. */
function stageZipAt(path: string, modifiedAt: Date): StageSupportBundleDelivery {
  return (files) => {
    const staged = `${path}.octant-${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(staged, buildSupportBundleZip(files, modifiedAt), { mode: 0o600, flag: "wx" });
    } catch (error) {
      rmSync(staged, { force: true });
      throw error;
    }
    return {
      commit: () => renameSync(staged, path),
      abort: () => rmSync(staged, { force: true }),
    };
  };
}

export function createSupportBundleRouteHandler(dependencies: SupportBundleRouteDependencies) {
  const now = dependencies.now ?? Date.now;

  // The desktop main process, not the renderer, names the path: it comes from
  // the native save dialog, and the renderer only ever learns the file name.
  async function saveToChosenPath(request: Request, url: URL): Promise<Response> {
    const secret = dependencies.desktopBridgeSecret;
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Support bundle requests must use loopback." }, 400, null);
    }
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== null ||
      secret === undefined ||
      !secretsEqual(secret, request.headers.get("x-octant-desktop-secret") ?? "")
    ) {
      return json({ error: "Support bundle save is unauthorized." }, 401, null);
    }
    let absolutePath: string;
    try {
      const text = await request.text();
      if (text.length > 8_192) return json({ error: "Request body is too large." }, 413, null);
      const value: unknown = JSON.parse(text);
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).join(",") !== "absolutePath" ||
        typeof (value as { absolutePath?: unknown }).absolutePath !== "string"
      ) {
        throw new Error("invalid");
      }
      absolutePath = (value as { absolutePath: string }).absolutePath;
      if (!isAbsolute(absolutePath) || absolutePath.endsWith("/") || absolutePath.includes("\0")) {
        throw new Error("invalid");
      }
    } catch {
      return json({ error: "Support bundle save request is invalid." }, 400, null);
    }
    try {
      const outcome = await exportSupportBundle(
        { destinationCategory: "chosen-by-person" },
        dependencies.sources(),
        stageZipAt(absolutePath, new Date(now())),
      );
      const answer: SupportBundleSaveOutcome =
        outcome.kind === "exported"
          ? { kind: "saved", fileName: basename(absolutePath), receipt: outcome.receipt }
          : outcome;
      return json(answer, answer.kind === "saved" ? 200 : 422, null);
    } catch {
      return json({ error: "The support bundle could not be saved." }, 500, null);
    }
  }

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isPreview = url.pathname === PREVIEW_PATH;
    if (url.pathname === SAVE_PATH) return saveToChosenPath(request, url);
    if (!isPreview && url.pathname !== EXPORT_PATH) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Support bundle requests must use loopback." }, 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return json({ error: "Renderer origin is not allowed." }, 400, null);
    }
    // A 204 carries no body: passing even "null" as one makes the runtime refuse it.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== (isPreview ? "GET" : "POST")) {
      return json({ error: "Method not allowed." }, 405, origin);
    }

    let actorKind: "local-window" | "remote-device";
    try {
      actorKind = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      }).principal.kind;
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? json({ error: "Support bundle is unauthorized." }, 401, origin)
        : json({ error: "Support bundle request is invalid." }, 400, origin);
    }
    if (authorizeDiagnosticsExportActor(actorKind).kind === "denied") {
      return json({ error: "Support bundle is unauthorized." }, 403, origin);
    }

    if (isPreview) {
      try {
        return json(await previewSupportBundle(dependencies.sources()), 200, origin);
      } catch {
        return json({ error: "The support bundle list could not be read." }, 500, origin);
      }
    }

    let exportRequest;
    try {
      const text = await request.text();
      if (text.length > BODY_LIMIT)
        return json({ error: "Request body is too large." }, 413, origin);
      exportRequest = decodeSupportBundleExportRequest(JSON.parse(text));
    } catch {
      return json({ error: "Support bundle request is invalid." }, 400, origin);
    }
    try {
      const outcome = await exportSupportBundle(exportRequest, dependencies.sources());
      return json(outcome, outcome.kind === "exported" ? 200 : 422, origin);
    } catch {
      return json({ error: "The support bundle could not be built." }, 500, origin);
    }
  };
}
