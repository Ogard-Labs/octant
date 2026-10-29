// What an owner device shows and does about new-member alerts, whichever
// client it is (the phone app or a browser): read every computer's alerts, act
// on one, and say plainly how the action went. The protocol is in hubOwnerClient.

import type { NewMemberAlert } from "@octant/contracts";
import { describeOwnerRefusal, type OwnerActionResult, type OwnerClient } from "./hubOwnerClient";

/** A computer on the hub that this device is an owner of, with the client that reaches it. */
export interface OwnerSpoke {
  readonly memberId: string;
  readonly name: string;
  readonly client: OwnerClient;
}

export interface OwnerAlertRow {
  readonly spoke: { readonly memberId: string; readonly name: string };
  readonly alert: NewMemberAlert;
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
      const heldIds = new Set(
        held.status === "read" ? held.members.map((member) => String(member.memberId)) : [],
      );
      return answer.status === "read"
        ? answer.alerts.map((alert) => ({
            spoke: { memberId: spoke.memberId, name: spoke.name },
            alert,
            held: heldIds.has(String(alert.memberId)),
          }))
        : [];
    }),
    unanswered: answers
      .filter(({ answer }) => answer.status !== "read")
      .map(({ spoke }) => spoke.name),
  };
}

export type OwnerAlertAction = "dismiss" | "remove" | "confirm";

export function runOwnerAlertAction(
  spoke: OwnerSpoke,
  alert: NewMemberAlert,
  action: OwnerAlertAction,
): Promise<OwnerActionResult> {
  if (action === "confirm") return spoke.client.confirmNewMember(alert);
  const alertId = String(alert.alertId);
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
