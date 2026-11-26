import { describe, expect, it } from "vitest";
import { decodeEventActor } from "@octant/contracts/events";
import { decodeProviderInstanceId } from "@octant/contracts/providers";
import {
  decideProviderAccountMove,
  decideUsageLimitHandoff,
  decideUsageLimitHandoffSetting,
  stopLeftToUsageLimitHandoff,
} from "./providerAccountMovePolicy";

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
      decideProviderAccountMove({
        actor: person,
        turnRunning: false,
        modelPoolOn: false,
        from: work,
        to: personal,
      }),
    ).toEqual({ kind: "moves" });
    const device = decodeEventActor({
      kind: "remote-device",
      actorId: "84000000-0000-4000-8000-0000000000c2",
      deviceId: "84000000-0000-4000-8000-0000000000c2",
    });
    expect(
      decideProviderAccountMove({
        actor: device,
        turnRunning: false,
        modelPoolOn: false,
        from: work,
        to: personal,
      }).kind,
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
        decideProviderAccountMove({
          actor,
          turnRunning: false,
          modelPoolOn: false,
          from: work,
          to: personal,
        }),
      ).toMatchObject({ kind: "refused", reason: "unattended" });
    }
  });

  it("refuses while a turn runs or a model pool is on, and to an account of another provider, turned off, or the same", () => {
    const refusal = (input: Partial<Parameters<typeof decideProviderAccountMove>[0]>) =>
      decideProviderAccountMove({
        actor: person,
        turnRunning: false,
        modelPoolOn: false,
        from: work,
        to: personal,
        ...input,
      });
    expect(refusal({ turnRunning: true })).toMatchObject({ reason: "turn-running" });
    expect(refusal({ modelPoolOn: true })).toMatchObject({ reason: "model-pool" });
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

describe("handing a thread off when its account hits its usage limit", () => {
  const from = { ...work, displayName: "Work" };
  const to = { ...personal, displayName: "Personal" };
  const limited = {
    targetProviderInstanceId: String(personal.id),
    lastStopId: undefined,
    limitStopId: "turn-1",
    modelPoolOn: false,
    from,
    to,
  };

  it("hands off once to the named account on a usage-limit stop", () => {
    expect(decideUsageLimitHandoff(limited)).toEqual({ kind: "hands-off" });
    expect(decideUsageLimitHandoff({ ...limited, lastStopId: "turn-1" })).toEqual({
      kind: "stays",
    });
  });

  it("does nothing without the opt-in or without a usage-limit stop", () => {
    expect(decideUsageLimitHandoff({ ...limited, targetProviderInstanceId: undefined })).toEqual({
      kind: "stays",
    });
    expect(decideUsageLimitHandoff({ ...limited, limitStopId: undefined })).toEqual({
      kind: "stays",
    });
  });

  it("stops and says why when the named account cannot take the thread or hit its limit too", () => {
    expect(decideUsageLimitHandoff({ ...limited, to: { ...to, enabled: false } })).toMatchObject({
      kind: "stopped",
      message: "Personal is turned off.",
    });
    expect(decideUsageLimitHandoff({ ...limited, to: undefined })).toMatchObject({
      kind: "stopped",
    });
    expect(
      decideUsageLimitHandoff({ ...limited, from: { ...to, driverKind: "claude" as const } }),
    ).toMatchObject({ kind: "stopped", message: expect.stringContaining("usage limit too") });
  });

  it("refuses the opt-in on a pooled thread and from anyone but the person", () => {
    expect(
      decideUsageLimitHandoffSetting({
        actor: person,
        modelPoolOn: true,
        from: work,
        to: personal,
      }),
    ).toMatchObject({ kind: "refused", reason: "model-pool" });
    expect(
      decideUsageLimitHandoffSetting({
        actor: undefined,
        modelPoolOn: false,
        from: work,
        to: personal,
      }),
    ).toMatchObject({ kind: "refused", reason: "unattended" });
    expect(
      decideUsageLimitHandoffSetting({
        actor: person,
        modelPoolOn: false,
        from: work,
        to: personal,
      }),
    ).toEqual({ kind: "moves" });
    expect(
      decideUsageLimitHandoffSetting({ actor: person, modelPoolOn: true, from: work, to: "off" }),
    ).toEqual({ kind: "moves" });
    expect(
      decideUsageLimitHandoffSetting({
        actor: undefined,
        modelPoolOn: false,
        from: work,
        to: "off",
      }),
    ).toMatchObject({ kind: "refused", reason: "unattended" });
  });
});

describe("a usage-limit stop left to the thread's account handoff", () => {
  const accountA = { ...work, enabled: true, displayName: "Work" };
  const accountB = { ...personal, enabled: true, displayName: "Personal" };
  const handingOff = {
    providerInstanceId: String(accountA.id),
    usageLimitHandoff: { providerInstanceId: String(accountB.id) },
  };
  const left = (
    thread: Parameters<typeof stopLeftToUsageLimitHandoff>[0]["thread"],
    options: { readonly to?: typeof accountB | undefined; readonly modelPoolOn?: boolean } = {
      to: accountB,
    },
  ) =>
    stopLeftToUsageLimitHandoff({
      thread,
      stopId: "stop-1",
      modelPoolOn: options.modelPoolOn ?? false,
      from: accountA,
      to: "to" in options ? options.to : accountB,
    });

  it("is left to a handoff that will move the thread to another account", () => {
    expect(left(handingOff)).toBe(true);
  });

  it("is left alone once a move released it, whoever made the move", () => {
    expect(left({ providerHandoff: { releasedStopId: "stop-1" } })).toBe(true);
    expect(left({ releasedStopId: "stop-1" })).toBe(true);
  });

  it("is not the handoff's when the opt-in is off, refused, or already stopped on this stop", () => {
    expect(left({})).toBe(false);
    expect(left({ providerHandoff: { releasedStopId: "an-earlier-stop" } })).toBe(false);
    // The account it would move to is disabled or gone, or a pool is on.
    expect(left(handingOff, { to: { ...accountB, enabled: false } })).toBe(false);
    expect(left(handingOff, { to: undefined })).toBe(false);
    expect(left(handingOff, { modelPoolOn: true })).toBe(false);
    // The opt-in names the account the thread is already on.
    expect(left({ usageLimitHandoff: { providerInstanceId: String(accountA.id) } })).toBe(false);
    // The handoff already acted on this stop and stopped.
    expect(
      left({
        usageLimitHandoff: { providerInstanceId: String(accountB.id), last: { stopId: "stop-1" } },
      }),
    ).toBe(false);
  });
});
