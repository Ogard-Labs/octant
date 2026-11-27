import { toRegExpDetails } from "oniguruma-to-es";
import { describe, expect, it } from "vitest";
import {
  HIGHLIGHTED_GRAMMARS,
  MAX_HIGHLIGHTED_CHARACTERS,
  grammarForFence,
  grammarForPath,
  highlightCode,
} from "./codeHighlight";

function patternsOf(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) patternsOf(item, into);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (["match", "begin", "end", "while"].includes(key) && typeof value === "string") {
        into.add(value);
      } else {
        patternsOf(value, into);
      }
    }
  }
  return into;
}

describe("code highlighting", () => {
  it("colours a TypeScript fence, keeping every character of the code", async () => {
    const code = "const answer: number = 42; // the answer\nexport { answer };";
    const result = await highlightCode(code, grammarForFence("ts"), "dark");
    expect(result.status).toBe("highlighted");
    if (result.status !== "highlighted") return;
    expect(result.lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(
      code,
    );
    const colours = new Set(result.lines.flat().map((token) => token.color));
    expect(colours.size).toBeGreaterThan(2);
  });

  it("draws light and dark schemes in different colours", async () => {
    const light = await highlightCode("def f():\n    return 'x'", "python", "light");
    const dark = await highlightCode("def f():\n    return 'x'", "python", "dark");
    expect(light).not.toEqual(dark);
  });

  it("leaves code plain when no grammar is carried for its language or it is too long", async () => {
    expect(await highlightCode("main = pure ()", grammarForFence("haskell"), "light")).toEqual({
      status: "plain",
      reason: "no-grammar",
    });
    expect(
      await highlightCode("x".repeat(MAX_HIGHLIGHTED_CHARACTERS + 1), "typescript", "light"),
    ).toEqual({ status: "plain", reason: "too-long" });
  });

  it("finds a grammar from a fence tag or a changed file's name", () => {
    expect(grammarForFence("Shell")).toBe("shellscript");
    expect(grammarForFence("tsx title=App.tsx")).toBe("tsx");
    expect(grammarForPath("apps/mobile/src/App.tsx")).toBe("tsx");
    expect(grammarForPath("docker/Dockerfile")).toBe("docker");
    expect(grammarForPath(".gitignore")).toBeUndefined();
    expect(grammarForPath("README")).toBeUndefined();
  });

  // Hermes rejects the `v` flag and inline modifiers, so every pattern of
  // every carried grammar must convert to an ES2018 regex; one that does not
  // would be skipped and leave its language partly coloured.
  it("converts every pattern of every carried grammar to a regex Hermes runs", async () => {
    for (const name of HIGHLIGHTED_GRAMMARS) {
      const module = (await import(/* @vite-ignore */ `@shikijs/langs/${name}`)) as {
        default: unknown;
      };
      for (const pattern of patternsOf(module.default, new Set())) {
        const details = toRegExpDetails(pattern, {
          global: true,
          hasIndices: true,
          target: "ES2018",
          rules: { allowOrphanBackrefs: true, asciiWordBoundaries: true, captureGroup: true },
        });
        expect(details.flags, `${name}: ${pattern}`).not.toContain("v");
      }
    }
  }, 30_000);
});

describe("diff highlighting", () => {
  it("reads removed rows in the old file and added and context rows in the new", async () => {
    const { diffSides } = await import("./codeHighlight");
    const sides = diffSides([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: " /* a comment" },
      { kind: "removed", text: "-   old */" },
      { kind: "added", text: "+   new */" },
    ]);
    expect(sides.oldCode).toBe("/* a comment\n   old */");
    expect(sides.newCode).toBe("/* a comment\n   new */");
    expect(sides.rowLines).toEqual([
      null,
      { side: "new", line: 0 },
      { side: "old", line: 1 },
      { side: "new", line: 1 },
    ]);
    const coloured = await highlightCode(sides.newCode, "typescript", "dark");
    if (coloured.status !== "highlighted") throw new Error(coloured.reason);
    // The second line is still inside the comment the first opened.
    expect(coloured.lines[1]?.[0]?.color).toBe(coloured.lines[0]?.[0]?.color);
  });
});
