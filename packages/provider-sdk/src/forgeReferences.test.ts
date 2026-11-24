import { ThreadForgeReference } from "@octant/contracts";
import { Schema } from "effect";
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

  it("keeps an issue's last reported state when one call writes to it more than once", () => {
    const states = (command: string) =>
      forgeReferencesFromToolCall({ toolName: "Bash", command })?.map((reference) => ({
        key: "number" in reference ? reference.number : reference.identifier,
        state: reference.state,
      }));
    expect(
      states("gh issue comment 7 -R acme/app --body Fixed && gh issue close 7 -R acme/app"),
    ).toEqual([{ key: 7, state: "closed" }]);
    expect(states("gh issue close 7 -R acme/app && gh issue reopen 7 -R acme/app")).toEqual([
      { key: 7, state: "open" },
    ]);
    expect(
      states("gh issue close 7 -R acme/app && gh issue comment 7 -R acme/app --body Done"),
    ).toEqual([{ key: 7, state: "closed" }]);
  });

  it("credits the last command after a semicolon to the call's exit status, and no earlier one", () => {
    const numbers = (command: string, output?: string) =>
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command,
        ...(output === undefined ? {} : { output }),
      })?.map((reference) => ("number" in reference ? reference.number : 0));
    expect(numbers("git status --short; gh pr ready 12 -R acme/app")).toEqual([12]);
    expect(numbers("cd app\ngh pr ready 12 -R acme/app 2>&1")).toEqual([12]);
    expect(numbers("gh pr close 11 -R acme/app; gh pr ready 12 -R acme/app")).toEqual([12]);
    // The exit status belongs to the last command of a pipeline or a fallback.
    expect(numbers("true; gh pr close 11 -R acme/app || true")).toBeUndefined();
    expect(numbers("gh pr close 11 -R acme/app | cat")).toBeUndefined();
    expect(numbers("gh pr close 11 -R acme/app & true")).toBeUndefined();
    expect(numbers("true; # gh pr close 11 -R acme/app")).toBeUndefined();
  });

  it("credits a readiness change from gh's own line, and not a refused merge's", () => {
    const numbers = (command: string, output: string) =>
      forgeReferencesFromToolCall({ toolName: "Bash", command, output })?.map((reference) =>
        "number" in reference ? reference.number : 0,
      );
    expect(
      numbers(
        "gh pr ready 12; git status",
        '\u2713 Pull request acme/app#12 is marked as "ready for review"',
      ),
    ).toEqual([12]);
    expect(
      numbers(
        "gh pr merge 12 --squash || true",
        "X Pull request acme/app#12 is not mergeable: the base branch policy prohibits the merge.",
      ),
    ).toBeUndefined();
  });

  it("reads a target after a subcommand's switch, and never takes an option's number for it", () => {
    const numbers = (command: string) =>
      forgeReferencesFromToolCall({ toolName: "Bash", command })?.map((reference) =>
        "number" in reference ? reference.number : 0,
      );
    expect(numbers("gh pr review -a 12 -R acme/app && gh pr view 12 -R acme/app")).toEqual([12]);
    expect(numbers("gh pr review --comment 12 -R acme/app -b ok && gh pr list")).toEqual([12]);
    expect(numbers("gh pr merge -m 12 -R acme/app && gh pr list")).toEqual([12]);
    expect(numbers("gh issue close --comment 44 7 -R acme/app")).toEqual([7]);
    expect(numbers("gh issue close --duplicate-of 9 7 -R acme/app")).toEqual([7]);
    expect(numbers("gh issue edit --add-sub-issue 9 7 -R acme/app")).toEqual([7]);
  });

  it("reads a command continued over lines and text with escaped quotes as one command", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command:
          'gh pr comment 12 \\\n  --body "He said \\"see https://github.com/acme/app/pull/44\\"" \\\n  -R acme/app',
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

  it("bounds a title and state to what the journal accepts in bytes, so a long one never loses the call", () => {
    const [reference] =
      forgeReferencesFromToolCall({
        toolName: "mcp__github__create_issue",
        input: { owner: "acme", repo: "app" },
        output: JSON.stringify({
          html_url: "https://github.com/acme/app/issues/7",
          title: "\u6f22".repeat(200),
          state: "\u72b6\u614b ".repeat(20),
        }),
      }) ?? [];
    expect(reference).toBeDefined();
    expect(() => Schema.decodeUnknownSync(ThreadForgeReference)(reference)).not.toThrow();
    expect(reference?.title).toBe("\u6f22".repeat(85));
  });

  it("keeps a connecting operator's effect across the line break after it", () => {
    const numbers = (command: string) =>
      forgeReferencesFromToolCall({ toolName: "Bash", command })?.map((reference) =>
        "number" in reference ? reference.number : 0,
      );
    // Closing 12 succeeded, so 13 never ran; neither exit status is known.
    expect(numbers("gh pr close 12 -R acme/app ||\n  gh pr close 13 -R acme/app")).toBeUndefined();
    expect(numbers("gh pr view 12 |\n\n gh pr close 13 -R acme/app")).toBeUndefined();
    expect(numbers("gh pr close 12 -R acme/app &&\n  gh pr close 13 -R acme/app")).toEqual([
      12, 13,
    ]);
  });

  it("confirms a write only by a line that says what that write does", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh issue close 7 -R acme/app || gh issue reopen 7 -R acme/app",
        output: "\u2713 Closed issue acme/app#7 (Docs)",
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
    // A comment prints its own anchor; the address a fallback view prints is not one.
    const commented = (output: string) =>
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr comment 12 -R acme/app --body x || gh pr view 12 -R acme/app",
        output,
      });
    expect(commented("https://github.com/acme/app/pull/12")).toBeUndefined();
    expect(commented("https://github.com/acme/app/pull/12#issuecomment-9")).toHaveLength(1);
  });

  it("does not credit the exit status to a write that an earlier exit may have skipped", () => {
    const numbers = (command: string) =>
      forgeReferencesFromToolCall({ toolName: "Bash", command })?.map((reference) =>
        "number" in reference ? reference.number : 0,
      );
    expect(
      numbers("if merged; then echo done; exit 0; fi; gh pr edit 12 -R acme/app --title New"),
    ).toBeUndefined();
    expect(numbers("merged && exit; gh pr edit 12 -R acme/app --title New")).toBeUndefined();
    // A failing exit would have failed the call.
    expect(numbers("cd app || exit 1; gh pr edit 12 -R acme/app --title New")).toEqual([12]);
  });

  it("leaves out an identity the journal would refuse, so it never loses the call", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "Bash",
        command: "gh pr close 5 -R acme/.. && gh pr close 6 -R acme/app",
      })?.map((reference) => ("number" in reference ? reference.number : 0)),
    ).toEqual([6]);
    expect(
      forgeReferencesFromToolCall({
        toolName: "mcp__github__create_pull_request",
        input: {},
        output: '{"html_url":"https://github.com/acme/../pull/5"}',
      }),
    ).toBeUndefined();
  });

  it("records a merge left to GitHub as an edit, since nothing merged yet", () => {
    const action = (command: string) =>
      forgeReferencesFromToolCall({ toolName: "Bash", command })?.[0]?.action;
    expect(action("gh pr merge 12 --auto --squash -R acme/app")).toBe("edited");
    expect(action("gh pr merge 12 --disable-auto -R acme/app")).toBe("edited");
    expect(action("gh pr merge 12 --squash -R acme/app")).toBe("merged");
  });

  it("reads gh only where a command starts, not as another command's text", () => {
    const numbers = (command: string) =>
      forgeReferencesFromToolCall({ toolName: "Bash", command })?.map((reference) =>
        "number" in reference ? reference.number : 0,
      );
    expect(numbers("echo gh pr merge 12 -R acme/app")).toBeUndefined();
    expect(numbers("grep -rn gh pr close 12 -R acme/app docs")).toBeUndefined();
    expect(numbers("! gh pr close 12 -R acme/app")).toBeUndefined();
    expect(numbers("GH_TOKEN=x gh pr close 12 -R acme/app")).toEqual([12]);
    expect(numbers("timeout 60 /opt/homebrew/bin/gh pr close 12 -R acme/app")).toEqual([12]);
    expect(numbers("env GH_PAGER= command gh pr close 12 -R acme/app")).toEqual([12]);
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

  it("records a Linear issue whose result gives its key as the id, whatever other issues it cites", () => {
    expect(
      forgeReferencesFromToolCall({
        toolName: "mcp__Linear__save_issue",
        input: { id: "ENG-991", state: "Done" },
        output: JSON.stringify({
          id: "ENG-991",
          uuid: "32c2b6df-5344-4aab-b419-e51e6a7c8036",
          title: "Hover card",
          description: "Related: https://linear.app/ogard/issue/ENG-5/other",
          url: "https://linear.app/ogard/issue/ENG-991/hover-card",
          status: "Done",
        }),
      }),
    ).toEqual([
      {
        forge: "linear",
        kind: "issue",
        action: "edited",
        identifier: "ENG-991",
        url: "https://linear.app/ogard/issue/ENG-991/hover-card",
        title: "Hover card",
        state: "Done",
      },
    ]);
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
