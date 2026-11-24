import { describe, expect, it } from "vitest";
import { forgeReferencesFromToolCall } from "./forgeReferences";

describe("forgeReferencesFromToolCall", () => {
  it("records a pull request a shell command created, from the address gh printed", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: 'gh pr create --title "Add search" --body "x"',
        output:
          "Creating pull request for feature/search into main\nhttps://github.com/acme/app/pull/343\n",
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "pull-request",
        action: "created",
        owner: "acme",
        repository: "app",
        number: 343,
      },
    ]);
  });

  it("completes a merged number's repository from gh's success line", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr merge 327 --squash --delete-branch",
        output: "✓ Squashed and merged pull request acme/app#327 (Add shortcuts)\n✓ Deleted branch",
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "pull-request",
        action: "merged",
        owner: "acme",
        repository: "app",
        number: 327,
      },
    ]);
  });

  it("takes the repository from --repo and records every write in a chained command", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr review 12 --approve -R acme/app && gh issue close 7 --repo acme/app",
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "pull-request",
        action: "reviewed",
        owner: "acme",
        repository: "app",
        number: 12,
      },
      {
        forge: "github",
        kind: "issue",
        action: "closed",
        owner: "acme",
        repository: "app",
        number: 7,
        state: "closed",
      },
    ]);
  });

  it("credits a write before a || fallback only when its own output confirms it", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr review 12 --approve -R acme/app || gh pr view 12 -R acme/app",
        output:
          "failed to create review: Can not approve your own pull request\nhttps://github.com/acme/app/pull/12",
      }),
      // The fallback view printed the address, but no line says a review was
      // submitted, so the approval is not credited.
    ).toBeUndefined();
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr review 12 --approve -R acme/app || true",
        output: "✓ Approved pull request acme/app#12",
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "pull-request",
        action: "reviewed",
        owner: "acme",
        repository: "app",
        number: 12,
      },
    ]);
  });

  it("takes a write's target from its own arguments, never from an address cited in its body", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command:
          'gh pr comment 12 -R acme/app --body "Superseded by https://github.com/acme/app/pull/44"',
        output: "https://github.com/acme/app/pull/12#issuecomment-1",
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "pull-request",
        action: "commented",
        owner: "acme",
        repository: "app",
        number: 12,
      },
    ]);
  });

  it("records an issue a command closed or reopened with that state", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh issue close 7 --repo acme/app",
        output: "✓ Closed issue acme/app#7 (Docs are stale)",
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "issue",
        action: "closed",
        owner: "acme",
        repository: "app",
        number: 7,
        state: "closed",
      },
    ]);
  });

  it("records nothing for a command that only read pull requests", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr view 343 --web; gh pr list",
        output: "https://github.com/acme/app/pull/343",
      }),
    ).toBeUndefined();
  });

  it("leaves a write unresolved when the output names more than one pull request", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr create --fill && gh pr view 9",
        output: "https://github.com/acme/app/pull/10\nhttps://github.com/acme/app/pull/9",
      }),
    ).toBeUndefined();
  });

  it("never completes a bare number from an unrelated repository's address", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr merge 5",
        output: "see https://github.com/acme/app/pull/6",
      }),
    ).toBeUndefined();
  });

  it("records a GitHub tool's merge from its input and a create from its result's address", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "mcp__github__merge_pull_request",
        input: { owner: "acme", repo: "app", pullNumber: 41, merge_method: "squash" },
        output: '{"merged":true,"message":"Pull Request successfully merged"}',
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "pull-request",
        action: "merged",
        owner: "acme",
        repository: "app",
        number: 41,
      },
    ]);
    expect(
      forgeReferencesFromToolCall({
        toolName: "mcp__github__create_pull_request",
        input: { owner: "acme", repo: "app", title: "Add search", head: "f", base: "main" },
        output: JSON.stringify({
          html_url: "https://github.com/acme/app/pull/44",
          title: "Add search",
          state: "open",
        }),
      }),
    ).toEqual([
      {
        forge: "github",
        kind: "pull-request",
        action: "created",
        owner: "acme",
        repository: "app",
        number: 44,
        title: "Add search",
        state: "open",
      },
    ]);
  });

  it("records nothing for a GitHub tool that only reads", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "mcp__github__pull_request_read",
        input: { owner: "acme", repo: "app", pullNumber: 41 },
        output: '{"html_url":"https://github.com/acme/app/pull/41"}',
      }),
    ).toBeUndefined();
  });

  it("records a Linear issue a tool saved, with its key, title and state", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "mcp__Linear__save_issue",
        input: { id: "ENG-991", state: "In Progress" },
        output: JSON.stringify({
          id: "uuid",
          identifier: "ENG-991",
          title: "Hover card",
          status: "In Progress",
        }),
      }),
    ).toEqual([
      {
        forge: "linear",
        kind: "issue",
        action: "edited",
        identifier: "ENG-991",
        title: "Hover card",
        state: "In Progress",
      },
    ]);
    expect(
      forgeReferencesFromToolCall({
        toolName: "mcp__Linear__list_issues",
        output: JSON.stringify({ issues: [{ identifier: "ENG-1" }] }),
      }),
    ).toBeUndefined();
  });

  it("keeps a Linear issue's address only when it is that issue's own page", () => {
    const saved = (url: string) =>
      forgeReferencesFromToolCall({
        toolName: "mcp__Linear__save_issue",
        input: { title: "New" },
        output: JSON.stringify({ identifier: "ENG-7", url }),
      });
    expect(saved("https://linear.app/ogard/issue/ENG-7/new")).toEqual([
      {
        forge: "linear",
        kind: "issue",
        action: "created",
        identifier: "ENG-7",
        url: "https://linear.app/ogard/issue/ENG-7/new",
      },
    ]);
    expect(saved("https://linear.app/ogard/issue/ENG-8/other")?.[0]).not.toHaveProperty("url");
  });

  it("keeps one reference per pull request and at most ten per call", () => {
    const command = Array.from(
      { length: 12 },
      (_, index) => `gh pr close ${String(index + 1)} -R acme/app`,
    ).join(" && ");
    const references = forgeReferencesFromToolCall({
      toolName: "Bash",
      command: `${command} && gh pr close 1 -R acme/app`,
    });
    expect(references).toHaveLength(10);
    expect(
      new Set(references?.map((reference) => ("number" in reference ? reference.number : 0))).size,
    ).toBe(10);
  });
});
