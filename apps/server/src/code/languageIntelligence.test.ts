import { describe, expect, it } from "vitest";
import { intelligenceItems } from "./languageIntelligence";
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
describe("language intelligence boundary", () => {
  it("omits completions that would require commands or edits elsewhere", () => {
    expect(
      intelligenceItems(
        "completion",
        [
          { label: "safe", insertText: "value", textEdit: { range, newText: "safe" } },
          { label: "execute", command: { command: "run" } },
          { label: "import", additionalTextEdits: [] },
        ],
        "/repo",
      ),
    ).toEqual({
      items: [expect.objectContaining({ label: "safe", text: "safe", range })],
      truncated: true,
    });
  });
  it("flattens bounded symbols and refuses invalid formatting ranges without accepting partial formatting", () => {
    expect(
      intelligenceItems(
        "symbols",
        [{ name: "outer", kind: 12, range, children: [{ name: "inner", kind: 13, range }] }],
        "/repo",
      ).items.map((item) => item.label),
    ).toEqual(["outer", "inner"]);
    expect(
      intelligenceItems(
        "formatting",
        [
          { range, newText: "ok" },
          {
            range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } },
            newText: "invalid",
          },
        ],
        "/repo",
      ),
    ).toMatchObject({ items: [{ text: "ok" }], truncated: true });
  });
});
