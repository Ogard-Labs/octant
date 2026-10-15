import type { ExtensionToolGrantRevocationReason } from "@octant/contracts/extension-events";

/**
 * Where a connected MCP server can reach. `confined-stdio` is a server Octant
 * launched itself with no network and writes limited to its plugin data;
 * `network` is a server Octant only talks to over HTTP, so what it does with a
 * call's arguments is outside the host's view.
 */
export type ExtensionToolReach = "confined-stdio" | "network";

/** What a person saw when they approved a tool: the package and the tool's listing. */
export interface ExtensionToolBinding {
  readonly version: string;
  readonly digest: string;
  readonly definitionDigest: string;
}

export interface ExtensionToolGrantFacts {
  /** A thread with no Project has nowhere to remember an approval. */
  readonly inProject: boolean;
  /**
   * The host started this turn as itself: a routine, a goal-loop round, a
   * usage-limit resume, or a child run's result delivered to its parent.
   */
  readonly hostOwnedTurn: boolean;
  /** A paired device sent this turn, from its own scope rather than a local window's. */
  readonly pairedDeviceTurn: boolean;
  readonly planTurn: boolean;
  /** The thread has taken in outside content: a tool result or external text. */
  readonly threadTainted: boolean;
  readonly reach: ExtensionToolReach;
  /** The tool as its server lists it for this call. */
  readonly offered: ExtensionToolBinding;
  /** The Project's stored grant for this tool, when one was ever recorded. */
  readonly grant: (ExtensionToolBinding & { readonly revoked: boolean }) | undefined;
}

export type ExtensionToolGrantDecision =
  | { readonly kind: "covered" }
  | {
      readonly kind: "ask";
      readonly reason:
        | "no-project"
        | "plan-turn"
        | "network-tool-on-tainted-thread"
        | "not-granted"
        | "revoked"
        | "package-changed"
        | "tool-definition-changed";
      /** Whether the person may answer "always allow in this Project". */
      readonly rememberable: boolean;
    };

/**
 * Whether a remembered approval covers this MCP tool call, or a person must
 * be asked. A grant never widens what a call may do: it only spares the
 * prompt for the exact tool, package, and listing the person already approved.
 */
export function decideExtensionToolGrant(
  facts: ExtensionToolGrantFacts,
): ExtensionToolGrantDecision {
  if (!facts.inProject) return { kind: "ask", reason: "no-project", rememberable: false };
  // Plan is the read-only posture: nothing runs unasked under it, and an
  // answer given there approves that call alone.
  if (facts.planTurn) return { kind: "ask", reason: "plan-turn", rememberable: false };
  // Taint rule. Outside content on the thread may be steering the model, and
  // a network tool can carry what the thread has read out in its arguments,
  // so each such call is confirmed and the answer is single use. A confined
  // stdio server has no network to carry anything out, so its grant holds.
  // This branch is the whole rule.
  if (facts.threadTainted && facts.reach !== "confined-stdio") {
    return { kind: "ask", reason: "network-tool-on-tainted-thread", rememberable: false };
  }
  // Nobody chose to send a host-owned turn, so the prompt it raises is not a
  // person asking for this tool. It may use a grant a person already made,
  // but its own prompt approves one call, whoever answers. Host ownership is
  // never why a call asks, so it adds no reason of its own.
  // A paired device's turn is approved once the same way: "always allow in
  // this Project" is a local window's answer, and the person who sent the
  // turn is not at one, so nobody who answers it may remember it.
  const rememberable = !facts.hostOwnedTurn && !facts.pairedDeviceTurn;
  const grant = facts.grant;
  if (grant === undefined) return { kind: "ask", reason: "not-granted", rememberable };
  if (grant.revoked) return { kind: "ask", reason: "revoked", rememberable };
  // Update rule. A grant is for the package the person approved; an update
  // is different code under the same name, so it asks again. This branch is
  // the whole rule.
  if (grant.version !== facts.offered.version || grant.digest !== facts.offered.digest) {
    return { kind: "ask", reason: "package-changed", rememberable };
  }
  if (grant.definitionDigest !== facts.offered.definitionDigest) {
    return { kind: "ask", reason: "tool-definition-changed", rememberable };
  }
  return { kind: "covered" };
}

/**
 * Why a package lifecycle change ends every remembered approval of that
 * package's tools, or `undefined` when the grants stay stored. Uninstall,
 * withdrawn trust, and rollback revoke, so installing or trusting again
 * restores nothing. Disabling a plugin or a component only leaves the grants
 * unused, and an update is caught by the package digest at the next call.
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
