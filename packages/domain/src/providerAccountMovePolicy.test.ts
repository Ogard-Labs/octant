import { describe, expect, it } from "vitest";
import { decodeEventActor } from "@octant/contracts/events";
import { decodeProviderInstanceId } from "@octant/contracts/providers";
import { decideProviderAccountMove } from "./providerAccountMovePolicy";

const work = {
  id: decodeProviderInstanceId("84000000-0000-4000-8000-0000000000b1"),
  driverKind: "claude" as const,
};
const personal = {
  id: decodeProviderInstanceId("84000000-0000-4000-8000-0000000000b2"),
  driverKind: "claude" as const,
  enabled: true,
};
const person = decodeEventActor({
  kind: "local-user",
  actorId: "84000000-0000-4000-8000-0000000000c1",
});

describe("moving a thread to another provider account", () => {
  it("moves when the person asks while no turn runs", () => {
    expect(
      decideProviderAccountMove({ actor: person, turnRunning: false, from: work, to: personal }),
    ).toEqual({ kind: "moves" });
    const device = decodeEventActor({
      kind: "remote-device",
      actorId: "84000000-0000-4000-8000-0000000000c2",
      deviceId: "84000000-0000-4000-8000-0000000000c2",
    });
    expect(
      decideProviderAccountMove({ actor: device, turnRunning: false, from: work, to: personal })
        .kind,
    ).toBe("moves");
  });

  it("refuses a move nobody asked for, from the host or from an agent", () => {
    const agent = decodeEventActor({
      kind: "agent",
      actorId: "84000000-0000-4000-8000-0000000000c3",
      providerInstanceId: "84000000-0000-4000-8000-0000000000b1",
      threadId: "84000000-0000-4000-8000-0000000000c4",
    });
    const host = decodeEventActor({
      kind: "system",
      actorId: "84000000-0000-4000-8000-0000000000c5",
    });
    for (const actor of [undefined, agent, host]) {
      expect(
        decideProviderAccountMove({ actor, turnRunning: false, from: work, to: personal }),
      ).toMatchObject({ kind: "refused", reason: "unattended" });
    }
  });

  it("refuses while a turn runs and to an account of another provider, turned off, or the same", () => {
    const refusal = (input: Partial<Parameters<typeof decideProviderAccountMove>[0]>) =>
      decideProviderAccountMove({
        actor: person,
        turnRunning: false,
        from: work,
        to: personal,
        ...input,
      });
    expect(refusal({ turnRunning: true })).toMatchObject({ reason: "turn-running" });
    expect(refusal({ to: { ...personal, driverKind: "codex" } })).toMatchObject({
      reason: "other-provider",
    });
    expect(refusal({ to: { ...personal, enabled: false } })).toMatchObject({
      reason: "account-disabled",
    });
    expect(refusal({ to: { ...work, enabled: true } })).toMatchObject({ reason: "same-account" });
    expect(refusal({ to: undefined })).toMatchObject({ reason: "account-missing" });
  });
});
