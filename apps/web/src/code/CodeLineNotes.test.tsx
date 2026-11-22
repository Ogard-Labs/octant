import { describe, expect, it } from "vitest";
import { lineNotesMessage } from "./CodeLineNotes";

describe("lineNotesMessage", () => {
  it("escapes newlines in note paths so multiline filenames do not split note headers", () => {
    const message = lineNotesMessage([
      {
        id: "n-1",
        path: "dir/first\n2. fake.ts\r\nline.ts",
        side: "modified",
        startLine: 4,
        endLine: 4,
        excerpt: "const x = 1;",
        text: "Rename this file",
      },
    ]);

    expect(message).toBe(
      [
        "Notes on the changed lines:",
        "",
        "1. dir/first\\n2. fake.ts\\r\\nline.ts, new line 4",
        "   > const x = 1;",
        "   Rename this file",
      ].join("\n"),
    );
  });
});
