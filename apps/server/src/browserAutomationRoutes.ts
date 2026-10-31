import {
  decodeBrowserActionCommand,
  decodeBrowserAutomationSnapshot,
  decodeBrowserContextCancelCommand,
  decodeBrowserContextCreateCommand,
  decodeBrowserContextInspectCommand,
  decodeBrowserContextStopCommand,
  decodeBrowserThreadScope,
  decodeBrowserThreadContextCommand,
  decodeBrowserThreadInspectCommand,
  decodeBrowserThreadScopeRequest,
  decodeBrowserToolApprovalDecision,
  type BrowserToolApproval,
  type BrowserToolApprovalDecision,
} from "@octant/contracts/browser-automation-rpc";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import {
  decodeBrowserAutomationFailure,
  type BrowserAutomationFailure,
  type BrowserThreadId,
} from "@octant/contracts/browser-automation";
import {
  decodeBrowserCaptureImage,
  decodeBrowserCaptureImageCommand,
  decodeBrowserCaptureTakeCommand,
  decodeBrowserCapturesCommand,
  decodeBrowserCapturesResponse,
} from "@octant/contracts/browser-capture";
import type {
  BrowserAuthorityResolver,
  BrowserAutomationService,
} from "./browser/browserAutomationService";
import type { BrowserCaptureService } from "./browser/browserCaptureService";
import { remoteBrowserActionReach } from "@octant/domain";
import {
  decodeProjectBrowserCommand,
  decodeProjectBrowserResult,
} from "@octant/contracts/project-browser";
import type { ProjectBrowserService } from "./browser/projectBrowserService";
import type { BrowserProfileService } from "./browser/browserProfileService";
import {
  decodeBrowserProfilesCommand,
  decodeBrowserProfilesResult,
} from "@octant/contracts/browser-profiles";
import { storedBrowserProfile } from "@octant/domain";
import { authenticateRoutePrincipal, readPrincipalRouteContext } from "./principalRouteContext";
import { isAllowedRendererOrigin } from "./shellRoutes";
import type { WindowId } from "@octant/contracts/shell";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

const PREFIX = "/api/browser/";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BROWSER_MODES = ["chat", "work", "code"] as const;

export interface BrowserAutomationRouteDependencies {
  readonly service: Pick<
    BrowserAutomationService,
    "create" | "act" | "cancel" | "stop" | "inspect" | "inspectThread" | "releaseThread"
  > &
    Partial<Pick<BrowserAutomationService, "peekThread" | "profileOf">>;
  /** The thread's kept screenshots; absent on a host that keeps none. */
  readonly captures?: Pick<BrowserCaptureService, "list" | "read">;
  /**
   * Whether this window can open the thread, archived or not. Reading what a
   * thread kept asks this rather than live Browser authority, which an archived
   * thread, an archived Project, and a switched-off provider all lose. Absent
   * means nobody can read captures.
   */
  readonly windowCanOpenThread?: (
    windowId: WindowId,
    threadId: BrowserThreadId,
  ) => Promise<boolean>;
  readonly authority: BrowserAuthorityResolver;
  readonly approvals?: {
    list(windowId: WindowId): ReadonlyArray<BrowserToolApproval>;
    decide(windowId: WindowId, decision: BrowserToolApprovalDecision): boolean;
  };
  /** Browsers a Work or Code Project owns without a thread; absent on a host without them. */
  readonly projectBrowsers?: Pick<ProjectBrowserService, "execute">;
  /** The stored Browser profiles (Project and Personal); absent on a host without them. */
  readonly profiles?: Pick<BrowserProfileService, "execute">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize: number;
}

