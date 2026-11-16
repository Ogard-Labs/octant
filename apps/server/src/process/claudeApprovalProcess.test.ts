import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function nativeClaude(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const metadata = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const executable = join(dirname(metadata), "claude");
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}
const executable = nativeClaude();
const fixture = fileURLToPath(
  new URL("../providers/fixtures/nativeClaudeApproval.mjs", import.meta.url),
);

describe.skipIf(process.platform === "win32" || executable === undefined)(
  "native Claude approval dispatch with an offline model fixture",
  () => {
    it.each(["bypassPermissions", "auto"])(
      "keeps a hook-mandated ask at %s per command, refusing one and allowing exactly the answered command",
      (mode) => {
        const result = spawnSync(process.execPath, [fixture, executable ?? "", mode], {
          encoding: "utf8",
          timeout: 30000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          hookCalls: 2,
          permissionCalls: 2,
          commandWrites: "x",
          result: { subtype: "success", is_error: false },
        });
      },
      35000,
    );

    it("proves Full access would run both commands without the hook before consulting the callback", () => {
      const result = spawnSync(
        process.execPath,
        [fixture, executable ?? "", "bypassPermissions", "no-hook"],
        { encoding: "utf8", timeout: 30000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        hookCalls: 0,
        permissionCalls: 0,
        commandWrites: "xx",
      });
    }, 35000);
    it.skipIf(process.platform !== "linux")(
      "refuses missing native sandbox prerequisites before model or tool execution, with a matching unrestricted control",
      () => {
        const control = spawnSync(
          process.execPath,
          [fixture, executable ?? "", "bypassPermissions", "no-hook-empty-path"],
          { encoding: "utf8", timeout: 30000 },
        );
        expect(control.status, control.stderr).toBe(0);
        expect(JSON.parse(control.stdout.trim())).toMatchObject({ commandWrites: "xx" });
        const protectedRun = spawnSync(
          process.execPath,
          [fixture, executable ?? "", "bypassPermissions", "missing-sandbox"],
          { encoding: "utf8", timeout: 30000 },
        );
        expect(protectedRun.status, protectedRun.stderr).toBe(0);
        expect(JSON.parse(protectedRun.stdout.trim())).toMatchObject({
          calls: 0,
          hookCalls: 0,
          permissionCalls: 0,
          commandWrites: "",
          result: { subtype: "error_during_execution" },
        });
      },
      65000,
    );
  },
);
