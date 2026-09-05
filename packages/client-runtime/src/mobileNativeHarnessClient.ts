import {
  decodeNativeHarnessFollowUpActivationResult,
  decodeNativeHarnessFollowUpPreview,
  decodeNativeHarnessSessionView,
  type NativeHarnessFollowUpActivationResult,
  type NativeHarnessFollowUpPreview,
  type NativeHarnessSessionView,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/**
 * The harness session as the phone reads it, over the paired device's own
 * authenticated transport. Same routes, same shapes, same refusals as the
 * desktop; the phone never holds a separate view of a session.
 */
export async function loadMobileNativeHarnessSession(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<NativeHarnessSessionView | null> {
  const response = await input.transport.authenticatedFetch({
    method: "GET",
    path: `/api/native-harness/sessions/${encodeURIComponent(input.threadId)}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { view?: unknown };
  return body.view === null || body.view === undefined
    ? null
    : decodeNativeHarnessSessionView(body.view);
}

export async function previewMobileNativeHarnessFollowUp(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly suggestionId: string;
}): Promise<NativeHarnessFollowUpPreview | undefined> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: `/api/native-harness/sessions/${encodeURIComponent(input.threadId)}/follow-ups/preview`,
    body: JSON.stringify({ suggestionId: input.suggestionId }),
    contentType: "application/json",
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { preview?: unknown };
  return body.preview === undefined ? undefined : decodeNativeHarnessFollowUpPreview(body.preview);
}

export async function activateMobileNativeHarnessFollowUp(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly turnId: string;
  readonly suggestionId: string;
}): Promise<NativeHarnessFollowUpActivationResult | undefined> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: `/api/native-harness/sessions/${encodeURIComponent(input.threadId)}/follow-ups/activate`,
    body: JSON.stringify({
      turnId: input.turnId,
      suggestionId: input.suggestionId,
      confirmed: true,
    }),
    contentType: "application/json",
  });
  try {
    return decodeNativeHarnessFollowUpActivationResult(await response.json());
  } catch {
    return undefined;
  }
}
