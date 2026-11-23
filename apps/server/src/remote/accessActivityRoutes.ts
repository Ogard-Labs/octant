import { randomUUID } from "node:crypto";
import type { EventActor, PermissionMode, WindowId } from "@octant/contracts";
import {
  ACCESS_ACTIVITY_PATH,
  CHANGE_NOTICE_ACTION_PATHS,
  CHANGE_NOTICE_AGGREGATE_TYPE,
  CHANGE_NOTICE_DISMISSED,
  CHANGE_NOTICES_PATH,
  decodeChangeNoticeRequest,
  type ChangeNoticeDismissed,
} from "@octant/contracts/access-activity";
import { isAgentGrantSession, principalActsAsHostPerson } from "../clientPrincipal";
import { secretsEqual } from "../providers/providerCredentialRoutes";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal, readPrincipalRouteContext } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  noticesFor,
  readAccessActivity,
  readChangeNotices,
  type ChangeNoticeNames,
  type ChangeNoticeRecord,
} from "./accessActivity";

export { ACCESS_ACTIVITY_PATH, CHANGE_NOTICES_PATH };

/** The paths a device the host's own person paired reaches, with their methods. */
export const PAIRED_DEVICE_ACCESS_ACTIVITY_ROUTES: ReadonlyArray<{
  readonly path: string;
  readonly method: "GET" | "POST";
}> = [
  { path: ACCESS_ACTIVITY_PATH, method: "GET" },
  { path: CHANGE_NOTICES_PATH, method: "GET" },
  ...Object.values(CHANGE_NOTICE_ACTION_PATHS).map((path) => ({ path, method: "POST" as const })),
];

type Outcome =
  | { readonly status: "done" }
  | { readonly status: "refused"; readonly message: string };

export interface AccessActivityRouteDependencies {
  readonly connection: SqliteConnection;
  readonly journal: Pick<Journal, "append">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * The desktop bridge secret. Removing a key and revoking a device or grant
   * stand in for routes that take a window only with it, so a window's key
   * Undo and revoke here need it too; a renderer never holds it and uses those
   * routes through the desktop instead.
   */
  readonly desktopBridgeSecret: string | undefined;
  readonly names?: ChangeNoticeNames;
  /** A thread's level now, or undefined when the thread is gone. */
  readonly threadLevel: (surface: "code" | "work", threadId: string) => PermissionMode | undefined;
  /** Sets a thread's level through its mode's own level command, as `actor`. */
  readonly setThreadLevel: (input: {
    readonly surface: "code" | "work";
    readonly threadId: string;
    readonly level: PermissionMode;
    readonly scopeId: WindowId;
    readonly actor: EventActor;
  }) => Promise<Outcome>;
  /**
   * Removes one key from a provider's pool through the key routes' own
   * journaled path, holding the pool to the key ids the notice recorded.
   */
  readonly removeKey: (input: {
    readonly instanceId: string;
    readonly keyId: string;
    readonly scopeId: WindowId;
    readonly actor: EventActor;
    readonly expected?: { readonly keyIds: ReadonlyArray<string> };
  }) => Promise<Outcome>;
  /** Revokes a paired device through the device administration's revoke. */
  readonly revokeDevice: (deviceId: string, actor: EventActor) => Outcome;
  /** Ends an agent grant through the grant's own revoke. */
  readonly endAgentGrant: (grantId: string, actor: EventActor) => Outcome;
  readonly now?: () => number;
}

interface Viewer {
  /** The asking paired device; absent for a window on this computer. */
  readonly deviceId?: string;
  readonly scopeId: WindowId;
  readonly actor: EventActor;
}

/**
 * Access activity and change notices (maintainer decision, 2026-11-22). The
 * activity is read by a window on this computer or a device its person
 * paired at Full; the notices are shown to the same callers, other than the
 * device that made the change, and acted on there. Every other caller (a
 * device paired below Full, a hub-introduced device, an agent grant) is
 * refused: these name devices and grants and act on them.
 *
 * Undo and revoke each run the underlying command (the thread's level
 * command, the key pool's remove, the device revoke, the grant revoke) as the
 * person who pressed it, and Undo is refused when the state is no longer the
 * one the notice describes.
 */
