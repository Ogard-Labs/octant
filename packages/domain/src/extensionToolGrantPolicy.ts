import type { ExtensionToolGrantRevocationReason } from "@octant/contracts/extension-events";

/**
 * Where a connected MCP server can reach. `confined-stdio` is a server Octant
 * launched itself with no network and writes limited to its plugin data;
 * `proxied-stdio` is one launched the same way but allowed to reach the hosts
 * its catalog entry names through the host's own proxy, so it can carry a
 * call's arguments out and is judged like `network`; `network` is a server
 * Octant only talks to over HTTP, so what it does with a call's arguments is
 * outside the host's view.
 */
export type ExtensionToolReach = "confined-stdio" | "proxied-stdio" | "network";

/** What a person saw when they approved a tool: the package and the tool's listing. */
export interface ExtensionToolBinding {
  readonly version: string;
  readonly digest: string;
  readonly definitionDigest: string;
  /**
   * The publisher key whose signature of this package version the host
   * verified. Absent for an unsigned version.
   */
  readonly publisherKey?: string;
}

export interface ExtensionToolGrantFacts {
  /**
   * Whether the thread stands in a Project. A Chat thread outside one keeps
   * its remembered approvals for the account instead, and has no Full access
   * level.
   */
  readonly inProject: boolean;
  /**
   * The host started this turn as itself: a routine, a goal-loop round, a
   * usage-limit resume, or a child run's result delivered to its parent.
   */
  readonly hostOwnedTurn: boolean;
  /** A paired device sent this turn, from its own scope rather than a local window's. */
  readonly pairedDeviceTurn: boolean;
  readonly planTurn: boolean;
  /**
   * The turn's thread runs at Full access, where no approval is asked. Plan
   * on such a thread still asks.
   */
  readonly fullAccessTurn: boolean;
  /** The thread has taken in outside content: a tool result or external text. */
  readonly threadTainted: boolean;
  readonly reach: ExtensionToolReach;
  /**
   * The catalog names this tool as one that asks on every call because it
   * publishes or removes data. No remembered approval covers it.
   */
  readonly askEveryCall?: boolean;
  /** The tool as its server lists it for this call. */
  readonly offered: ExtensionToolBinding;
  /**
   * The stored grant for this tool, when one was ever recorded: the Project's,
   * or the account's for a thread outside a Project.
   */
  readonly grant: (ExtensionToolBinding & { readonly revoked: boolean }) | undefined;
  /**
   * The stored grant for every tool of this tool's server, in the same place.
   * It binds the package alone, because it covers tools whose listings the
   * person never saw.
   */
  readonly serverGrant:
    | (Pick<ExtensionToolBinding, "version" | "digest" | "publisherKey"> & {
        readonly revoked: boolean;
      })
    | undefined;
  /**
   * A person already answered this server's prompt on this thread after the
   * thread took in outside content, and approved it.
   */
  readonly serverAllowedOnMarkedThread: boolean;
}

/**
 * What an approving answer to a prompt lets run afterwards. `server` is every
 * tool of the tool's server, in the Project or for the account; the person
 * is asked once, the first time any tool of a server is used.
 * `server-on-thread` is every tool of that server for the rest of this
 * thread alone. `call` is the one call that asked.
 */
export type ExtensionToolAnswerCoverage = "call" | "server" | "server-on-thread";

export type ExtensionToolGrantDecision =
  | { readonly kind: "covered" }
  | {
      readonly kind: "ask";
      readonly reason:
        | "plan-turn"
        | "network-tool-on-tainted-thread"
        | "ask-every-call-tool"
        | "not-granted"
        | "revoked"
        | "package-changed"
        | "tool-definition-changed";
      readonly answerCovers: ExtensionToolAnswerCoverage;
    };

/**
 * Whether this MCP tool call runs unasked, because the thread is at Full
 * access or a remembered approval covers it, or a person must be asked. Below
 * Full access a server asks once, the first time any of its tools is used,
 * and that answer covers the server's tools. A grant never widens what a
 * call may do: it only spares the prompt for the tools of the server and
 * package the person allowed, or for the exact tool, package, and listing
 * they approved alone.
 */
