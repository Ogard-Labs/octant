// What an owner device shows and does about new-member alerts, whichever
// client it is (the phone app or a browser): read every computer's alerts, act
// on one, and say plainly how the action went. The protocol is in hubOwnerClient.

import type { HeldMember, NewMemberAlert } from "@octant/contracts";
import { describeOwnerRefusal, type OwnerActionResult, type OwnerClient } from "./hubOwnerClient";

/** A computer on the hub that this device is an owner of, with the client that reaches it. */
export interface OwnerSpoke {
  readonly memberId: string;
  readonly name: string;
  readonly client: OwnerClient;
}

export interface OwnerAlertRow {
  readonly spoke: { readonly memberId: string; readonly name: string };
  /** The member this row is about: named by its alert, or by the computer's hold when no alert is left. */
  readonly member: HeldMember;
  /** The alert that raised the member; none once it was dismissed or the computer dropped it. Remove and Dismiss need it. */
  readonly alert: NewMemberAlert | undefined;
  /** Whether that computer holds the member under Confirm new members; Confirm applies only then. */
  readonly held: boolean;
}

export interface OwnerAlertReading {
  readonly rows: ReadonlyArray<OwnerAlertRow>;
  /** Computers that did not answer, so the person knows the list may be short. */
  readonly unanswered: ReadonlyArray<string>;
}

export async function readOwnerAlerts(
  spokes: ReadonlyArray<OwnerSpoke>,
): Promise<OwnerAlertReading> {
  const answers = await Promise.all(
    spokes.map(async (spoke) => ({
      spoke,
      answer: await spoke.client.alerts(),
      held: await spoke.client.heldMembers(),
    })),
  );
  return {
    rows: answers.flatMap(({ spoke, answer, held }) => {
      // A computer that did not say what it holds shows no Confirm.
      const heldMembers = held.status === "read" ? held.members : [];
      const heldIds = new Set(heldMembers.map((member) => String(member.memberId)));
      const alerts = answer.status === "read" ? answer.alerts : [];
      const where = { memberId: spoke.memberId, name: spoke.name };
      const raised = alerts.map(
        (alert): OwnerAlertRow => ({
          spoke: where,
          member: alert,
          alert,
          held: heldIds.has(String(alert.memberId)),
        }),
      );
      // A held member stays confirmable without an alert: the person may have
      // dismissed it, and a computer keeps only its newest alerts.
      const alerted = new Set(alerts.map((alert) => String(alert.memberId)));
      const holdOnly = heldMembers
        .filter((member) => !alerted.has(String(member.memberId)))
        .map((member): OwnerAlertRow => ({ spoke: where, member, alert: undefined, held: true }));
      return [...raised, ...holdOnly];
    }),
    unanswered: answers
      .filter(({ answer, held }) => answer.status !== "read" || held.status !== "read")
      .map(({ spoke }) => spoke.name),
  };
}

export type OwnerAlertAction = "dismiss" | "remove" | "confirm";

export function runOwnerAlertAction(
  spoke: OwnerSpoke,
  row: Pick<OwnerAlertRow, "member" | "alert">,
  action: OwnerAlertAction,
): Promise<OwnerActionResult> {
  if (action === "confirm") return spoke.client.confirmNewMember(row.member);
  // Dismiss and Remove name an alert; a member the computer only holds has none.
  if (row.alert === undefined) return Promise.resolve({ status: "refused", kind: "no-such-alert" });
  const alertId = String(row.alert.alertId);
  return action === "dismiss"
    ? spoke.client.dismissAlert(alertId)
    : spoke.client.removeFromAlert(alertId);
}

export interface OwnerActionNotice {
  readonly tone: "done" | "problem";
  readonly message: string;
}

/** What the person is told after an action: what happened, or what to do next. */
export function ownerActionNotice(result: OwnerActionResult, done: string): OwnerActionNotice {
  switch (result.status) {
    case "done":
      return { tone: "done", message: done };
    case "refused":
      return { tone: "problem", message: describeOwnerRefusal(result.kind) };
    case "not-unlocked":
      return {
        tone: "problem",
        message:
          result.reason === "cancelled"
            ? "Nothing changed. The unlock was cancelled."
            : "Nothing changed. This device could not ask for your unlock.",
      };
    case "unreachable":
      return {
        tone: "problem",
        message: "Couldn't reach that computer. Check that you are on the same private network.",
      };
  }
}
