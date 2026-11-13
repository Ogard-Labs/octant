// Whether an owner device's runtime approval answers ride its open five-minute
// session on this host, or each needs its own fresh unlock. Riding the session
// is the default: the person already proved presence for it, and a second
// prompt per Allow or Deny adds a tap without adding a check. The switch is
// for a host whose person wants that tap anyway, and only a window on this
// host sets it.

import type { AuditActingPrincipal, HubMembershipChangedPayload } from "@octant/contracts";
import type { HubStatePort } from "./hubStateStore";

export type OwnerApprovalAnswerUnlockOutcome = {
  readonly status: "changed";
  readonly enabled: boolean;
};

export class OwnerApprovalAnswerUnlock {
  readonly #state: HubStatePort;
  readonly #record: (change: HubMembershipChangedPayload) => void;

  constructor(options: {
    readonly state: HubStatePort;
    readonly record: (change: HubMembershipChangedPayload) => void;
  }) {
    this.#state = options.state;
    this.#record = options.record;
  }

  /** Whether each answer needs its own unlock, read at the moment an answer is judged. */
  required(): boolean {
    return this.#state.load().ownerUnlockPerApprovalAnswer === true;
  }

  /** Only a window on this host reaches this; the caller has checked. */
  setRequired(enabled: boolean, principal: AuditActingPrincipal): OwnerApprovalAnswerUnlockOutcome {
    const { ownerUnlockPerApprovalAnswer: _previous, ...rest } = this.#state.load();
    this.#state.save(enabled ? { ...rest, ownerUnlockPerApprovalAnswer: true } : rest);
    this.#record({
      change: enabled ? "owner-approval-answer-unlock-on" : "owner-approval-answer-unlock-off",
      actingPrincipal: principal,
    });
    return { status: "changed", enabled };
  }
}
