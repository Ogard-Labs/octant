import { describe, expect, it } from "vitest";
import { decideConversationSession } from "./conversationSessionPolicy";

const runtime = { providerInstanceId: "claude", owner: "runtime" } as const;
const host = { providerInstanceId: "local", owner: "host" } as const;

describe("decideConversationSession", () => {
  it("rebuilds the history on the host for a provider that keeps none, whatever ran before", () => {
    for (const previous of [
      undefined,
      { providerInstanceId: "claude", continuable: true },
      { providerInstanceId: "removed", continuable: false },
    ]) {
      expect(
        decideConversationSession({
          recipient: host,
          ...(previous === undefined ? {} : { previous }),
          handoff: "refused",
        }),
      ).toEqual({ kind: "host-rebuild" });
    }
  });

  it("starts a plain session on the first turn of a provider that keeps its conversation", () => {
    expect(decideConversationSession({ recipient: runtime, handoff: "allowed" })).toEqual({
      kind: "new-session",
    });
  });

  it("resumes the session when the same provider can take it up again", () => {
    expect(
      decideConversationSession({
        recipient: runtime,
        previous: { providerInstanceId: "claude", continuable: true },
        handoff: "allowed",
      }),
    ).toEqual({ kind: "continue-session" });
  });

  it("refuses rather than hand over a conversation the same provider still holds", () => {
    expect(
      decideConversationSession({
        recipient: runtime,
        previous: { providerInstanceId: "claude", continuable: false },
        handoff: "allowed",
      }),
    ).toEqual({ kind: "refuse", reason: "session-unrecoverable" });
  });

  it("hands the conversation over when it moves to a provider that keeps its own session", () => {
    for (const previous of ["local", "codex"]) {
      expect(
        decideConversationSession({
          recipient: runtime,
          previous: { providerInstanceId: previous, continuable: false },
          handoff: "allowed",
        }),
      ).toEqual({ kind: "new-session-with-handoff", reason: "provider-switch" });
    }
  });

  it("hands a branch its carried messages before it has a session of its own", () => {
    expect(
      decideConversationSession({
        recipient: runtime,
        previous: { providerInstanceId: "claude", continuable: false },
        branchWithoutSession: true,
        handoff: "allowed",
      }),
    ).toEqual({ kind: "new-session-with-handoff", reason: "branch" });
  });

  it("never starts a handed-over session for a retry, resume or edit", () => {
    expect(
      decideConversationSession({
        recipient: runtime,
        previous: { providerInstanceId: "local", continuable: false },
        handoff: "refused",
      }),
    ).toEqual({ kind: "refuse", reason: "handoff-unavailable" });
    expect(
      decideConversationSession({
        recipient: runtime,
        previous: { providerInstanceId: "claude", continuable: false },
        branchWithoutSession: true,
        handoff: "refused",
      }),
    ).toEqual({ kind: "refuse", reason: "handoff-unavailable" });
  });
});
