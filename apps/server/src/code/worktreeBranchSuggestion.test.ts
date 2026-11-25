import { decodeProjectId } from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  suggestWorktreeBranchWords,
  type WorktreeBranchSuggestionPorts,
} from "./worktreeBranchSuggestion";

const driver = {} as ProviderDriver;
const request = {
  projectId: decodeProjectId("00000000-0000-4000-8000-0000000000a1"),
  providerInstanceId: "00000000-0000-4000-8000-000000000001" as never,
  modelId: "model-a" as never,
  draft: "Fix the login redirect after the session expires",
};

function ports(overrides: Partial<WorktreeBranchSuggestionPorts> = {}) {
  const settle = vi.fn();
  const abandon = vi.fn();
  const complete = vi.fn(
    async (input: {
      prompt: string;
      modelId: string;
      instructions?: string;
      signal?: AbortSignal;
      onSend?: (sent: boolean) => void;
    }) => {
      input.onSend?.(true);
      return { status: "completed" as const, text: "Fix login redirect on session expiry" };
    },
  );
  const value: WorktreeBranchSuggestionPorts = {
    open: () => ({ status: "ready", driver }),
    admit: () => ({ status: "admitted", settle, abandon }),
    scratchRoot: "/scratch",
    uuid: () => "00000000-0000-4000-8000-0000000000aa",
    complete: complete as never,
    ...overrides,
  };
  return { value, settle, abandon, complete };
}

/** A model call whose prompt was handed to the provider before this came back. */
function answering(outcome: object): never {
  return (async (input: { onSend?: (sent: boolean) => void }) => {
    input.onSend?.(true);
    return outcome;
  }) as never;
}

describe("suggestWorktreeBranchWords", () => {
  it("sends only the redacted draft to the model the person selected and returns branch-safe words", async () => {
    const { value, complete, settle } = ports();
    const result = await suggestWorktreeBranchWords(value, {
      ...request,
      draft: `${request.draft} with token=hunter2 and sk-abcdefghijklmnopqrstuvwxyz123456`,
    });
    expect(result).toEqual({ status: "suggested", words: "fix-login-redirect-on-session-expiry" });
    expect(complete).toHaveBeenCalledTimes(1);
    const sent = complete.mock.calls[0]![0];
    expect(sent.modelId).toBe("model-a");
    expect(sent.prompt).not.toContain("hunter2");
    expect(sent.prompt).not.toContain("sk-abc");
    expect(sent.prompt).not.toContain("0000000000a1");
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("reduces a reply that names a path or a key to words that are safe in a ref", async () => {
    const { value } = ports({});
    const reply = {
      status: "completed" as const,
      text: "update /etc/passwd and .env for ghp_abcdefghijklmnopqrstuvwxyz0123 deploy",
    };
    const result = await suggestWorktreeBranchWords(
      { ...value, complete: answering(reply) },
      request,
    );
    expect(result).toEqual({ status: "suggested", words: "update-and-for" });
  });

  it("makes no call when the model is not allowed or the spend limit refuses", async () => {
    const blocked = ports({ open: () => ({ status: "refused", reason: "not-allowed" }) });
    await expect(suggestWorktreeBranchWords(blocked.value, request)).resolves.toEqual({
      status: "refused",
      reason: "not-allowed",
    });
    const limited = ports({ admit: () => ({ status: "refused" }) });
    await expect(suggestWorktreeBranchWords(limited.value, request)).resolves.toEqual({
      status: "refused",
      reason: "spend-limited",
    });
    expect(blocked.complete).not.toHaveBeenCalled();
    expect(limited.complete).not.toHaveBeenCalled();
  });

  it("fails but settles the reservation when a request that was sent got no answer, and fails on a reply with no usable words", async () => {
    const unreached = ports({});
    await expect(
      suggestWorktreeBranchWords(
        { ...unreached.value, complete: answering({ status: "unreached" }) },
        request,
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(unreached.settle).toHaveBeenCalledTimes(1);
    expect(unreached.abandon).not.toHaveBeenCalled();
    const empty = ports({});
    await expect(
      suggestWorktreeBranchWords(
        { ...empty.value, complete: answering({ status: "completed", text: "???" }) },
        request,
      ),
    ).resolves.toEqual({ status: "failed" });
    const thrown = ports({});
    await expect(
      suggestWorktreeBranchWords(
        {
          ...thrown.value,
          complete: (async () => {
            throw new Error("boom");
          }) as never,
        },
        request,
      ),
    ).resolves.toEqual({ status: "failed" });
  });

  it("records what was spent, and gives back a reservation whose request was never sent", async () => {
    const usage = { inputTokens: 40, outputTokens: 6 };
    const paid = ports({ complete: answering({ status: "completed", text: "fix it now", usage }) });
    await suggestWorktreeBranchWords(paid.value, request);
    expect(paid.settle).toHaveBeenCalledWith(usage);
    const unsent = ports({ complete: (async () => ({ status: "unreached" })) as never });
    await expect(suggestWorktreeBranchWords(unsent.value, request)).resolves.toEqual({
      status: "failed",
    });
    expect(unsent.settle).not.toHaveBeenCalled();
    expect(unsent.abandon).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a request the provider's own checks refused before sending it", async () => {
    const { value, settle, abandon } = ports({
      open: () => ({
        status: "ready",
        driver: {
          acquire: () =>
            Effect.succeed({
              start: () => Effect.void,
              stop: () => Effect.void,
              subscribe: Effect.succeed(Stream.never),
              send: () =>
                Effect.fail({
                  category: "invalid-configuration",
                  message: "The provider request exceeded the configured size limit.",
                }),
            }),
        } as never,
      }),
    });
    const { complete: _mocked, ...real } = value;
    await expect(suggestWorktreeBranchWords(real, request)).resolves.toEqual({ status: "failed" });
    expect(settle).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("records a request the provider failed after sending it, whatever the failure says", async () => {
    const { value, settle, abandon } = ports({
      open: () => ({
        status: "ready",
        driver: {
          acquire: () =>
            Effect.succeed({
              start: () => Effect.void,
              stop: () => Effect.void,
              subscribe: Effect.succeed(
                Stream.make({
                  kind: "failed",
                  sessionId: "00000000-0000-4000-8000-0000000000aa",
                  failure: { category: "invalid-configuration", message: "Redirected." },
                }),
              ),
              send: () => Effect.void,
            }),
        } as never,
      }),
    });
    const { complete: _mocked, ...real } = value;
    await expect(suggestWorktreeBranchWords(real, request)).resolves.toEqual({ status: "failed" });
    expect(settle).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(abandon).not.toHaveBeenCalled();
  });

  it("sends only the words a branch name may carry, and nothing from a clause about a secret", async () => {
    const { value, complete } = ports();
    await suggestWorktreeBranchWords(value, {
      ...request,
      draft: "fix the login redirect. the password is hunter2 for staging. then add a test",
    });
    expect(complete.mock.calls[0]![0].prompt).toBe("fix the login redirect the then add a test");
  });

  it("passes the caller's stop signal to the model call", async () => {
    const { value, complete } = ports();
    const controller = new AbortController();
    await suggestWorktreeBranchWords(value, { ...request, signal: controller.signal });
    expect(complete.mock.calls[0]![0].signal).toBe(controller.signal);
  });

  it("calls nothing for an empty draft", async () => {
    const { value, complete } = ports();
    await expect(suggestWorktreeBranchWords(value, { ...request, draft: "   " })).resolves.toEqual({
      status: "failed",
    });
    expect(complete).not.toHaveBeenCalled();
  });
});
