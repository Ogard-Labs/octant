import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "renders terminal breakpoints and dispatches palette and waiting-thread shortcuts",
  () => {
    const output = execFileSync("bun", ["scripts/smoke-terminal-client.ts"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30000,
    });
    expect(output).toContain("Rendered 80x24");
    expect(output).toContain("Rendered 160x24");
    expect(output).toContain("Rendered streaming table boundary and fenced source");
    expect(output).toContain("Rendered fenced literal table in a later streaming block");
    expect(output).toContain("Rendered draft provenance and slash-prefixed request-read refusal");
    expect(output).toContain("Rendered follow-up dismissal after commands");
    expect(output).toContain("Rendered first request-read refusal recovery");
  },
  35000,
);
