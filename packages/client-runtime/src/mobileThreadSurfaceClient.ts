import {
  decodeBrowserAutomationSnapshot,
  decodeBrowserThreadScope,
  type BrowserAutomationSnapshot,
} from "@octant/contracts/browser-automation-rpc";
import type { ToolActionAuthority } from "@octant/contracts";
import type { BrowserViewportPoint } from "@octant/contracts/browser-automation";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

/**
 * What the host's browser is showing for one thread, reduced to what a phone
 * can put on screen.
 *
 * The host owns the picture. This view never renders a page itself: it shows
 * the screenshot the host captured, says when that picture is stale, and says
 * plainly when there is nothing to show rather than pretending the surface is
 * loading forever.
 */
export interface MobileBrowserSurfaceView {
  readonly status: "showing" | "waiting" | "idle" | "unavailable";
  readonly screenshotDataUrl?: string;
  readonly url?: string;
  readonly title?: string;
  readonly stale: boolean;
  readonly observedAt?: string;
  /** Present only while the host holds a live context this device may act in. */
  readonly action?: MobileBrowserActionHandle;
}

/**
 * Everything an action needs, as the host reported it. The phone never invents
 * an identity: without a live context there is no handle, and without a handle
 * there is no gesture to send.
 */
export interface MobileBrowserActionHandle {
  readonly actionId: string;
  readonly contextId: string;
  readonly correlationId: string;
  readonly authority: ToolActionAuthority;
  readonly observationRevision?: number;
}

async function decodeSnapshot(
  response: Response,
  message: string,
): Promise<BrowserAutomationSnapshot> {
  if (response.status === 401 || response.status === 403) {
    throw new MobileInboxFailure("rejected", message);
  }
  if (!response.ok) throw new MobileInboxFailure("unavailable", message);
  try {
    return decodeBrowserAutomationSnapshot(await response.json());
  } catch {
    throw new MobileInboxFailure("unavailable", message);
  }
}

function viewFrom(
  snapshot: BrowserAutomationSnapshot,
  authority: ToolActionAuthority | undefined,
): MobileBrowserSurfaceView {
  const observation = snapshot.observation;
  const context = snapshot.context;
  const handle =
    context === undefined || authority === undefined
      ? undefined
      : {
          actionId: String(context.actionId),
          contextId: String(context.contextId),
          correlationId: String(context.correlationId),
          authority,
          ...(observation?.revision === undefined
            ? {}
            : { observationRevision: observation.revision }),
        };
  const status: MobileBrowserSurfaceView["status"] =
    observation?.screenshotDataUrl !== undefined
      ? "showing"
      : context === undefined
        ? "idle"
        : "waiting";
  return {
    status,
    ...(observation?.screenshotDataUrl === undefined
      ? {}
      : { screenshotDataUrl: observation.screenshotDataUrl }),
    ...(observation?.url === undefined ? {} : { url: observation.url }),
    ...(observation?.title === undefined ? {} : { title: observation.title }),
    stale: observation?.stale ?? true,
    ...(observation?.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
    ...(handle === undefined ? {} : { action: handle }),
  };
}

/**
 * Read what the host's browser is showing for a thread.
 *
 * A device the host will not let watch this thread gets `unavailable` rather
 * than an error the screen has to interpret: the surface simply is not on
 * offer, which is the same answer the surface matrix gives before the request
 * is even made.
 */
export async function loadMobileBrowserSurface(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly mode: "chat" | "work" | "code";
  readonly signal?: AbortSignal;
}): Promise<MobileBrowserSurfaceView> {
  const { transport, threadId, mode, signal } = input;
  let authority: ToolActionAuthority | undefined;
  try {
    const scopeResponse = await transport.authenticatedFetch({
      method: "POST",
      path: "/api/browser/scope",
      body: JSON.stringify({ threadId, mode }),
      contentType: "application/json",
      ...(signal === undefined ? {} : { signal }),
    });
    if (scopeResponse.status === 401 || scopeResponse.status === 403) {
      return { status: "unavailable", stale: true };
    }
    if (scopeResponse.ok) {
      authority = decodeBrowserThreadScope(await scopeResponse.json()).authority;
    }
  } catch {
    return { status: "unavailable", stale: true };
  }

  const response = await transport.authenticatedFetch({
    method: "POST",
    path: "/api/browser/contexts/current",
    body: JSON.stringify({ threadId }),
    contentType: "application/json",
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === 401 || response.status === 403) {
    return { status: "unavailable", stale: true };
  }
  return viewFrom(await decodeSnapshot(response, "Browser surface is unavailable."), authority);
}

/**
 * Land a tap in the page the host is showing.
 *
 * The point is normalized to the picture the phone drew, so the host maps it to
 * its own viewport rather than trusting device pixels. The host refuses any
 * gesture it does not consider a remote action, and refuses one computed
 * against a picture that has since moved on.
 */
export async function tapMobileBrowserSurface(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly handle: MobileBrowserActionHandle;
  readonly point: BrowserViewportPoint;
  readonly signal?: AbortSignal;
}): Promise<MobileBrowserSurfaceView> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/browser/actions",
    body: JSON.stringify({
      actionId: input.handle.actionId,
      contextId: input.handle.contextId,
      correlationId: input.handle.correlationId,
      authority: input.handle.authority,
      kind: "click",
      point: input.point,
      ...(input.handle.observationRevision === undefined
        ? {}
        : { expectedObservationRevision: input.handle.observationRevision }),
    }),
    contentType: "application/json",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new MobileInboxFailure("rejected", "The host refused this gesture.");
  }
  if (response.status === 409) {
    throw new MobileInboxFailure("stale", "The page moved on; refresh and try again.");
  }
  return viewFrom(
    await decodeSnapshot(response, "The gesture could not be sent."),
    input.handle.authority,
  );
}
