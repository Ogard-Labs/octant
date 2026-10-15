import type { LocalServerHealth } from "@octant/contracts";
import {
  authorizeLocalServerAction,
  type LocalServerActor,
  type LocalServerAuthorityDecision,
  type LocalServerOwnershipClass,
  type LocalServerPosture,
} from "./localServerPolicy";

/**
 * Whether a paired device may open one dev server live on its own computer,
 * through the host's private listener.
 *
 * The host gathers these facts itself, by re-observing and re-classifying the
 * listener id the request named; none of them come from the client. Each fact
 * is a union rather than a flag so a caller cannot leave one out and get a
 * grant by default.
 */

/** The thread a server belongs to, as the requesting device may see it. */
export type RemoteServerGrantThread =
  | { readonly access: "unreadable" }
  | { readonly access: "readable"; readonly posture: LocalServerPosture };

/** What re-observing the requested listener id found. */
export type RemoteServerGrantListener =
  | { readonly status: "not-listed" }
  | {
      readonly status: "listed";
      readonly ownership: LocalServerOwnershipClass;
      readonly health: LocalServerHealth;
    };

export interface RemoteServerGrantFacts {
  /** From the request's authenticated principal, never from its body. */
  readonly actor: LocalServerActor;
  /**
   * The thread the server belongs to, which is the thread whose own worktree
   * its working directory sits in: a Running services row that names a thread,
   * or a Local servers row in the requested thread's checkout when that
   * checkout is the thread's own worktree. Absent otherwise. A server in the
   * Project folder is no one thread's, and a Local servers row outside the
   * thread's checkout may be another thread's, since Octant's ownership is
   * host-wide; scoping either to the requested thread would grant it under
   * the wrong thread's readability and posture.
   */
  readonly thread?: RemoteServerGrantThread | undefined;
  readonly listener: RemoteServerGrantListener;
}

export type RemoteServerGrantPolicyRefusal =
  | { readonly reason: "local-principal" }
  | { readonly reason: "thread-unreadable" }
  | { readonly reason: "not-found" }
  | { readonly reason: "not-octant-owned" }
  | { readonly reason: "not-in-thread" }
  | {
      readonly reason: "not-listening";
      readonly health: Exclude<LocalServerHealth, "listening">;
    }
  | {
      readonly reason: "open-denied";
      readonly denial: Extract<LocalServerAuthorityDecision, { readonly kind: "deny" }>["reason"];
    };

export type RemoteServerGrantDecision =
  | { readonly kind: "grant" }
  | { readonly kind: "refuse"; readonly refusal: RemoteServerGrantPolicyRefusal };

/**
 * Decide one grant. The order is part of the rule:
 *
 * 1. Only a paired device gets a grant; a local window or agent opens the
 *    server directly, so nothing about the server is consulted for them.
 * 2. Thread readability comes before the listing, so a device that cannot read
 *    a thread learns nothing about which ids are listed in it.
 * 3. An unlisted id and a stopped server are one answer, `not-found`.
 * 4. A server Octant does not own is refused before anything else about it,
 *    with no confirmation path: Octant cannot tell who started it.
 * 5. A server in the Project folder has no thread to scope a grant to.
 * 6. Only a server the host saw answering is proxied. `unknown` is the host
 *    not knowing, never a softer `unresponsive`, and is refused the same way.
 * 7. Last, the local Open decision for the thread's posture, Plan included:
 *    opening is the person browsing, and a paired device gets no more than a
 *    local window would.
 */
export function decideRemoteServerGrant(facts: RemoteServerGrantFacts): RemoteServerGrantDecision {
  if (facts.actor !== "remote-client") return refuse({ reason: "local-principal" });
  if (facts.thread?.access === "unreadable") return refuse({ reason: "thread-unreadable" });

  const listener = facts.listener;
  if (listener.status === "not-listed") return refuse({ reason: "not-found" });
  if (listener.ownership !== "octant-owned") return refuse({ reason: "not-octant-owned" });

  const thread = facts.thread;
  if (thread === undefined) return refuse({ reason: "not-in-thread" });
  if (listener.health !== "listening") {
    return refuse({ reason: "not-listening", health: listener.health });
  }

  const open = authorizeLocalServerAction({
    action: "open",
    actor: facts.actor,
    posture: thread.posture,
    ownership: listener.ownership,
    classified: true,
  });
  switch (open.kind) {
    case "allow":
      return { kind: "grant" };
    case "deny":
      return refuse({ reason: "open-denied", denial: open.reason });
    // Open has never needed a confirmation or a fresh approval. If it ever
    // does, a paired device cannot give either on the host's behalf, so the
    // grant fails closed until that path is designed.
    case "confirm":
    case "prompt":
      return refuse({ reason: "open-denied", denial: "local-host-required" });
  }
}

function refuse(refusal: RemoteServerGrantPolicyRefusal): RemoteServerGrantDecision {
  return { kind: "refuse", refusal };
}
