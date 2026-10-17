import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("watchDesktopParent in a real process", () => {
  it("lets the host exit on SIGTERM while the desktop still holds its end of the pipe open", async () => {
    // spawn() gives the child an open stdin pipe the parent never closes, which
    // is how the desktop starts the host. A host that stayed alive here had shut
    // down and closed its listener but never exited, so the desktop never saw
    // the exit it restarts the host on.
    const child = spawn(
      "bun",
      [fileURLToPath(new URL("./desktopParentWatch.integration-fixture.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const exited = new Promise<"exited">((resolve) => child.once("exit", () => resolve("exited")));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      const outcome = await Promise.race([
        exited,
        new Promise<"still running">((resolve) =>
          setTimeout(() => resolve("still running"), 5_000),
        ),
      ]);
      expect(outcome).toBe("exited");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
