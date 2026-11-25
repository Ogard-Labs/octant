import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRANCH_PREFIX,
  deriveDeliveryBranch,
  isValidBranchName,
  isValidBranchPrefix,
  slugifyPrompt,
} from "./codeWorktreeNaming";
import { defaultDeliveryBranchIntent } from "./codeWorktreeSourcePolicy";

const base = { baseBranch: "main", shortId: "abc123def456" } as const;

describe("deriveDeliveryBranch", () => {
  it("keeps the short-id name a default install has always had", () => {
    expect(deriveDeliveryBranch(base)).toBe(defaultDeliveryBranchIntent("main", "abc123def456"));
    expect(deriveDeliveryBranch({ ...base, prompt: "Fix the login page" })).toBe(
      "octant/abc123def456",
    );
  });

  it("names the branch from the prefix and a slug of the prompt when asked", () => {
    expect(
      deriveDeliveryBranch({
        ...base,
        naming: "prompt",
        prefix: "henrik/",
        prompt: "Fix the login page redirect!",
      }),
    ).toBe("henrik/fix-the-login-page-redirect");
  });

  it("falls back to the short id when the prompt has no usable words", () => {
    expect(deriveDeliveryBranch({ ...base, naming: "prompt", prompt: "  ???  " })).toBe(
      "octant/abc123def456",
    );
  });

  it("adds a number when the name is taken, ignoring case", () => {
    const taken = ["octant/fix-login", "OCTANT/fix-login-2"];
    expect(
      deriveDeliveryBranch({
        ...base,
        naming: "prompt",
        prompt: "fix login",
        existingBranches: taken,
      }),
    ).toBe("octant/fix-login-3");
  });

  it("avoids a name that would sit above or below an existing branch", () => {
    expect(
      deriveDeliveryBranch({
        ...base,
        naming: "prompt",
        prompt: "feature",
        prefix: "team/",
        existingBranches: ["team/feature/old"],
      }),
    ).toBe("team/feature-2");
    expect(
      deriveDeliveryBranch({
        ...base,
        naming: "prompt",
        prompt: "x",
        existingBranches: ["octant/x"],
      }),
    ).toBe("octant/x-2");
  });

  it("never returns the base branch", () => {
    expect(
      deriveDeliveryBranch({
        baseBranch: "octant/fix-login",
        shortId: "abc",
        naming: "prompt",
        prompt: "fix login",
      }),
    ).toBe("octant/fix-login-2");
  });

  it("always returns a valid Git branch name", () => {
    for (const prompt of [
      "a..b",
      "end with .lock",
      "x@{y}",
      "tab\tand\nnewline",
      "日本語のタイトル",
      "-leading dash",
      "x".repeat(500),
      "emoji 🎉 party",
    ]) {
      const name = deriveDeliveryBranch({ ...base, naming: "prompt", prompt });
      expect(isValidBranchName(name), name).toBe(true);
      expect(name.length).toBeLessThanOrEqual(120);
    }
  });

  it("leaves secrets and protected paths out of the name", () => {
    const name = deriveDeliveryBranch({
      ...base,
      naming: "prompt",
      prompt:
        "read ~/.ssh/id_rsa and .env then use sk-abcdefghijklmnopqrstuvwxyz123456 token=hunter2 plus ghp_abcdefghijklmnopqrstuvwxyz0123 on /etc/passwd",
    });
    expect(name).toBe("octant/read-and-then-use-plus-on");
    expect(slugifyPrompt("password: swordfish credentials file")).not.toContain("swordfish");
  });

  it("falls back to the default prefix when the saved prefix is not usable", () => {
    expect(deriveDeliveryBranch({ ...base, prefix: "bad prefix/" })).toBe(
      `${DEFAULT_BRANCH_PREFIX}abc123def456`,
    );
  });
});

describe("isValidBranchPrefix", () => {
  it("accepts plain prefixes and refuses ones Git would reject", () => {
    for (const ok of ["octant/", "henrik/", "feat/team-a/", "wip-", "a.b/"]) {
      expect(isValidBranchPrefix(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "/",
      "a//b/",
      "../",
      "a b/",
      "-x/",
      ".x/",
      "x.lock/",
      "a@{/",
      "~/",
      "x:",
    ]) {
      expect(isValidBranchPrefix(bad), bad).toBe(false);
    }
  });
});
