import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { describe, expect, it, vi } from "vitest";
import {
  suggestWorktreeBranchWords,
  type WorktreeBranchSuggestionPorts,
} from "./worktreeBranchSuggestion";

const driver = {} as ProviderDriver;
const request = {
  projectId: "project-1",
  providerInstanceId: "00000000-0000-4000-8000-000000000001" as never,
  modelId: "model-a" as never,
  draft: "Fix the login redirect after the session expires",
};

function ports(overrides: Partial<WorktreeBranchSuggestionPorts> = {}) {
  const settle = vi.fn();
  const abandon = vi.fn();
  const complete = vi.fn(
    async (_input: { prompt: string; modelId: string; instructions?: string }) => ({
      status: "completed" as const,
      text: "Fix login redirect on session expiry",
    }),
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
    expect(sent.prompt).not.toContain("project-1");
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("reduces a reply that names a path or a key to words that are safe in a ref", async () => {
    const { value } = ports({});
    const reply = {
      status: "completed" as const,
      text: "update /etc/passwd and .env for ghp_abcdefghijklmnopqrstuvwxyz0123 deploy",
    };
    const result = await suggestWorktreeBranchWords(
      { ...value, complete: (async () => reply) as never },
      request,
    );
    expect(result).toEqual({ status: "suggested", words: "update-and-for-deploy" });
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

  it("fails without keeping spend when the request never reached the model, and when the reply has no usable words", async () => {
    const unreached = ports({});
    await expect(
      suggestWorktreeBranchWords(
        { ...unreached.value, complete: (async () => ({ status: "unreached" })) as never },
        request,
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(unreached.abandon).toHaveBeenCalledTimes(1);
    const empty = ports({});
    await expect(
      suggestWorktreeBranchWords(
        { ...empty.value, complete: (async () => ({ status: "completed", text: "???" })) as never },
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

  it("calls nothing for an empty draft", async () => {
    const { value, complete } = ports();
    await expect(suggestWorktreeBranchWords(value, { ...request, draft: "   " })).resolves.toEqual({
      status: "failed",
    });
    expect(complete).not.toHaveBeenCalled();
  });
});
