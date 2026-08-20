import { describe, expect, it } from "vitest";
import {
  MAX_FILE_MENTIONS_PER_TURN,
  decodeFileMentionCommand,
  decodeFileMentionPath,
} from "./fileMention";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const threadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const checkoutId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("file mention contracts", () => {
  it("decodes a confined relative path and rejects parent traversal", () => {
    expect(decodeFileMentionPath("src/index.ts")).toBe("src/index.ts");
    expect(() => decodeFileMentionPath("../secret")).toThrow();
    expect(() => decodeFileMentionPath("/etc/passwd")).toThrow();
  });

  it("decodes a Code complete command and a Work resolve command", () => {
    expect(
      decodeFileMentionCommand({
        kind: "complete-file-mentions",
        requestId,
        scope: { mode: "code", threadId, checkoutId },
        query: "src",
      }),
    ).toMatchObject({ kind: "complete-file-mentions", query: "src" });

    expect(
      decodeFileMentionCommand({
        kind: "resolve-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        paths: ["notes.md"],
      }),
    ).toMatchObject({ kind: "resolve-file-mentions", paths: ["notes.md"] });
  });

  it("has no Chat scope, because Chat Projects have no filesystem authority", () => {
    expect(() =>
      decodeFileMentionCommand({
        kind: "complete-file-mentions",
        requestId,
        scope: { mode: "chat", threadId },
        query: "src",
      }),
    ).toThrow();
  });

  it("preserves leading and trailing spaces in a named path", () => {
    expect(
      decodeFileMentionCommand({
        kind: "resolve-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        paths: [" notes.md", "notes.md "],
      }),
    ).toMatchObject({
      kind: "resolve-file-mentions",
      paths: [" notes.md", "notes.md "],
    });
  });

  it("rejects more paths than a turn may carry", () => {
    expect(() =>
      decodeFileMentionCommand({
        kind: "resolve-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        paths: Array.from({ length: MAX_FILE_MENTIONS_PER_TURN + 1 }, (_, index) => `f${index}.md`),
      }),
    ).toThrow();
  });
});