export function createBrowserAutomationRouteHandler(
  dependencies: BrowserAutomationRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  const notThisWindowsThread = (origin: string | null): Response =>
    failure(
      { category: "unauthorized", message: "Browser thread is not owned by this window." },
      403,
      origin,
    );
  // A capture is a picture of a page the person browsed, so only a local
  // window that can open the thread reads one: not a paired device, and not a
  // window of another thread. The thread need not be live: captures are its
  // history, and an archived thread opened from the archive still shows them.
  const captureReadRefusal = async (
    windowId: WindowId,
    callerKind: "local-window" | "remote-device",
    threadId: BrowserThreadId,
    origin: string | null,
  ): Promise<Response | undefined> =>
    callerKind === "local-window" &&
    (await dependencies.windowCanOpenThread?.(windowId, threadId)) === true
      ? undefined
      : notThisWindowsThread(origin);
  // Taking a capture drives the Browser, so it needs the thread's live Browser
  // authority, which reading does not.
  const captureTakeRefusal = (
    windowId: WindowId,
    callerKind: "local-window" | "remote-device",
    threadId: BrowserThreadId,
    origin: string | null,
  ): Response | undefined =>
    callerKind === "local-window" &&
    BROWSER_MODES.some((mode) => dependencies.authority.canAccessWindow(windowId, threadId, mode))
      ? undefined
      : notThisWindowsThread(origin);

  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure({ category: "unauthorized", message: "Browser origin is not allowed." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure(
        { category: "invalid", message: "Browser route method is invalid." },
        405,
        origin,
      );
    }

    let windowId;
    let callerKind: "local-window" | "remote-device";
    try {
      const principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: Date.now(),
      });
      windowId = principal.scopeId;
      callerKind = principal.principal.kind;
    } catch {
      return failure(
        { category: "unauthorized", message: "Window authority is invalid." },
        401,
        origin,
      );
    }
    const decoded = await readJson(request, dependencies.maxRequestBodySize);
    if (decoded.kind !== "ok") {
      return failure(
        {
          category: "invalid",
          message:
            decoded.kind === "too-large"
              ? "Browser request is too large."
              : "Browser request is invalid.",
        },
        decoded.kind === "too-large" ? 413 : 400,
        origin,
      );
    }

    // A paired device sees that a signed-in page exists and nothing it shows.
    const shown = (snapshot: BrowserAutomationSnapshot): BrowserAutomationSnapshot =>
      callerKind === "remote-device" ? withheldFromRemote(snapshot) : snapshot;
    try {
      if (url.pathname === "/api/browser/project-contexts") {
        if (dependencies.projectBrowsers === undefined) {
          return failure(
            { category: "unavailable", message: "Project browsers are unavailable." },
            503,
            origin,
          );
        }
        const command = decodeProjectBrowserCommand(decoded.value);
        return success(
          decodeProjectBrowserResult(
            await dependencies.projectBrowsers.execute(windowId, callerKind, command),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/profiles") {
        if (dependencies.profiles === undefined) {
          return failure(
            { category: "unavailable", message: "Browser profiles are unavailable." },
            503,
            origin,
          );
        }
        const command = decodeBrowserProfilesCommand(decoded.value);
        return success(
          decodeBrowserProfilesResult(
            await dependencies.profiles.execute(
              callerKind === "local-window" ? "local-window" : "remote-device",
              command,
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/approvals") {
        if (dependencies.approvals === undefined) {
          return failure(
            { category: "unavailable", message: "Browser approval is unavailable." },
            503,
            origin,
          );
        }
        if (
          typeof decoded.value === "object" &&
          decoded.value !== null &&
          (decoded.value as { kind?: unknown }).kind === "list"
        ) {
          return success(dependencies.approvals.list(windowId), origin);
        }
        if ((decoded.value as { kind?: unknown }).kind !== "decide") {
          return failure(
            { category: "invalid", message: "Browser approval decision is invalid." },
            400,
            origin,
          );
        }
        const { kind: _kind, ...rawDecision } = decoded.value as Record<string, unknown>;
        const decision = decodeBrowserToolApprovalDecision(rawDecision);
        const accepted = dependencies.approvals.decide(windowId, decision);
        return success({ accepted }, origin, accepted ? 200 : 409);
      }
      if (url.pathname === "/api/browser/scope") {
        const input = decodeBrowserThreadScopeRequest(decoded.value);
        if (!dependencies.authority.canAccessWindow(windowId, input.threadId, input.mode)) {
          return failure(
            { category: "unauthorized", message: "Browser thread is not owned by this window." },
            403,
            origin,
          );
        }
        const authority = dependencies.authority.resolve(input.threadId, input.mode);
        if (authority === undefined) {
          return failure(
            { category: "unauthorized", message: "Browser thread authority is unavailable." },
            403,
            origin,
          );
        }
        return success(decodeBrowserThreadScope({ threadId: input.threadId, authority }), origin);
      }
      if (url.pathname === "/api/browser/contexts") {
        const input = decodeBrowserContextCreateCommand(decoded.value);
        if (
          !dependencies.authority.canAccessWindow(
            windowId,
            input.threadId,
            input.action.authority.mode,
          )
        ) {
          return failure(
            { category: "unauthorized", message: "Browser thread is not owned by this window." },
            403,
            origin,
          );
        }
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.create({
              windowId,
              ...input,
              // A signed-in page opens only for the person at this Mac; the
              // service refuses a paired device before any runtime is asked.
              ...(callerKind === "remote-device"
                ? { profileCaller: "remote-device" as const }
                : {}),
            }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/inspect") {
        const input = decodeBrowserContextInspectCommand(decoded.value);
        return success(
          shown(
            decodeBrowserAutomationSnapshot(
              dependencies.service.inspect(windowId, input.threadId, input.contextId),
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/current") {
        const input = decodeBrowserThreadInspectCommand(decoded.value);
        if (
          !BROWSER_MODES.some((mode) =>
            dependencies.authority.canAccessWindow(windowId, input.threadId, mode),
          )
        ) {
          return failure(
            { category: "unauthorized", message: "Browser thread is not owned by this window." },
            403,
            origin,
          );
        }
        // The preview polls this route, so it is where a page the person
        // drives gets its picture refreshed.
        const snapshot =
          dependencies.service.peekThread === undefined || input.freshPicture === false
            ? dependencies.service.inspectThread(windowId, input.threadId)
            : await dependencies.service.peekThread(windowId, input.threadId, request.signal);
        return success(shown(decodeBrowserAutomationSnapshot(snapshot)), origin);
      }
      if (url.pathname === "/api/browser/captures") {
        const input = decodeBrowserCapturesCommand(decoded.value);
        const refusal = await captureReadRefusal(windowId, callerKind, input.threadId, origin);
        if (refusal !== undefined) return refusal;
        return success(
          decodeBrowserCapturesResponse({
            captures: dependencies.captures?.list(input.threadId) ?? [],
          }),
          origin,
        );
      }
      if (url.pathname === "/api/browser/captures/take") {
        // The person's Screenshot control. The ordinary action route keeps
        // nothing, and a model cannot reach this path through tool input.
        const input = decodeBrowserCaptureTakeCommand(decoded.value);
        const refusal = captureTakeRefusal(windowId, callerKind, input.threadId, origin);
        if (refusal !== undefined) return refusal;
        if (input.request.kind !== "screenshot") {
          return failure(
            { category: "invalid", message: "Only a screenshot can be taken as a capture." },
            400,
            origin,
          );
        }
        // The context must be this thread's, not merely this window's.
        const owned = dependencies.service.inspect(
          windowId,
          input.threadId,
          input.request.contextId,
        );
        if (owned.failure?.category === "unauthorized") {
          return failure(owned.failure, 403, origin);
        }
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.act({
              windowId,
              request: input.request,
              capturedBy: "person",
            }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/captures/image") {
        const input = decodeBrowserCaptureImageCommand(decoded.value);
        const refusal = await captureReadRefusal(windowId, callerKind, input.threadId, origin);
        if (refusal !== undefined) return refusal;
        const found = await dependencies.captures?.read(input.threadId, input.captureId);
        if (found === undefined) {
          return failure(
            { category: "unavailable", message: "The browser capture is unavailable." },
            404,
            origin,
          );
        }
        return success(
          decodeBrowserCaptureImage({
            captureId: input.captureId,
            dataUrl: `data:${found.capture.mime};base64,${Buffer.from(found.bytes).toString("base64")}`,
          }),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/release") {
        const input = decodeBrowserThreadContextCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.releaseThread(windowId, input.threadId),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/actions") {
        const input = decodeBrowserActionCommand(decoded.value);
        // A paired device acts inside the view the host opened. The gateway
        // already admitted this route for a remote principal; the kind it may
        // carry is decided here, where the principal is known, so a companion
        // client can never navigate, type, or close a tab on the host.
        if (readPrincipalRouteContext(request)?.principal.kind === "remote-device") {
          const reach = remoteBrowserActionReach(input.kind);
          if (reach.kind === "denied") {
            return failure({ category: "unauthorized", message: reach.reason }, 403, origin);
          }
          // A tap on a signed-in page would act as the person's account from a
          // device that cannot even see the page.
          if (
            storedBrowserProfile(dependencies.service.profileOf?.(input.contextId)) !== undefined
          ) {
            return failure(
              {
                category: "policy-denied",
                reason: "profile-not-local",
                message: "Signed-in page — open it on this Mac.",
              },
              403,
              origin,
            );
          }
        }
        return success(
          shown(
            decodeBrowserAutomationSnapshot(
              await dependencies.service.act({ windowId, request: input }),
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/cancel") {
        const input = decodeBrowserContextCancelCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.cancel({ windowId, ...input }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/stop") {
        const input = decodeBrowserContextStopCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.stop(windowId, input.threadId, input.contextId),
          ),
          origin,
        );
      }
      return undefined;
    } catch (error) {
      if (error instanceof Error && /stale|unknown/i.test(error.message)) {
        return failure(
          { category: "stale", message: "Browser context is stale or no longer owned." },
          409,
          origin,
        );
      }
      if (error instanceof Error && /ParseError/.test(error.name)) {
        return failure(
          { category: "invalid", message: "Browser request is invalid." },
          400,
          origin,
        );
      }
      return failure(
        { category: "failed", message: "Browser automation service failed closed." },
        503,
        origin,
      );
    }
  };
}

/**
 * What a paired device may see of a page in a signed-in profile: that it exists,
 * and nothing it shows. The picture, the text, the address, and the title all
 * carry the account, so none of them leaves this Mac.
 */
export function withheldFromRemote(snapshot: BrowserAutomationSnapshot): BrowserAutomationSnapshot {
  if (storedBrowserProfile(snapshot.context?.policy.profile) === undefined) return snapshot;
  const { observation: _observation, contexts: _contexts, ...rest } = snapshot;
  return {
    ...rest,
    evidence: [],
    failure: {
      category: "policy-denied",
      reason: "profile-not-local",
      message: "Signed-in page — open it on this Mac.",
    },
  };
}

function success(value: unknown, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(
  input: BrowserAutomationFailure,
  status: number,
  origin?: string | null,
): Response {
  return new Response(JSON.stringify(decodeBrowserAutomationFailure(input)), {
    status,
    headers: {
      "content-type": "application/json",
      ...(origin === undefined ? {} : corsHeaders(origin)),
    },
  });
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: text === "" ? {} : JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}
