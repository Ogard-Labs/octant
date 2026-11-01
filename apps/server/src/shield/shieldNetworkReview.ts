import type { ShieldReviewPort } from "./octantShield";

/**
 * Octant Shield's answer to one unlisted host a proxied launch asked for:
 * a harness command's per-call `network-access` prompt, or a provider
 * runtime's request at Auto. Canonical: docs/architecture.md § Octant Shield.
 *
 * The call carries the host, the port, and what asked, nothing the launch
 * sent or received. It is a `network-access` call, so a tainted thread's
 * Shield hands it to the person, and Shield answers it only on a thread whose
 * reviewer it is. Only an allow lets the host through, for that one launch;
 * every other answer, and a thread Shield does not review, leaves the
 * refusal standing for the person to see.
 */
export async function shieldAllowsNetwork(
  shield: ShieldReviewPort | undefined,
  request: {
    readonly threadId: string;
    readonly host: string;
    readonly port: number;
    /** What asked: `command` for a harness command, else the runtime's name. */
    readonly via: string;
    readonly boundRoot: string;
    readonly signal?: AbortSignal;
  },
): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  if (shield === undefined) return { allowed: false };
  const destination = `${request.host}:${String(request.port)}`;
  let decision: Awaited<ReturnType<ShieldReviewPort["review"]>>;
  try {
    decision = await shield.review({
      threadId: request.threadId,
      call: {
        tool: "network",
        kind: "fetch",
        approvalClass: "network-access",
        paths: [],
        urls: [destination],
        arguments: JSON.stringify({ destination, via: request.via }),
        workingDirectory: request.boundRoot,
      },
      boundRoot: request.boundRoot,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch {
    return { allowed: false };
  }
  if (decision === undefined) return { allowed: false };
  try {
    shield.recordOnTranscript?.({
      threadId: request.threadId,
      summary: `Network: ${destination}`,
      decision,
    });
  } catch {
    // A transcript that cannot show the decision does not change it.
  }
  return decision.verdict === "allow"
    ? { allowed: true, reason: decision.reason }
    : { allowed: false };
}
