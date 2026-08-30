/**
 * One message the user sent while a response was still running.
 *
 * Sending mid-response is not a queue the user administers: the message leaves
 * the composer at once, joins the transcript as a message the thread already
 * accepted, and the host is asked to run it as soon as the response in flight
 * stops occupying the thread. Depth is one — a second message sent before the
 * first one starts replaces nothing and adds nothing, because the transcript
 * already shows a message waiting to run.
 *
 * The intent is client-side and deliberately not journaled: it never bypasses
 * send-path authority, and a reload drops it rather than sending behind the
 * user's back.
 */
export type SteeredSendState<Message> =
  | { readonly status: "idle" }
  | { readonly status: "steering"; readonly threadKey: string; readonly message: Message };

export type TurnSettlement =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "refused"
  | "waiting";

export const EMPTY_STEERED_SEND: SteeredSendState<never> = { status: "idle" };

export function steerSend<Message>(
  current: SteeredSendState<Message>,
  threadKey: string,
  message: Message,
  settlement: TurnSettlement | "idle",
): SteeredSendState<Message> {
  if (settlement !== "running" || threadKey.trim() === "") return current;
  if (current.status === "steering") return current;
  return { status: "steering", threadKey, message };
}

/**
 * Leaving a thread, or unmounting its composer, drops the message rather than
 * sending it into a thread the user is no longer looking at. The caller is
 * told, so the words can go back to the composer they came from.
 */
export function disarmSteeredSend<Message>(
  current: SteeredSendState<Message>,
  threadKey: string | undefined,
): SteeredSendState<Message> {
  if (current.status === "idle") return current;
  if (threadKey !== undefined && current.threadKey === threadKey) return current;
  return EMPTY_STEERED_SEND;
}

/**
 * A message sent mid-response runs the moment the thread stops running one.
 *
 * Completion is the ordinary case, but a response that was cancelled, failed,
 * refused, or is waiting has also stopped occupying the thread, so the message
 * the user already sent is sent then too. Holding it back would leave the
 * transcript showing a message the thread never ran.
 */
export function settleSteeredSend<Message>(
  current: SteeredSendState<Message>,
  threadKey: string | undefined,
  settlement: TurnSettlement | "idle",
): { readonly next: SteeredSendState<Message>; readonly fire: boolean } {
  if (current.status === "idle") return { next: current, fire: false };
  if (threadKey === undefined || current.threadKey !== threadKey) {
    return { next: EMPTY_STEERED_SEND, fire: false };
  }
  if (settlement === "running") return { next: current, fire: false };
  return { next: current, fire: true };
}
