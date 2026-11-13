/**
 * Whether the previous host stopped because a person quit Octant. A restart
 * continues the turns it cut off by itself (wiring/continuation.ts), because a
 * crash, a force quit or a reboot is nobody's choice; a person who quits while
 * turns run has chosen to stop them, so the next start holds those threads
 * for them instead (docs/architecture.md, restart recovery).
 *
 * The desktop that owns this host says so once the person's quit is
 * accepted, on a loopback route only its bridge secret opens. The host keeps
 * that as a file beside its store, read and removed once at the next start.
 * No file is the crash case and continues as before, so anything that keeps
 * the report from landing fails toward continuing.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitDesktopBroker } from "./desktopBrokerAdmission";
import { isLoopbackHostname } from "./shellRoutes";

export const PERSON_QUIT_ROUTE = "/api/desktop/person-quit";

const MARKER_FILE = "person-quit.json";
const MARKER_SCHEMA_VERSION = 1;

/** Records that a person is quitting this host, for its next start to read. */
export function recordPersonQuit(dataDirectory: string, now: () => Date): void {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(dataDirectory, `.person-quit-${randomUUID()}.tmp`);
  writeFileSync(
    temporary,
    JSON.stringify({ schemaVersion: MARKER_SCHEMA_VERSION, quitAt: now().toISOString() }),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, join(dataDirectory, MARKER_FILE));
}

/**
 * Whether the previous host was quit by a person. Removes the record, so it
 * answers for one start only; a record that cannot be removed answers false,
 * because it would otherwise hold threads after every later crash too.
 */
export function consumePersonQuit(dataDirectory: string): boolean {
  const file = join(dataDirectory, MARKER_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    return false;
  }
  try {
    const value: unknown = JSON.parse(text);
    return (
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value &&
      value.schemaVersion === MARKER_SCHEMA_VERSION
    );
  } catch {
    return false;
  }
}

export interface PersonQuitRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly dataDirectory: string;
  readonly now?: () => Date;
}

/**
 * The desktop's report of a person's quit. Only the local desktop process
 * that holds the bridge secret is admitted: a paired device, a remote client,
 * a forwarded request, a browser page and a Nightly window's main token are
 * all refused, and `/api/desktop` is local-only on the private listener.
 */
export function createPersonQuitRouteHandler(
  options: PersonQuitRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? (() => new Date());
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== PERSON_QUIT_ROUTE) return undefined;
    const admission = admitDesktopBroker({
      request,
      desktopBridgeSecret: options.desktopBridgeSecret,
      now: now().getTime(),
    });
    if (
      !isLoopbackHostname(url.hostname) ||
      admission.status !== "admitted" ||
      admission.kind !== "desktop-bridge"
    )
      return Response.json(
        { category: "unauthorized", message: "Only this host's desktop can report a quit." },
        { status: 401 },
      );
    if (request.method !== "POST" || url.search !== "")
      return Response.json({ category: "invalid", message: "Invalid request." }, { status: 400 });
    try {
      recordPersonQuit(options.dataDirectory, now);
    } catch {
      return Response.json(
        { category: "unavailable", message: "The quit could not be recorded." },
        { status: 503 },
      );
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  };
}
