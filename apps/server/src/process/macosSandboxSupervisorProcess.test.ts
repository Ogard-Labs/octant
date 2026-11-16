import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function heartbeat(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe.skipIf(process.platform !== "darwin")("native sandbox scope supervisor", () => {
  it("preserves stdio and cwd, revokes detached descendants after client death and recovers its receipt", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-supervisor-")));
    chmodSync(root, 0o700);
    const executable = join(root, "scope");
    const beat = join(root, "heartbeat");
    const script = join(root, "work.py");
    const epoch = "native-test:epoch";
    let child: ReturnType<typeof spawn> | undefined;
    try {
      execFileSync(
        "/usr/bin/xcrun",
        [
          "clang",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wl,-sectcreate,__RESTRICT,__restrict,/dev/null",
          "-o",
          executable,
          fileURLToPath(
            new URL(
              "../../../desktop/native/sandbox-scope/OctantSandboxScope.c",
              import.meta.url,
            ),
          ),
        ],
        { timeout: 20000 },
      );
      writeFileSync(
        script,
        `import os, sys, time, signal
signal.alarm(15)
print("cwd=" + os.getcwd(), flush=True)
print("input=" + sys.stdin.readline().strip(), flush=True)
if os.fork() == 0:
 os.setsid()
 for i in range(600):
  with open("${beat}", "w") as f: f.write(str(i))
  time.sleep(.02)
 os._exit(0)
time.sleep(12)
`,
      );
      child = spawn(
        executable,
        [
          "--run",
          root,
          epoch,
          "--",
          "/usr/bin/sandbox-exec",
          "-p",
          "(version 1)(allow default)",
          "/usr/bin/python3",
          script,
        ],
        { cwd: root },
      );
      let stdout = "",
        stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdin?.end("host input\n");
      const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      await expect.poll(() => heartbeat(beat), { timeout: 12000 }).not.toBe("");
      expect(stdout, stderr).toContain(`cwd=${root}`);
      expect(stdout).toContain("input=host input");
      expect(readdirSync(root).some((name) => name.endsWith(".scope"))).toBe(true);
      child.kill("SIGKILL");
      await exited;
      // The launchd supervisor notices EOF independently of its dead client.
      await expect
        .poll(
          () => {
            const before = heartbeat(beat);
            return new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(heartbeat(beat) === before), 100),
            );
          },
          { timeout: 6000 },
        )
        .toBe(true);
      execFileSync(executable, ["--reap", root, epoch], { timeout: 10000 });
      expect(readdirSync(root).some((name) => name.endsWith(".scope"))).toBe(false);
      const after = heartbeat(beat);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(heartbeat(beat)).toBe(after);
    } finally {
      child?.kill("SIGKILL");
      if (existsSync(executable)) {
        try {
          execFileSync(executable, ["--reap", root, epoch], { timeout: 10000 });
        } catch {
          /* Preserve test failure; native payload has a finite lifetime. */
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
