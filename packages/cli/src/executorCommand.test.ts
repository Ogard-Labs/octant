import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { HEADLESS_ARTIFACT_MANIFEST_FILENAME } from "@octant/host-runtime";
import { executorStartCommand, isExecutorStdioInvocation } from "./executorCommand";

describe("octant executor", () => {
  it("runs an installed artifact's own executor with the root it verifies and the version it reports", () => {
    const root = mkdtempSync(join(tmpdir(), "octant-executor-artifact-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(
        join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
        JSON.stringify({ artifactVersion: "1.4.0" }),
      );
      const command = executorStartCommand(
        pathToFileURL(join(root, "bin", "octant")).href,
        "/usr/local/bin/bun",
      );
      expect(command).toEqual({
        command: "/usr/local/bin/bun",
        args: [join(root, "lib", "server", "sshTarget", "executorMain.mjs")],
        env: { OCTANT_ARTIFACT_ROOT: root, OCTANT_ARTIFACT_VERSION: "1.4.0" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers only on standard streams, so it accepts no other invocation", () => {
    expect(isExecutorStdioInvocation(["--stdio"])).toBe(true);
    expect(isExecutorStdioInvocation([])).toBe(false);
    expect(isExecutorStdioInvocation(["--stdio", "--listen"])).toBe(false);
  });
});
