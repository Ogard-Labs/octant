import {
  decodeProtectedFilesCommand,
  decodeProtectedFilesResult,
  type ProtectedFilesCommand,
} from "@octant/contracts/protected-files";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import type { ProtectedFilesService } from "./protectedFilesService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 8_192;
export const PROTECTED_FILES_PATH = "/api/protected-files";
export const PROTECTED_FILES_COMMAND_PATH = "/api/protected-files/commands";

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

export interface ProtectedFilesRouteDependencies {
  readonly service: Pick<ProtectedFilesService, "settings" | "change">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › Permissions › Protected files. Reading the list needs window
 * authority; changing it is the person's act at a window on this host, never
 * a paired device's, because it changes what every agent on the host reaches.
 */
export function createProtectedFilesRouteHandler(dependencies: ProtectedFilesRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PROTECTED_FILES_PATH && url.pathname !== PROTECTED_FILES_COMMAND_PATH) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Protected files requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      }).principal;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: error.message }, error.category === "invalid" ? 400 : 401, origin);
      }
      throw error;
    }
    if (url.pathname === PROTECTED_FILES_PATH && request.method === "GET") {
      return json(dependencies.service.settings(), 200, origin);
    }
    if (url.pathname === PROTECTED_FILES_COMMAND_PATH && request.method === "POST") {
      if (principal.kind !== "local-window") {
        return json(
          decodeProtectedFilesResult({
            kind: "protected-files-refused",
            reason: "unauthorized",
            message: "Protected files can be changed only from a window on this computer.",
          }),
          403,
          origin,
        );
      }
      let command: ProtectedFilesCommand;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        command = decodeProtectedFilesCommand(JSON.parse(text) as unknown);
      } catch {
        return json(
          decodeProtectedFilesResult({
            kind: "protected-files-refused",
            reason: "malformed",
            message:
              "That protected path is not valid. Use an absolute path or one that starts with ~/.",
          }),
          400,
          origin,
        );
      }
      const result = dependencies.service.change(command);
      return json(result, result.kind === "protected-files-refused" ? 409 : 200, origin);
    }
    return json({ error: "Protected files route is not found." }, 404, origin);
  };
}
