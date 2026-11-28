import {
  decodeDesktopHostUpdateReport,
  type DesktopHostUpdatePending,
  type DesktopHostUpdateReport,
  type HostUpdateStatus,
} from "@octant/contracts/host-update";
import { admitDesktopBroker } from "./desktopBrokerAdmission";
import { isLoopbackHostname } from "./shellRoutes";

export const DESKTOP_HOST_UPDATE_ROUTE = "/api/desktop/host-update";
const BODY_LIMIT = 8_192;

export interface DesktopHostUpdateRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly readPending: () => DesktopHostUpdatePending;
  readonly reportUpdate: (report: DesktopHostUpdateReport) => HostUpdateStatus;
  readonly now?: () => number;
}

/**
 * Loopback-only, desktop-bridge-secret-authenticated handoff between the server
 * and desktop main for remote desktop app updates. Never forwarded on the
 * private remote listener.
 */
export function createDesktopHostUpdateRouteHandler(
  options: DesktopHostUpdateRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== DESKTOP_HOST_UPDATE_ROUTE) return undefined;
    const admission = admitDesktopBroker({
      request,
      desktopBridgeSecret: options.desktopBridgeSecret,
      now: now(),
    });
    if (
      !isLoopbackHostname(url.hostname) ||
      admission.status !== "admitted" ||
      admission.kind !== "desktop-bridge"
    ) {
      return Response.json(
        {
          category: "unauthorized",
          message: "Only this host's desktop can coordinate app updates.",
        },
        { status: 401 },
      );
    }
    if (url.search !== "") {
      return Response.json({ category: "invalid", message: "Invalid request." }, { status: 400 });
    }
    if (request.method === "GET") {
      return Response.json(options.readPending(), {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method !== "POST") {
      return Response.json(
        { category: "invalid", message: "HTTP method is not supported for this route." },
        { status: 405 },
      );
    }
    let text: string;
    try {
      text = await request.text();
    } catch {
      return Response.json(
        { category: "invalid", message: "Request body could not be read." },
        { status: 400 },
      );
    }
    if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) {
      return Response.json(
        { category: "invalid", message: "Request body is too large." },
        { status: 413 },
      );
    }
    let report: DesktopHostUpdateReport;
    try {
      report = decodeDesktopHostUpdateReport(JSON.parse(text));
    } catch {
      return Response.json(
        { category: "invalid", message: "Desktop update report is invalid." },
        { status: 400 },
      );
    }
    const status = options.reportUpdate(report);
    return Response.json(status, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  };
}
