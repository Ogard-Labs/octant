import { decodeShellSettingsReplacement, SHELL_SETTINGS_PATH } from "@octant/contracts";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { eventActorForPrincipal } from "./principalEventActor";
import { readPrincipalRouteContext } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { ShellServiceError, type ShellService } from "./shellService";

/** Settings with every thread's Reply detail and every remembered site fit well inside this. */
const MAX_BODY_BYTES = 512 * 1_024;

/**
 * `GET` and `POST /api/shell/settings`: the host's shell settings for a device
 * the host's own person paired (maintainer decision, 2026-11-13). A window
 * reads them in its bootstrap and replaces them through the shell commands
 * route, both bound to a window registered on this host; a device has no
 * window here, so it could read only Reply detail and write nothing. This
 * route answers only such a device: every other device session is refused,
 * and a window keeps the shell route. A replacement runs under the rules a
 * window's does and is journaled with the device as its actor.
 */
export function createShellSettingsRouteHandler(
  service: Pick<ShellService, "readSettings" | "replaceSettings">,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== SHELL_SETTINGS_PATH) return undefined;
    if (!isLoopbackHostname(url.hostname)) {
      return refuse("unsupported", "Shell settings requests must use loopback.", 400);
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return refuse("unsupported", "Shell settings take GET or POST.", 405);
    }
    if (url.search !== "") return refuse("invalid", "Shell settings take no query.", 400);
    const principal = readPrincipalRouteContext(request)?.principal;
    if (principal?.kind !== "remote-device" || !principalActsAsHostPerson(principal)) {
      return refuse(
        "invalid",
        "Shell settings are read and changed here only by a device the host's own person paired.",
        403,
      );
    }
    try {
      if (request.method === "GET") return answer(service.readSettings(), 200);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) {
        return refuse("invalid", "Shell settings are too large.", 413);
      }
      let replacement;
      try {
        replacement = decodeShellSettingsReplacement(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        return refuse("invalid", "Shell settings replacement is invalid.", 400);
      }
      return answer(
        service.replaceSettings({ ...replacement, actor: eventActorForPrincipal(principal) }),
        200,
      );
    } catch (error) {
      if (error instanceof ShellServiceError) {
        const { category } = error.failure;
        return answer(
          error.failure,
          category === "conflict"
            ? 409
            : category === "unavailable" || category === "recovery-required"
              ? 503
              : 400,
        );
      }
      return refuse("unavailable", "Octant shell service is unavailable.", 503);
    }
  };
}

function refuse(
  category: "invalid" | "unsupported" | "unavailable",
  message: string,
  status: number,
): Response {
  return answer({ category, message }, status);
}

function answer(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
