import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it.skipIf(process.platform === "win32")(
  "renders terminal breakpoints and dispatches a palette command through keyboard input",
  () => {
    const output = execFileSync("bun", ["scripts/smoke-terminal-client.ts"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30000,
    });
    expect(output).toContain("Rendered 80x24");
    expect(output).toContain("Rendered 160x24");
  },
  35000,
);
