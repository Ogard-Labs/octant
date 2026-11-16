import { expect, it } from "vitest";
import { terminalMarkdownTables } from "./agentTuiMarkdown";
it("boxes table rows while preserving fenced source", () => {
  const source =
    '| File | State |\n| --- | --- |\n| a.ts | done |\n\n```ts\nconst pipe = "|";\n```';
  const rendered = terminalMarkdownTables(source);
  expect(rendered).toContain("┌");
  expect(rendered).toContain("│ a.ts");
  expect(rendered).toContain('const pipe = "|";');
  expect(rendered).not.toContain("| --- |");
});
