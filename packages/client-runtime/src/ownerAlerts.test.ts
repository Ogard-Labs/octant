import type { HeldMember, NewMemberAlert } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { OwnerClient } from "./hubOwnerClient";
import { readOwnerAlerts, runOwnerAlertAction, type OwnerSpoke } from "./ownerAlerts";

const held = (suffix: string): HeldMember =>
  ({
    memberId: `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    name: `tablet ${suffix}`,
    role: "spoke",
    identityKeyFingerprint: suffix.repeat(64).slice(0, 64),
  }) as HeldMember;

const alertFor = (member: HeldMember, alertSuffix: string): NewMemberAlert =>
  ({
    ...member,
    alertId: `00000000-0000-4000-8000-${alertSuffix.padStart(12, "0")}`,
    raisedAt: "2026-10-29T10:00:00.000Z",
  }) as NewMemberAlert;

function spokeWith(input: {
  alerts: ReadonlyArray<NewMemberAlert>;
  held: ReadonlyArray<HeldMember>;
  confirmed?: unknown[];
}): OwnerSpoke {
  const client: OwnerClient = {
    alerts: async () => ({ status: "read", alerts: input.alerts }),
    heldMembers: async () => ({ status: "read", members: input.held }),
    dismissAlert: async () => ({ status: "done", body: {} }),
    removeFromAlert: async () => ({ status: "done", body: {} }),
    setConfirmNewMembers: async () => ({ status: "done", body: {} }),
    confirmNewMember: async (member) => {
      input.confirmed?.push(member);
      return { status: "done", body: {} };
    },
  };
  return { memberId: "spoke-1", name: "Mac mini", client };
}

describe("an owner's list of members to look at", () => {
  it("still offers Confirm for a held member after its alert was dismissed", async () => {
    const tablet = held("a");
    const confirmed: unknown[] = [];
    const spoke = spokeWith({ alerts: [], held: [tablet], confirmed });

    const reading = await readOwnerAlerts([spoke]);

    expect(reading.rows).toHaveLength(1);
    const [row] = reading.rows;
    expect(row).toMatchObject({ held: true, alert: undefined, member: { name: "tablet a" } });
    if (row === undefined) throw new Error("expected a row");
    expect(await runOwnerAlertAction(spoke, row, "confirm")).toEqual({ status: "done", body: {} });
    expect(confirmed).toHaveLength(1);
  });

  it("still offers Confirm for a held member whose alert the computer evicted", async () => {
    const members = Array.from({ length: 3 }, (_, index) => held(String(index + 1)));
    const spoke = spokeWith({ alerts: [alertFor(members[2] as HeldMember, "f3")], held: members });

    const reading = await readOwnerAlerts([spoke]);

    expect(reading.rows.map((row) => [row.member.name, row.held, row.alert !== undefined])).toEqual(
      [
        ["tablet 3", true, true],
        ["tablet 1", true, false],
        ["tablet 2", true, false],
      ],
    );
  });

  it("lists a member once when it has both an alert and a hold", async () => {
    const tablet = held("a");
    const spoke = spokeWith({ alerts: [alertFor(tablet, "f1")], held: [tablet] });

    const reading = await readOwnerAlerts([spoke]);

    expect(reading.rows).toHaveLength(1);
    expect(reading.rows[0]).toMatchObject({ held: true });
  });

  it("has no alert to dismiss or remove for a member the computer only holds", async () => {
    const spoke = spokeWith({ alerts: [], held: [held("a")] });
    const [row] = (await readOwnerAlerts([spoke])).rows;
    if (row === undefined) throw new Error("expected a row");

    expect(await runOwnerAlertAction(spoke, row, "dismiss")).toEqual({
      status: "refused",
      kind: "no-such-alert",
    });
  });
});
