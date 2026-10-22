export const WORK_THREAD_NOT_LOADED =
  "This Work thread isn't loaded yet. Pull to refresh and try again.";

export type WorkFollowUpTarget<T> =
  | { readonly status: "ready"; readonly thread: T }
  | { readonly status: "not-loaded"; readonly message: string };

/**
 * A follow-up is sent under the loaded thread's Project and binding, so it may
 * only go out when that thread is the selected one. Returning quietly here
 * made the send button flicker busy and do nothing.
 */
export function workFollowUpTarget<T extends { readonly id: unknown }>(
  loaded: T | undefined,
  selectedThreadId: string,
): WorkFollowUpTarget<T> {
  if (loaded === undefined || String(loaded.id) !== selectedThreadId) {
    return { status: "not-loaded", message: WORK_THREAD_NOT_LOADED };
  }
  return { status: "ready", thread: loaded };
}