export function createAccessActivityRouteHandler(dependencies: AccessActivityRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const actionPaths: ReadonlyArray<string> = Object.values(CHANGE_NOTICE_ACTION_PATHS);
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const isAction = actionPaths.includes(path);
    if (path !== ACCESS_ACTIVITY_PATH && path !== CHANGE_NOTICES_PATH && !isAction) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const viewer = admit(request, url, origin);
    if (viewer instanceof Response) return viewer;
    if (url.search !== "" || request.method !== (isAction ? "POST" : "GET")) {
      return refuse(405, "Use a plain GET to read and a POST to act.", origin);
    }
    if (path === ACCESS_ACTIVITY_PATH) {
      return Response.json(
        { entries: readAccessActivity(dependencies.connection) },
        { headers: corsHeaders(origin) },
      );
    }
    const visible = noticesFor(
      readChangeNotices(dependencies.connection, dependencies.names),
      viewer.deviceId,
    );
    if (path === CHANGE_NOTICES_PATH) {
      return Response.json(
        { notices: visible.map((record) => record.notice) },
        { headers: corsHeaders(origin) },
      );
    }
    let noticeId: string;
    try {
      noticeId = decodeChangeNoticeRequest(await request.json()).noticeId;
    } catch {
      return refuse(400, "Name the notice to act on.", origin);
    }
    const record = visible.find((candidate) => candidate.notice.noticeId === noticeId);
    if (record === undefined) {
      return refuse(404, "That notice is gone or was already handled.", origin);
    }
    if (
      viewer.deviceId === undefined &&
      (path === CHANGE_NOTICE_ACTION_PATHS.revoke ||
        (path === CHANGE_NOTICE_ACTION_PATHS.undo &&
          record.notice.kind !== "thread-level-raised")) &&
      !holdsBridgeSecret(request)
    ) {
      return refuse(
        403,
        "From a window, remove the key or revoke the device through this computer's own controls.",
        origin,
      );
    }
    const outcome =
      path === CHANGE_NOTICE_ACTION_PATHS.dismiss
        ? ({ status: "done" } as const)
        : path === CHANGE_NOTICE_ACTION_PATHS.undo
          ? await undo(record, viewer)
          : revoke(record, viewer);
    if (outcome.status === "refused") return refuse(409, outcome.message, origin);
    journalDismissal(
      noticeId,
      path === CHANGE_NOTICE_ACTION_PATHS.dismiss
        ? "dismissed"
        : path === CHANGE_NOTICE_ACTION_PATHS.undo
          ? "undone"
          : "revoked",
      viewer.actor,
    );
    return Response.json({ status: "done" }, { headers: corsHeaders(origin) });
  };

  // The same check the device administration and key routes make of a window:
  // the secret from the owner-only runtime directory, and no browser Origin.
  function holdsBridgeSecret(request: Request): boolean {
    const secret = dependencies.desktopBridgeSecret;
    return (
      secret !== undefined &&
      !request.headers.has("origin") &&
      secretsEqual(secret, request.headers.get("x-octant-desktop-secret") ?? "")
    );
  }

  function admit(request: Request, url: URL, origin: string | null): Viewer | Response {
    const bound = readPrincipalRouteContext(request);
    if (bound !== undefined) {
      const principal = bound.principal;
      if (
        principal.kind !== "remote-device" ||
        !principalActsAsHostPerson(principal) ||
        isAgentGrantSession(principal)
      ) {
        return refuse(403, "Access activity is for this computer's person.", origin);
      }
      return {
        deviceId: String(principal.deviceId),
        scopeId: bound.scopeId,
        actor: eventActorForPrincipal(principal),
      };
    }
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return refuse(400, "Access activity is read over loopback.", null);
    }
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (context.principal.kind !== "local-window") {
        return refuse(403, "Access activity is for this computer's person.", origin);
      }
      return { scopeId: context.scopeId, actor: eventActorForPrincipal(undefined) };
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return refuse(401, "Access activity read is unauthorized.", origin);
      }
      throw error;
    }
  }

  async function undo(record: ChangeNoticeRecord, viewer: Viewer): Promise<Outcome> {
    const notice = record.notice;
    if (notice.kind !== "thread-level-raised") {
      if (notice.kind === "provider-key-replaced") {
        return refused(
          "A replaced key cannot be undone: the earlier key is not kept. Enter it again in Settings if you still have it.",
        );
      }
      if (record.keyId === undefined || record.changedSince === true) {
        return refused(
          "This provider's keys changed again since, so Undo could remove the wrong key. Check its keys in Settings.",
        );
      }
      return dependencies.removeKey({
        instanceId: notice.providerInstanceId,
        keyId: record.keyId,
        scopeId: viewer.scopeId,
        actor: viewer.actor,
        ...(record.expectedKeyIds === undefined
          ? {}
          : { expected: { keyIds: record.expectedKeyIds } }),
      });
    }
    if (record.changedSince === true) {
      return refused(
        "This thread's level changed again since, so Undo would not put it back. Set its level from the thread.",
      );
    }
    if (dependencies.threadLevel(notice.surface, notice.threadId) !== notice.to) {
      return refused(
        "This thread's level changed again since, so Undo would not put it back. Set its level from the thread.",
      );
    }
    return dependencies.setThreadLevel({
      surface: notice.surface,
      threadId: notice.threadId,
      level: notice.from,
      scopeId: viewer.scopeId,
      actor: viewer.actor,
    });
  }

  function revoke(record: ChangeNoticeRecord, viewer: Viewer): Outcome {
    const actor = record.notice.actor;
    return actor.kind === "agent"
      ? dependencies.endAgentGrant(actor.grantId, viewer.actor)
      : dependencies.revokeDevice(actor.deviceId, viewer.actor);
  }

  function journalDismissal(
    noticeId: string,
    outcome: ChangeNoticeDismissed["outcome"],
    actor: EventActor,
  ): void {
    const payload: ChangeNoticeDismissed = {
      noticeId,
      dismissedAt: new Date(now()).toISOString(),
      outcome,
    };
    try {
      dependencies.journal.append({
        aggregate: { aggregateType: CHANGE_NOTICE_AGGREGATE_TYPE, aggregateId: noticeId },
        expectedVersion: 0,
        events: [
          {
            eventId: randomUUID(),
            eventName: CHANGE_NOTICE_DISMISSED,
            eventVersion: 1,
            correlationId: randomUUID(),
            actor,
            occurredAt: payload.dismissedAt,
            payload,
          },
        ],
      });
    } catch (error) {
      // Another client dismissed it first, so the notice is gone either way;
      // any other failure is the journal's and is not hidden.
      const recorded = dependencies.connection
        .prepare("SELECT 1 FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?")
        .get(CHANGE_NOTICE_AGGREGATE_TYPE, noticeId);
      if (recorded === undefined) throw error;
    }
  }
}

function refused(message: string): Outcome {
  return { status: "refused", message };
}

function refuse(status: number, message: string, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    "cache-control": "no-store",
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}
