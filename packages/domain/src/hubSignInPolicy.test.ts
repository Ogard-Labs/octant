import { describe, expect, it } from "vitest";
import { decideSignInAdmission, settleSignInRequests } from "./hubSignInPolicy";

const open = {
  granted: true,
  kind: "claude-subscription",
  supportedKinds: ["claude-subscription", "codex-subscription"],
  recentRequests: 0,
  alreadyAsked: false,
  signedIn: false,
} as const;

describe("a spoke weighing a hub's sign-in request", () => {
  it("asks its person when everything allows it", () => {
    expect(decideSignInAdmission(open)).toEqual({ status: "admit", kind: "claude-subscription" });
    expect(decideSignInAdmission({ ...open, signedIn: undefined }).status).toBe("admit");
  });

  it("refuses when its person did not tick the item, before saying anything else", () => {
    expect(
      decideSignInAdmission({ ...open, granted: false, kind: "nonsense", signedIn: true }),
    ).toEqual({ status: "refuse", kind: "sign-in-not-granted" });
  });

  it("refuses a kind it does not know or cannot offer", () => {
    expect(decideSignInAdmission({ ...open, kind: "nonsense" })).toEqual({
      status: "refuse",
      kind: "unknown-kind",
    });
    expect(decideSignInAdmission({ ...open, supportedKinds: ["codex-subscription"] })).toEqual({
      status: "refuse",
      kind: "unknown-kind",
    });
  });

  it("refuses the fourth request in an hour, even for a signed-in account", () => {
    expect(decideSignInAdmission({ ...open, recentRequests: 3, signedIn: true })).toEqual({
      status: "refuse",
      kind: "rate-limited",
    });
  });

  it("refuses a duplicate and an account that is already signed in", () => {
    expect(decideSignInAdmission({ ...open, alreadyAsked: true }).status).toBe("refuse");
    expect(decideSignInAdmission({ ...open, signedIn: true })).toEqual({
      status: "refuse",
      kind: "already-signed-in",
    });
  });
});

describe("a sign-in request's time", () => {
  it("lapses exactly when its time is reached", () => {
    const settled = settleSignInRequests([{ expiresAtMs: 10 }, { expiresAtMs: 11 }], 10);
    expect(settled.expired).toEqual([{ expiresAtMs: 10 }]);
    expect(settled.open).toEqual([{ expiresAtMs: 11 }]);
  });
});
