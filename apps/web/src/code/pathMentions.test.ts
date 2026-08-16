import { describe, expect, it } from "vitest";
import {
  applyPathMention,
  rankPathMentionCandidates,
  readPathMentionQuery,
  type PathMentionCandidate,
} from "./pathMentions";

const CANDIDATES: ReadonlyArray<PathMentionCandidate> = [
  { kind: "directory", path: "src" },
  { kind: "file", path: "src/code/useCodeController.tsx" },
  { kind: "file", path: "src/code/CodeDiffPane.tsx" },
  { kind: "file", path: "README.md" },
];

describe("readPathMentionQuery", () => {
  it("opens on `@` at a word boundary and closes at whitespace", () => {
    expect(readPathMentionQuery("look at @src/co", 15)).toEqual({ start: 8, query: "src/co" });
    expect(readPathMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(readPathMentionQuery("@src/co and then", 16)).toBeUndefined();
  });

  it("leaves an address or a decorator as ordinary text", () => {
    expect(readPathMentionQuery("mail henrik@ogard.no", 20)).toBeUndefined();
    expect(readPathMentionQuery("nothing here", 12)).toBeUndefined();
  });
});

describe("rankPathMentionCandidates", () => {
  it("puts a file-name match ahead of a match deeper in the path", () => {
    expect(rankPathMentionCandidates(CANDIDATES, "code").map((entry) => entry.path)).toEqual([
      "src/code/CodeDiffPane.tsx",
      "src/code/useCodeController.tsx",
    ]);
  });

  it("matches case-insensitively and honours the limit", () => {
    expect(rankPathMentionCandidates(CANDIDATES, "READ").map((entry) => entry.path)).toEqual([
      "README.md",
    ]);
    expect(rankPathMentionCandidates(CANDIDATES, "", 2)).toHaveLength(2);
  });

  it("offers nothing for a query no path contains", () => {
    expect(rankPathMentionCandidates(CANDIDATES, "nowhere")).toEqual([]);
  });
});

describe("applyPathMention", () => {
  it("replaces the open token with the chosen file and a trailing space", () => {
    const draft = "look at @src/co please";
    const mention = readPathMentionQuery(draft, 15);
    expect(mention).toBeDefined();
    expect(applyPathMention(draft, mention!, CANDIDATES[2]!)).toEqual({
      draft: "look at @src/code/CodeDiffPane.tsx please",
      caret: 34,
    });
  });

  it("keeps a directory open so the user can keep typing into it", () => {
    const applied = applyPathMention("@sr", { start: 0, query: "sr" }, CANDIDATES[0]!);
    expect(applied.draft).toBe("@src/");
    expect(applied.caret).toBe(5);
  });
});
