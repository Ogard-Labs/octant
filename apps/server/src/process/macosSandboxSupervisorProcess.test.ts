import { execFileSync, spawn, spawnSync } from "node:child_process";
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
          "-DOCTANT_SCOPE_TRACE",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wl,-sectcreate,__RESTRICT,__restrict,/dev/null",
          "-o",
          executable,
          fileURLToPath(
            new URL("../../../desktop/native/sandbox-scope/OctantSandboxScope.c", import.meta.url),
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
      const normal = spawnSync(
        executable,
        [
          "--run",
          root,
          epoch,
          "--",
          "/usr/bin/sandbox-exec",
          "-p",
          "(version 1)(allow default)",
          "/bin/sh",
          "-c",
          "printf completed; exit 7",
        ],
        { cwd: root, encoding: "utf8", timeout: 10000 },
      );
      expect(normal.status, normal.stderr).toBe(7);
      expect(normal.stdout).toBe("completed");
      expect(readdirSync(root).some((name) => name.endsWith(".scope"))).toBe(false);

      const librarySource = join(root, "loader.c");
      const library = join(root, "loader.dylib");
      const payloadSource = join(root, "payload.c");
      const payload = join(root, "payload");
      const canary = join(root, "outside-profile");
      writeFileSync(
        librarySource,
        `#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void injected(void) {
 const char *path=getenv("OCTANT_SCOPE_LOADER_CANARY");
 if(path){int fd=open(path,O_WRONLY|O_CREAT,0600);if(fd>=0){write(fd,"escaped",7);close(fd);}}
}`,
      );
      writeFileSync(payloadSource, "int main(void) { return 0; }\n");
      execFileSync(
        "/usr/bin/xcrun",
        ["clang", "-Wall", "-Wextra", "-Werror", "-dynamiclib", "-o", library, librarySource],
        { timeout: 15000 },
      );
      execFileSync(
        "/usr/bin/xcrun",
        ["clang", "-Wall", "-Wextra", "-Werror", "-o", payload, payloadSource],
        { timeout: 15000 },
      );
      const loaderEnvironment = {
        ...process.env,
        DYLD_INSERT_LIBRARIES: library,
        OCTANT_SCOPE_LOADER_CANARY: canary,
      };
      const control = spawnSync(payload, [], { cwd: root, env: loaderEnvironment, timeout: 5000 });
      expect(control.status).toBe(0);
      expect(existsSync(canary)).toBe(true);
      rmSync(canary);
      const loader = spawnSync(
        executable,
        [
          "--run",
          root,
          "loader:epoch",
          "--",
          "/usr/bin/sandbox-exec",
          "-p",
          `(version 1)(allow default)(deny file-write* (literal "${canary}"))`,
          payload,
        ],
        {
          cwd: root,
          timeout: 10000,
          encoding: "utf8",
          env: loaderEnvironment,
        },
      );
      expect(loader.status, loader.stderr).toBe(0);
      expect(existsSync(canary)).toBe(false);

      const previous = heartbeat(beat);
      const hostScript = `const {spawn}=require("node:child_process"); const fs=require("node:fs");
const child=spawn(process.argv[1],["--run",process.argv[2],"host-death:epoch","--","/usr/bin/sandbox-exec","-p","(version 1)(allow default)","/usr/bin/python3",process.argv[3]],{cwd:process.argv[2],stdio:"ignore"});
const deadline=setTimeout(()=>{child.kill("SIGKILL");process.exit(2)},12000);
const timer=setInterval(()=>{try {if(fs.readFileSync(process.argv[4],"utf8")!==process.argv[5]){clearTimeout(deadline);clearInterval(timer);process.exit(0)}}catch{}},20);`;
      const host = spawn(
        process.execPath,
        ["-e", hostScript, executable, root, script, beat, previous],
        { stdio: "ignore" },
      );
      const hostExit = await new Promise<number | null>((resolve) => host.once("exit", resolve));
      expect(hostExit).toBe(0);
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
      execFileSync(executable, ["--reap", root, "--stale"], { timeout: 10000 });
      expect(readdirSync(root).some((name) => name.endsWith(".scope"))).toBe(false);

      const terminal = spawnSync(
        "/usr/bin/python3",
        [
          "-c",
          `import os, pty, signal
signal.alarm(20)
args=["${executable}","--run","${root}","terminal:epoch","--","/usr/bin/sandbox-exec","-p","(version 1)(allow default)","/bin/sh","-c","test -t 0 && test -t 1 && test -t 2 && printf terminal-ready"]
status=pty.spawn(args)
raise SystemExit(os.waitstatus_to_exitcode(status))
`,
        ],
        { encoding: "utf8", timeout: 22000 },
      );
      expect(
        terminal.status,
        JSON.stringify({
          stdout: terminal.stdout,
          stderr: terminal.stderr,
          signal: terminal.signal,
          error: terminal.error?.message,
        }),
      ).toBe(0);
      expect(terminal.stdout).toContain("terminal-ready");
    } finally {
      child?.kill("SIGKILL");
      if (existsSync(executable)) {
        for (const ownedEpoch of [epoch, "host-death:epoch", "terminal:epoch", "loader:epoch"]) {
          try {
            execFileSync(executable, ["--reap", root, ownedEpoch], { timeout: 10000 });
          } catch {
            /* Preserve test failure; native payload has a finite lifetime. */
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
