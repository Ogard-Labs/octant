import { describe, expect, it } from "vitest";
import { providerApprovalCall } from "./providerApprovalCall";

describe("complete owner file approval facts", () => {
  it("keeps the entire write and edit, independently of the automatic review summary", () => {
    const input = { file_path: "/fixture/note.txt", content: "line one\nline two" };
    const call = providerApprovalCall({ tool: "Write", arguments: input });
    expect(call?.ownerAction).toEqual({
      kind: "file-write",
      tool: "Write",
      input: JSON.stringify(input),
    });
    expect(call?.input).not.toContain("line one");
    expect(
      providerApprovalCall({
        tool: "Edit",
        arguments: {
          file_path: "/fixture/note.txt",
          old_string: "one",
          new_string: "two",
          replace_all: true,
        },
      })?.ownerAction?.kind,
    ).toBe("file-edit");
  });
  it("keeps complete Shell facts only with an explicitly attested runtime directory", () => {
    const input = { command: "printf 'fixture\\n'", timeout: 1000, description: "Print fixture" };
    expect(
      providerApprovalCall({
        tool: "Bash",
        arguments: input,
        workingDirectory: "/fixture",
        ownerShell: true,
      })?.ownerAction,
    ).toEqual({
      kind: "shell",
      tool: "Bash",
      input: JSON.stringify(input),
      workingDirectory: "/fixture",
    });
    for (const entry of [
      { tool: "Bash", arguments: input, workingDirectory: "/fixture" },
      { tool: "Bash", arguments: input, ownerShell: true },
      { tool: "Bash", arguments: input, workingDirectory: "relative", ownerShell: true },
      ...[
        { command: "pwd", run_in_background: true },
        { command: "pwd", dangerouslyDisableSandbox: true },
        { command: "pwd", cwd: "/other" },
        { command: "pwd", extra: true },
        { command: "echo api_key=private-fixture" },
        { command: "界".repeat(23_000) },
      ].map((arguments_) => ({
        tool: "Bash",
        arguments: arguments_,
        workingDirectory: "/fixture",
        ownerShell: true,
      })),
    ])
      expect(providerApprovalCall(entry)?.ownerAction).toBeUndefined();
  });
  it("refuses unknown, unattested shell, extra effect fields, secrets and UTF-8 overflow rather than claiming partial consent", () => {
    for (const [tool, input] of [
      ["Bash", { command: "pwd" }],
      ["mcp__files__write", { file_path: "/fixture/a", content: "ok" }],
      ["Write", { file_path: "/fixture/a", content: "ok", extra: true }],
      ["Write", { file_path: "/fixture/a", content: "api_key=synthetic-private-value" }],
      ["Write", { file_path: "/fixture/a", content: "界".repeat(23_000) }],
    ] as const)
      expect(providerApprovalCall({ tool, arguments: input })?.ownerAction).toBeUndefined();
  });
});
