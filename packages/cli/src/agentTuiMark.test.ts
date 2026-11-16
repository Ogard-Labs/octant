import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { terminalMarkFromSprite } from "../../../scripts/generate-terminal-mark";
import { agentTuiMark } from "./agentTuiMark";
it("keeps the generated terminal mark in sync with the sheared brand geometry", async () => {
  const svg = await readFile(
    new URL("../../../apps/web/public/icons.svg", import.meta.url),
    "utf8",
  );
  expect(terminalMarkFromSprite(svg)).toBe(agentTuiMark);
});
