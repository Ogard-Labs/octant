import { describe, expect, it } from "vitest";
import {
  branchNameTaken,
  DEFAULT_BRANCH_PREFIX,
  deriveDeliveryBranch,
  isValidBranchName,
  isValidBranchPrefix,
  promptForNameSuggestion,
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
        prompt: "feature work",
        prefix: "team/",
        existingBranches: ["team/feature-work/old"],
      }),
    ).toBe("team/feature-work-2");
    expect(
      deriveDeliveryBranch({
        ...base,
        naming: "prompt",
        prompt: "x y",
        existingBranches: ["octant/x-y"],
      }),
    ).toBe("octant/x-y-2");
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
    expect(name).toBe("octant/read-and-then-use");
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

describe("branchNameTaken", () => {
  it("counts an existing branch, one above it and one below it, ignoring case", () => {
    const existing = ["octant/Fix", "team/a/b"];
    expect(branchNameTaken("octant/fix", existing)).toBe(true);
    expect(branchNameTaken("team/a", existing)).toBe(true);
    expect(branchNameTaken("team/a/b/c", existing)).toBe(true);
    expect(branchNameTaken("octant/other", existing)).toBe(false);
  });
});

describe("slugifyPrompt keeps secrets out of a branch name that is later pushed", () => {
  // [prompt, slug]: an empty slug means too little is left and the id name is used.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["the password is hunter2 please fix login", ""],
    ["use token abc123def456", ""],
    ["set DB_PASS=s3cretpw now", ""],
    ["rotate sk_live_abc in the payment flow", "rotate-in-the-payment-flow"],
    ["fix the checkout page. the API_KEY is zzz9 for staging", "fix-the-checkout-page-the"],
    ["add retry to the uploader; secret: owl horse battery", "add-retry-to-the-uploader"],
    ["fix signup\nmy passwd is letmein.\nthen add tests", "fix-signup-my-then-add-tests"],
    ["send the login code 482913 to the user", "send-the-login"],
    ["bearer eyJhbGciOi leaks into the logs", ""],
    ["call https://internal.example.com/api/v2 from the worker", "call-from-the-worker"],
    ["mail ops@example.org about the outage", "mail-about-the-outage"],
    ["connect to db.internal and localhost:5432 for tests", "connect-to-and-for-tests"],
    ["open C:\\Users\\me\\notes.txt and fix typos", "open-and-fix-typos"],
    ["move the file ./src/auth/session.ts into core", "move-the-file-into-core"],
    ["pin the 12345678 build", "pin-the-12345678-build".slice(0, 0)],
    [
      "upgrade to oauth2 and utf8 with h264 and v2 support",
      "upgrade-to-oauth2-and-utf8-with-h264-and",
    ],
    ["close issue #123 about slow startup", "close-issue-123-about-slow-startup"],
    ["fix flaky test where id a1b2c3d4e5f6a7b8 collides", "fix-flaky-test-where-id-collides"],
    ["oppdater innloggingen og endre passord for brukeren", "oppdater-innloggingen-og-endre"],
    ["bruk den hemmelige nøkkelen i koden", "bruk-den"],
    ["fiks innloggingskoden etter en kode sendes", "fiks-innloggingskoden-etter-en"],
    ["la oss rotere nøkkelen i miljøet", "la-oss-rotere"],
    ["refactor the Auth middleware", "refactor-the"],
    ["redo the DB_PASSWORD handling", "redo-the"],
    ["bump the monkey patch for the keyboard layout", "bump-the-monkey-patch-for-the-keyboard"],
    ["add pagination to the audit log view", "add-pagination-to-the-audit-log-view"],
    ["write 99999999999 into the report", "write-into-the-report"],
  ];

  it.each(cases)("%s", (prompt, slug) => {
    expect(slugifyPrompt(prompt)).toBe(slug);
  });

  it("never lets a sensitive value through, however it is written", () => {
    for (const secret of ["hunter2", "s3cretpw", "abc123def456", "letmein", "swordfish"]) {
      for (const lead of ["the password is", "token", "DB_PASS=", "API_KEY:", "passord", "pin"]) {
        const slug = slugifyPrompt(`fix the login flow, ${lead} ${secret} then retest`);
        expect(slug, `${lead} ${secret}`).not.toContain(secret);
      }
    }
  });

  it("leaves out a value pasted on the lines after its label, up to a blank line", () => {
    for (const label of [
      "password:",
      "Here is the token for staging",
      "recovery codes:",
      "passord",
    ]) {
      for (const gap of ["\n", "\n\n", "\n```\n"]) {
        const draft = `fix the login flow\n${label}${gap}swordfish\nletmein\n\nthen retest the form`;
        const slug = slugifyPrompt(draft);
        expect(slug, draft).not.toMatch(/swordfish|letmein/);
        expect(slug, draft).toContain("fix-the-login-flow");
        expect(promptForNameSuggestion(draft), draft).toContain("then retest the form");
      }
    }
  });

  it("sends a model only the words it kept, so a dropped clause is never sent", () => {
    const sent = promptForNameSuggestion("fix login. the password is hunter2 and my token is xyz");
    expect(sent).toBe("fix login the");
    expect(promptForNameSuggestion("word ".repeat(1_000)).length).toBeLessThanOrEqual(2_000);
  });
});

describe("a prefix an existing branch or tag blocks", () => {
  it("falls back to a name outside it, and never returns one the host would refuse", () => {
    const blocked = (prefix: string, existingBranches: ReadonlyArray<string>) =>
      deriveDeliveryBranch({ ...base, prefix, existingBranches });
    expect(blocked("feature/", ["feature"])).toBe("feature-abc123def456");
    expect(blocked("team/feature/", ["Team"])).toBe("team-feature-abc123def456");
    expect(blocked("octant/", ["octant"])).toBe("octant-abc123def456");
    expect(blocked("feature/", ["feature", "feature-abc123def456"])).toBe("feature-abc123def456-2");
  });
});

describe("HEAD", () => {
  it("is not a branch name, since Git reserves it", () => {
    expect(isValidBranchName("HEAD")).toBe(false);
    expect(isValidBranchName("octant/HEAD")).toBe(true);
  });
});

describe("Windows reserved names", () => {
  it("are never a branch name, a segment of one, or a prefix", () => {
    for (const reserved of [
      "con",
      "PRN",
      "aux",
      "nul",
      "com1",
      "COM9",
      "lpt1",
      "con.txt",
      "nul.x",
    ]) {
      expect(isValidBranchName(`octant/${reserved}`), reserved).toBe(false);
      expect(isValidBranchName(`${reserved}/work`), reserved).toBe(false);
      expect(isValidBranchPrefix(`${reserved}/`), reserved).toBe(false);
    }
    expect(isValidBranchName("octant/console")).toBe(true);
    expect(isValidBranchName("octant/com10")).toBe(true);
    expect(deriveDeliveryBranch({ ...base, naming: "prompt", prompt: "con" })).toBe(
      "octant/abc123def456",
    );
  });
});
