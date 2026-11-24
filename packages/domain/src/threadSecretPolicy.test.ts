import { describe, expect, it } from "vitest";
import {
  decideThreadSecretLifetime,
  resolveThreadSecretDelivery,
  resolveThreadSecretOffer,
  threadSecretDeliveries,
} from "./threadSecretPolicy";

const open = { mode: "code", strict: false, kind: "token" } as const;

describe("where an agent may ask for a thread secret", () => {
  it("refuses Chat, which runs no commands", () => {
    expect(resolveThreadSecretOffer({ ...open, mode: "chat" })).toEqual({
      status: "unsupported-mode",
    });
  });

  it.each(["work", "code"] as const)("offers every lifetime in %s outside Strict", (mode) => {
    expect(resolveThreadSecretOffer({ ...open, mode })).toEqual({
      status: "offered",
      lifetimes: ["this-command", "this-turn", "1-hour", "24-hours", "until-archived", "remember"],
      defaultLifetime: "24-hours",
    });
  });
});

describe("the lifetimes a card offers", () => {
  it("leaves out 24 hours and Remember under Strict and starts on This turn", () => {
    expect(resolveThreadSecretOffer({ ...open, strict: true })).toEqual({
      status: "offered",
      lifetimes: ["this-command", "this-turn", "1-hour", "until-archived"],
      defaultLifetime: "this-turn",
    });
  });

  it.each([true, false])("never offers Remember for an account password (Strict %s)", (strict) => {
    const offer = resolveThreadSecretOffer({ ...open, kind: "account-password", strict });
    expect(offer).toMatchObject({ status: "offered" });
    expect(offer.status === "offered" && offer.lifetimes).not.toContain("remember");
  });

  it("starts on the person's last choice for the name", () => {
    expect(resolveThreadSecretOffer({ ...open, lastLifetime: "1-hour" })).toMatchObject({
      defaultLifetime: "1-hour",
    });
    expect(
      resolveThreadSecretOffer({ ...open, strict: true, lastLifetime: "until-archived" }),
    ).toMatchObject({ defaultLifetime: "until-archived" });
  });

  it("falls back when the last choice is no longer offered", () => {
    expect(
      resolveThreadSecretOffer({ ...open, strict: true, lastLifetime: "remember" }),
    ).toMatchObject({ defaultLifetime: "this-turn" });
    expect(
      resolveThreadSecretOffer({ ...open, kind: "account-password", lastLifetime: "remember" }),
    ).toMatchObject({ defaultLifetime: "24-hours" });
  });
});

describe("the lifetime an answer asks for", () => {
  it("accepts one the card offers", () => {
    expect(decideThreadSecretLifetime(open, "remember")).toEqual({
      status: "allowed",
      lifetime: "remember",
    });
  });

  it("names Strict when Strict is what rules the lifetime out", () => {
    for (const lifetime of ["24-hours", "remember"] as const)
      expect(decideThreadSecretLifetime({ ...open, strict: true }, lifetime)).toEqual({
        status: "refused",
        failure: "refused-by-strict",
      });
  });

  it("refuses to remember an account password at any level", () => {
    for (const strict of [true, false])
      expect(
        decideThreadSecretLifetime({ ...open, kind: "account-password", strict }, "remember"),
      ).toEqual({ status: "refused", failure: "lifetime-not-offered" });
  });

  it("refuses any lifetime in Chat", () => {
    expect(decideThreadSecretLifetime({ ...open, mode: "chat" }, "this-turn")).toEqual({
      status: "refused",
      failure: "unsupported-mode",
    });
  });
});

describe("how a saved secret reaches its use", () => {
  const file = {
    requested: "file",
    lifetime: "24-hours",
    strict: false,
    commandsConfined: false,
    freshEachUse: false,
  } as const;

  it("writes a file only where the thread's own commands run outside a sandbox", () => {
    expect(resolveThreadSecretDelivery(file)).toBe("file-and-environment");
    expect(resolveThreadSecretDelivery({ ...file, strict: true })).toBe("environment");
    expect(resolveThreadSecretDelivery({ ...file, commandsConfined: true })).toBe("environment");
  });

  it("writes no file for a secret that lasts one command", () => {
    expect(resolveThreadSecretDelivery({ ...file, lifetime: "this-command" })).toBe("environment");
  });

  it("writes no file when every use reads the item again", () => {
    for (const strict of [true, false])
      expect(resolveThreadSecretDelivery({ ...file, freshEachUse: true, strict })).toBe("op-run");
  });

  it("keeps a handle a handle, away from the agent's shell", () => {
    for (const strict of [true, false])
      for (const freshEachUse of [true, false])
        expect(
          resolveThreadSecretDelivery({ ...file, requested: "handle", freshEachUse, strict }),
        ).toBe("handle");
  });

  it("gives each field its own file name and variable", () => {
    expect(threadSecretDeliveries("SERVICE", ["EMAIL", "TOKEN"])).toEqual([
      {
        field: "EMAIL",
        secretName: "SERVICE_EMAIL",
        environmentName: "OCTANT_SECRET_SERVICE_EMAIL",
      },
      {
        field: "TOKEN",
        secretName: "SERVICE_TOKEN",
        environmentName: "OCTANT_SECRET_SERVICE_TOKEN",
      },
    ]);
  });

  it("uses the request's own name when it has one unnamed value", () => {
    expect(threadSecretDeliveries("DEPLOY_TOKEN", undefined)).toEqual([
      {
        field: "DEPLOY_TOKEN",
        secretName: "DEPLOY_TOKEN",
        environmentName: "OCTANT_SECRET_DEPLOY_TOKEN",
      },
    ]);
  });
});
