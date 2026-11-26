import { describe, expect, it, vi } from "vitest";
import type { GhCommandPort } from "../code/ghPullRequestPort";
import { GhIssueWritePort } from "./ghIssueWritePort";

const issue = { owner: "acme", repository: "app", number: 12 };

// A fake `gh`: each test scripts its answers, and nothing reaches GitHub.
function fakeGh(answers: Record<string, { exitCode: number; stdout: string; stderr?: string }>) {
  const run = vi.fn<GhCommandPort["run"]>(async (args) => {
    const key = args.slice(0, 2).join(" ");
    return answers[key] ?? { exitCode: 1, stdout: "", stderr: "unexpected" };
  });
  return { port: new GhIssueWritePort({ command: { run }, inheritedEnvironment: {} }), run };
}

describe("GhIssueWritePort", () => {
  it("closes an issue as completed with the issues-write capability", async () => {
    const { port, run } = fakeGh({
      "api repos/acme/app": { exitCode: 0, stdout: JSON.stringify({ triage: true }) },
      "issue close": { exitCode: 0, stdout: "" },
    });
    expect(await port.close(issue)).toEqual({ status: "applied" });
    expect(run.mock.calls.at(-1)?.[0]).toEqual([
      "issue",
      "close",
      "12",
      "--repo",
      "acme/app",
      "--reason",
      "completed",
    ]);
  });

  it("posts a comment from stdin, never as an argument", async () => {
    const { port, run } = fakeGh({
      "api repos/acme/app": { exitCode: 0, stdout: JSON.stringify({ push: true }) },
      "issue comment": { exitCode: 0, stdout: "" },
    });
    expect(await port.comment({ ...issue, body: "Merged in #9." })).toEqual({
      status: "applied",
    });
    const last = run.mock.calls.at(-1);
    expect(last?.[0]).toEqual(["issue", "comment", "12", "--repo", "acme/app", "--body-file", "-"]);
    expect(last?.[1].stdin).toBe("Merged in #9.");
  });

  it("fails closed without write access to the repository's issues", async () => {
    const { port, run } = fakeGh({
      "api repos/acme/app": {
        exitCode: 0,
        stdout: JSON.stringify({ pull: true, triage: false, push: false }),
      },
    });
    expect(await port.close(issue)).toEqual({ status: "refused", reason: "missing-capability" });
    expect(await port.comment({ ...issue, body: "x" })).toEqual({
      status: "refused",
      reason: "missing-capability",
    });
    expect(run.mock.calls.every((call) => call[0][0] === "api")).toBe(true);
  });

  it("reads whether an issue is open", async () => {
    const { port } = fakeGh({
      "issue view": { exitCode: 0, stdout: JSON.stringify({ state: "CLOSED" }) },
    });
    expect(await port.readState(issue)).toEqual({ status: "read", open: false });
  });
});