export function decideExtensionToolGrant(
  facts: ExtensionToolGrantFacts,
): ExtensionToolGrantDecision {
  // Plan is the read-only posture: nothing runs unasked under it, and an
  // answer given there approves that call alone.
  if (facts.planTurn) return { kind: "ask", reason: "plan-turn", answerCovers: "call" };
  // Full access rule. The person chose a level where nothing prompts, and the
  // same agent already holds an unwrapped shell and an open network, so an
  // ask here protects nothing that level does not already reach. A tool is
  // only offered from a trusted and enabled server, and outside content is
  // recorded on the thread without gating the call. This branch is the whole
  // rule.
  if (facts.fullAccessTurn && facts.inProject) return { kind: "covered" };
  // A tool the catalog marks ask-every-call (it publishes or deletes) is never
  // covered by a grant or by an answer given for its server, whatever the
  // thread has read. It sits below the Full access rule because that level is
  // not a grant: nothing asks there, publishing included.
  if (facts.askEveryCall === true) {
    return { kind: "ask", reason: "ask-every-call-tool", answerCovers: "call" };
  }
  // Nobody chose to send a host-owned turn, so the prompt it raises is not a
  // person asking for this tool. It may use an answer a person already gave,
  // but its own prompt approves one call, whoever answers. Host ownership is
  // never why a call asks, so it adds no reason of its own.
  // A paired device's turn is approved once the same way: an answer that is
  // kept is a local window's, and the person who sent the turn is not at one.
  const answerKept = !facts.hostOwnedTurn && !facts.pairedDeviceTurn;
  // Taint rule. Outside content on the thread may be steering the model, and
  // a network tool can carry what the thread has read out in its arguments.
  // The person is asked once for the server on that thread, after the mark;
  // their answer says they accept that for this server there, so it holds
  // for the rest of the thread and for no other thread. A confined stdio
  // server has no network to carry anything out, so its grant holds. This
  // branch is the whole rule.
  if (facts.threadTainted && facts.reach !== "confined-stdio") {
    if (facts.serverAllowedOnMarkedThread) return { kind: "covered" };
    return {
      kind: "ask",
      reason: "network-tool-on-tainted-thread",
      answerCovers: answerKept ? "server-on-thread" : "call",
    };
  }
  const answerCovers = answerKept ? "server" : "call";
  // Whole-server rule. The person allowed every tool of this server, so the
  // tool's own listing is not compared; the package still is.
  const serverGrant = facts.serverGrant;
  if (
    serverGrant !== undefined &&
    !serverGrant.revoked &&
    approvedPackage(serverGrant, facts.offered)
  ) {
    return { kind: "covered" };
  }
  const grant = facts.grant;
  if (grant === undefined) {
    if (serverGrant === undefined) return { kind: "ask", reason: "not-granted", answerCovers };
    return {
      kind: "ask",
      reason: serverGrant.revoked ? "revoked" : "package-changed",
      answerCovers,
    };
  }
  if (grant.revoked) return { kind: "ask", reason: "revoked", answerCovers };
  if (!approvedPackage(grant, facts.offered)) {
    return { kind: "ask", reason: "package-changed", answerCovers };
  }
  if (grant.definitionDigest !== facts.offered.definitionDigest) {
    return { kind: "ask", reason: "tool-definition-changed", answerCovers };
  }
  return { kind: "covered" };
}

/**
 * Update rule. A grant is for the package the person approved. An update is
 * different code under the same name, so it asks again, unless the key that
 * signed the approved version signed the update too: the person's answer was
 * given to that publisher's server, and the host verified both signatures.
 * An update with a new key, or with none, asks again. This is the whole rule.
 */
function approvedPackage(
  granted: Pick<ExtensionToolBinding, "version" | "digest" | "publisherKey">,
  offered: Pick<ExtensionToolBinding, "version" | "digest" | "publisherKey">,
): boolean {
  if (granted.version === offered.version && granted.digest === offered.digest) return true;
  return granted.publisherKey !== undefined && granted.publisherKey === offered.publisherKey;
}

/**
 * Why a package lifecycle change ends every remembered approval of that
 * package's tools, or `undefined` when the grants stay stored. Uninstall,
 * withdrawn trust, and rollback revoke, so installing or trusting again
 * restores nothing. Disabling a plugin or a component only leaves the grants
 * unused, and an update is judged against the grant at the next call.
 */
export function extensionToolGrantRevocationReason(change: {
  readonly kind: string;
  readonly trusted?: boolean;
}): Exclude<ExtensionToolGrantRevocationReason, "person"> | undefined {
  // `remove-skill` uninstalls its package through the same lifecycle step.
  if (change.kind === "uninstall-package" || change.kind === "remove-skill") {
    return "plugin-uninstalled";
  }
  if (change.kind === "rollback-package") return "rolled-back";
  if (change.kind === "set-source-trust" && change.trusted === false) return "trust-revoked";
  return undefined;
}
