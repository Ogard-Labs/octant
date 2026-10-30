import type { HeldMember, NewMemberAlert } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { PinnedListenerTransportPort } from "./appPairingCode";
import { createGuestSigner } from "./hubGuestClient";
import { createOwnerClient, type OwnerClient, type OwnerUnlockSigner } from "./hubOwnerClient";
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

describe("alerts read from more than one origin", () => {
  const readOnlyUnlock: OwnerUnlockSigner = {
    shape: "webauthn",
    publicKey: "cGFzc2tleQ",
    assert: async () => ({ status: "unavailable" }),
  };

  async function browserIdentity() {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    return createGuestSigner({ memberId: "00000000-0000-4000-8000-0000000000b1", keyPair });
  }

  it("asks each computer at its own origin, signed for that computer, and never reaches another", async () => {
    const identity = await browserIdentity();
    const calls: Array<{ readonly url: string; readonly sender: string | undefined }> = [];
    const answers = new Map<string, Response>([
      ["https://mini.tail1.ts.net/api/hub/owner/alerts", Response.json({ alerts: [] })],
      ["https://mini.tail1.ts.net/api/hub/owner/held-members", Response.json({ members: [] })],
      ["https://studio.tail1.ts.net/api/hub/owner/alerts", Response.json({ alerts: [] })],
      [
        "https://studio.tail1.ts.net/api/hub/owner/held-members",
        Response.json({ members: [held("a")] }),
      ],
    ]);
    const transport: PinnedListenerTransportPort = ({ origin, trust }) =>
      trust.current.kind === "platform" && origin.endsWith(".ts.net")
        ? {
            status: "available",
            fetch: async (input, init) => {
              const url = String(input);
              calls.push({
                url,
                sender: new Headers(init?.headers).get("x-octant-hub-link")?.split(".")[1],
              });
              return answers.get(url)?.clone() ?? new Response(null, { status: 404 });
            },
          }
        : { status: "unavailable" };
    const spoke = (memberId: string, name: string, origin: string): OwnerSpoke => ({
      memberId,
      name,
      openAt: origin,
      client: createOwnerClient({
        target: { memberId, origin },
        identity,
        unlock: readOnlyUnlock,
        transport,
      }),
    });

    const reading = await readOwnerAlerts([
      spoke("mini-id", "Mac mini", "https://mini.tail1.ts.net"),
      spoke("studio-id", "Studio", "https://studio.tail1.ts.net"),
    ]);

    expect(reading.unanswered).toEqual([]);
    expect(reading.rows.map((row) => [row.spoke.name, row.spoke.openAt, row.member.name])).toEqual([
      ["Studio", "https://studio.tail1.ts.net", "tablet a"],
    ]);
    expect(new Set(calls.map((call) => new URL(call.url).origin))).toEqual(
      new Set(["https://mini.tail1.ts.net", "https://studio.tail1.ts.net"]),
    );
    // Every read is signed by the browser's one identity key.
    for (const call of calls) expect(call.sender).toBe(identity.memberId);
  });

  it("names a computer that did not answer", async () => {
    const identity = await browserIdentity();
    const spoke: OwnerSpoke = {
      memberId: "mini-id",
      name: "Mac mini",
      openAt: "https://mini.tail1.ts.net",
      client: createOwnerClient({
        target: { memberId: "mini-id", origin: "https://mini.tail1.ts.net" },
        identity,
        unlock: readOnlyUnlock,
        transport: () => ({
          status: "available",
          fetch: async () => {
            throw new Error("down");
          },
        }),
      }),
    };

    expect((await readOwnerAlerts([spoke])).unanswered).toEqual(["Mac mini"]);
  });
});
