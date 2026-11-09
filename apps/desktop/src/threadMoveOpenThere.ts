import {
  MovedThreadReference,
  decodeThreadMoveThreadStatus,
  type ThreadMoveThreadStatus,
} from "@octant/contracts";
import { memberThreadPage } from "@octant/domain";
import { Either, Schema } from "effect";
import { validateExternalBrowserUrl } from "./externalBrowserUrl";
import {
  sendHubAdministrationOperation,
  type HubAdministrationControlRuntime,
} from "./hubAdministrationControls";

export type MovedThreadOpenThereOutcome =
  | { readonly status: "opened" }
  | { readonly status: "refused" };

const decodeThread = Schema.decodeUnknownEither(MovedThreadReference);

/**
 * Open there on a moved thread's tombstone: the person's default browser opens
 * the thread on the destination's own web app, which admits that browser as
 * it already would (a guest, an owner's passkey) or asks it to pair, so this
 * computer grants nothing. The window names only the thread. The page comes
 * from this host's own answer for that thread, under the window's capability,
 * so a window that does not show the thread is refused by the host; its web
 * origin is the destination's entry in the roster the host holds, and it must
 * be https on a Tailscale name before anything leaves the app.
 */
export async function openMovedThreadThere(input: {
  readonly runtime: HubAdministrationControlRuntime;
  readonly thread: unknown;
  readonly openExternal: (url: string) => Promise<void>;
}): Promise<MovedThreadOpenThereOutcome> {
  const refused = { status: "refused" } as const;
  const thread = decodeThread(input.thread);
  if (Either.isLeft(thread)) return refused;
  const answer = await sendHubAdministrationOperation(input.runtime, "thread-move-status", {
    thread: thread.right,
  });
  if (answer.status !== 200) return refused;
  const departed = departedOf(answer.body);
  if (departed?.destinationWebOrigin === undefined) return refused;
  const page = memberThreadPage(departed.destinationWebOrigin, departed.destinationThread);
  if (page === undefined) return refused;
  await input.openExternal(validateExternalBrowserUrl(page));
  return { status: "opened" };
}

function departedOf(body: unknown): ThreadMoveThreadStatus["departed"] {
  try {
    return decodeThreadMoveThreadStatus(body).departed;
  } catch {
    return undefined;
  }
}
