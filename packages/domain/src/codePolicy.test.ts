import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import {
  accessPosturesAbove,
  accessPosturesAtOrBelow,
  authorizeCodeOperation,
  clampTurnAccessPosture,
  type CodeActor,
  type CodeOperation,
  type CodePolicyDecision,
} from "./codePolicy";

const actors: ReadonlyArray<CodeActor> = ["local-user", "agent"];
const postures: ReadonlyArray<ProviderExecutionPolicy> = ["plan", "approval-gated", "full-access"];

function decision(
  actor: CodeActor,
  posture: ProviderExecutionPolicy,
  operation: CodeOperation,
): CodePolicyDecision["decision"] {
  return authorizeCodeOperation({ actor, posture, operation }).decision;
}

describe("Code authority policy", () => {
  it("keeps reads available while Plan denies every mutation", () => {
    for (const actor of actors) {
      expect(decision(actor, "plan", "read")).toBe("allow");
      for (const operation of [
        "edit",
        "terminal",
        "test",
        "stage",
        "commit",
        "push",
        "create-pr",
        "merge-pr",
        "managed-root",
        "pr-mutation",
      ] as const) {
        expect(decision(actor, "plan", operation)).toBe("deny");
      }
    }
  });

  it("clamps a per-message posture so it can only narrow the thread", () => {
    expect(clampTurnAccessPosture({ thread: "approval-gated" })).toBe("approval-gated");
    expect(clampTurnAccessPosture({ requested: "plan", thread: "full-access" })).toBe("plan");
    expect(
      clampTurnAccessPosture({ requested: "approval-gated", thread: "auto-accept-edits" }),
    ).toBe("approval-gated");
    expect(
      clampTurnAccessPosture({ requested: "auto-accept-edits", thread: "auto-accept-edits" }),
    ).toBe("auto-accept-edits");
    // A composer that asks for more than the thread grants still runs, under
    // the thread: the intent is not a widening path.
    expect(clampTurnAccessPosture({ requested: "full-access", thread: "approval-gated" })).toBe(
      "approval-gated",
    );
    expect(
      clampTurnAccessPosture({ requested: "auto-accept-edits", thread: "approval-gated" }),
    ).toBe("approval-gated");
    // Plan is read-only from every entry point, including a turn intent.
    expect(clampTurnAccessPosture({ requested: "full-access", thread: "plan" })).toBe("plan");
    expect(clampTurnAccessPosture({ requested: "approval-gated", thread: "plan" })).toBe("plan");
    expect(accessPosturesAtOrBelow("plan")).toEqual(["plan"]);
    expect(accessPosturesAtOrBelow("approval-gated")).toEqual(["plan", "approval-gated"]);
    expect(accessPosturesAtOrBelow("auto-accept-edits")).toEqual([
      "plan",
      "approval-gated",
      "auto-accept-edits",
    ]);
    expect(accessPosturesAtOrBelow("full-access")).toEqual([
      "plan",
      "approval-gated",
      "auto-accept-edits",
      "full-access",
    ]);
    expect(accessPosturesAbove("plan")).toEqual([
      "approval-gated",
      "auto-accept-edits",
      "full-access",
    ]);
    expect(accessPosturesAbove("approval-gated")).toEqual(["auto-accept-edits", "full-access"]);
    expect(accessPosturesAbove("auto-accept-edits")).toEqual(["full-access"]);
    expect(accessPosturesAbove("full-access")).toEqual([]);
  });

  it("auto-accepts only edits and still prompts for every other mutation", () => {
    for (const actor of actors) {
      expect(decision(actor, "auto-accept-edits", "read")).toBe("allow");
      expect(decision(actor, "auto-accept-edits", "edit")).toBe("allow");
      for (const operation of [
        "terminal",
        "test",
        "stage",
        "discard",
        "commit",
        "push",
        "create-pr",
        "merge-pr",
      ] as const) {
        expect(decision(actor, "auto-accept-edits", operation)).toBe("prompt");
      }
    }
  });

  it("prompts for ordinary approval-gated mutations and allows them in Full access", () => {
    for (const actor of actors) {
      for (const operation of [
        "edit",
        "terminal",
        "test",
        "stage",
        "commit",
        "push",
        "create-pr",
        "merge-pr",
      ] as const) {
        expect(decision(actor, "approval-gated", operation)).toBe("prompt");
        expect(decision(actor, "full-access", operation)).toBe("allow");
      }
    }
  });

  it("lets the local user save their own edits under approval-gated without a prompt, but never in Plan", () => {
    const userEdit = (posture: "plan" | "approval-gated" | "full-access") =>
      authorizeCodeOperation({
        actor: "local-user",
        posture,
        operation: "edit",
        initiator: "user",
      }).decision;
    expect(userEdit("approval-gated")).toBe("allow");
    expect(userEdit("full-access")).toBe("allow");
    expect(userEdit("plan")).toBe("deny");
    // Opening their own confined repository terminal is likewise the user's
    // own act; the agent's terminal use stays gated.
    const terminal = (initiator: "user" | "agent") =>
      authorizeCodeOperation({
        actor: "local-user",
        posture: "approval-gated",
        operation: "terminal",
        initiator,
      }).decision;
    expect(terminal("user")).toBe("allow");
    expect(terminal("agent")).toBe("prompt");
    expect(
      authorizeCodeOperation({
        actor: "local-user",
        posture: "plan",
        operation: "terminal",
        initiator: "user",
      }).decision,
    ).toBe("deny");
    // A user-initiated edit is still not authority for other operations…
    expect(
      authorizeCodeOperation({
        actor: "local-user",
        posture: "approval-gated",
        operation: "commit",
        initiator: "user",
      }).decision,
    ).toBe("prompt");
    // …and remote clients stay host-clamped regardless of initiator.
    expect(
      authorizeCodeOperation({
        actor: "remote-client",
        posture: "approval-gated",
        operation: "edit",
        initiator: "user",
      }).decision,
    ).toBe("host-thread-clamped");
  });

  it("forces fresh confirmation for irreversible classes on tainted threads despite Full access", () => {
    const tainted = {
      externalContentIngested: true,
      ingestedSources: ["readme-md"],
    } as const;
    for (const operation of ["discard", "push", "create-pr", "merge-pr"] as const) {
      const result = authorizeCodeOperation({
        actor: "local-user",
        posture: "full-access",
        operation,
        untrustedContent: {
          taint: tainted,
          standingGrant: "remembered-full-access",
          freshPerActionConfirmation: false,
        },
      });
      expect(result.decision).toBe("prompt");
      expect(result.taintedApprovalPrompt).toContain("readme-md");
    }
    expect(
      authorizeCodeOperation({
        actor: "local-user",
        posture: "full-access",
        operation: "edit",
        untrustedContent: {
          taint: tainted,
          standingGrant: "remembered-full-access",
          freshPerActionConfirmation: false,
        },
      }).decision,
    ).toBe("allow");
    expect(
      authorizeCodeOperation({
        actor: "local-user",
        posture: "full-access",
        operation: "push",
        untrustedContent: {
          taint: tainted,
          standingGrant: "remembered-full-access",
          freshPerActionConfirmation: true,
        },
      }).decision,
    ).toBe("allow");
  });

  it("prompts before discarding uncommitted work even when the user asked for it", () => {
    // A plain editor save is the user's own action and needs no prompt. Throwing
    // away uncommitted work is the user's action too, but nothing can undo it,
    // so it is asked about in every posture that asks about anything.
    for (const posture of ["approval-gated", "auto-accept-edits"] as const) {
      expect(
        authorizeCodeOperation({
          actor: "local-user",
          posture,
          operation: "edit",
          initiator: "user",
        }).decision,
      ).toBe("allow");
      expect(
        authorizeCodeOperation({
          actor: "local-user",
          posture,
          operation: "discard",
          initiator: "user",
        }).decision,
      ).toBe("prompt");
    }
    expect(decision("local-user", "plan", "discard")).toBe("deny");
    expect(decision("remote-client", "full-access", "discard")).toBe("host-thread-clamped");
  });

  it("requires local confirmation for managed roots and denies every PR mutation", () => {
    for (const actor of actors) {
      for (const posture of postures.filter((value) => value !== "plan")) {
        expect(decision(actor, posture, "managed-root")).toBe("request-local-confirmation");
      }
      for (const posture of postures) {
        expect(decision(actor, posture, "pr-mutation")).toBe("deny");
      }
    }
  });

  it("clamps remote reads and mutations without allowing remote root confirmation", () => {
    expect(decision("remote-client", "full-access", "read")).toBe("host-clamped");
    for (const operation of ["edit", "terminal", "test", "stage", "commit"] as const) {
      expect(decision("remote-client", "full-access", operation)).toBe("host-thread-clamped");
    }
    for (const operation of ["push", "create-pr", "merge-pr"] as const) {
      expect(decision("remote-client", "full-access", operation)).toBe(
        "host-thread-credential-clamped",
      );
    }
    expect(decision("remote-client", "full-access", "managed-root")).toBe(
      "request-local-confirmation",
    );
    expect(decision("remote-client", "full-access", "pr-mutation")).toBe("deny");
  });
});
