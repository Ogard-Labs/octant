/**
 * Where the phone's composer sends what the person typed. A Work or Code
 * follow-up typed while a turn runs joins the host's queue and waits for that
 * turn; Chat never queues on the phone; and while one follow-up is still
 * joining the queue there is no second send, so a double tap queues once.
 */
export function followUpRoute(input: {
  readonly mode: "chat" | "work" | "code";
  readonly turnLive: boolean;
  readonly queueing: boolean;
}): "send" | "queue" | "wait" {
  if (input.mode === "chat" || !input.turnLive) return "send";
  return input.queueing ? "wait" : "queue";
}
