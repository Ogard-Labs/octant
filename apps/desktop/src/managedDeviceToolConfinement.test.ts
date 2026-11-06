import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confineManagedDeviceTool } from "./managedDeviceToolConfinement";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-device-boundary-")));
  roots.push(root);
  const home = join(root, "home");
  const state = join(root, "state");
  const tool = join(root, "tool", "dist");
  const android = join(home, ".android");
  for (const path of [state, tool, android]) mkdirSync(path, { recursive: true });
  return { root, home, state, tool, android };
}

describe("managed device tool confinement", () => {
  it("refuses a configured SDK that grants the whole home", () => {
    const f = fixture();
    expect(
      confineManagedDeviceTool({
        tool: "serve-avd",
        runtime: "/usr/bin/node",
        entrypoint: join(f.tool, "serve-avd.js"),
        args: [],
        stateDirectory: f.state,
        environment: { HOME: f.home, ANDROID_HOME: f.home },
        platform: "darwin",
      }),
    ).toBeUndefined();
  });

  it("does not fall back to an unconfined process on an unsupported host", () => {
    const f = fixture();
    expect(
      confineManagedDeviceTool({
        tool: "serve-avd",
        runtime: "/usr/bin/node",
        entrypoint: join(f.tool, "serve-avd.js"),
        args: [],
        stateDirectory: f.state,
        environment: { HOME: f.home },
        platform: "win32",
      }),
    ).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")(
    "lets the OS preserve device authentication and private state while refusing unrelated files and writes",
    () => {
      const f = fixture();
      const privateFile = join(f.home, "private.txt");
      const authentication = join(f.android, "adbkey");
      const consoleAuthentication = join(f.home, ".emulator_console_auth_token");
      const stateFile = join(f.state, "stream.json");
      writeFileSync(privateFile, "private fixture\n");
      writeFileSync(authentication, "synthetic device identity\n");
      writeFileSync(consoleAuthentication, "synthetic console identity\n");
      const entrypoint = join(f.tool, "probe.sh");
      writeFileSync(
        entrypoint,
        [
          "#!/bin/sh",
          'if cat "$1" >/dev/null 2>&1; then echo private=read; else echo private=refused; fi',
          'if cat "$2" >/dev/null 2>&1; then echo device=read; else echo device=refused; fi',
          'if (echo state > "$3") 2>/dev/null; then echo state=written; else echo state=refused; fi',
          'if (echo overwrite > "$1") 2>/dev/null; then echo private=written; else echo write=refused; fi',
          'if cat "$4" >/dev/null 2>&1; then echo console=read; else echo console=refused; fi',
        ].join("\n"),
      );
      const spec = confineManagedDeviceTool({
        tool: "serve-avd",
        runtime: "/bin/sh",
        entrypoint,
        args: [privateFile, authentication, stateFile, consoleAuthentication],
        stateDirectory: f.state,
        environment: { HOME: f.home, PATH: "/usr/bin:/bin" },
      });
      expect(spec).toBeDefined();
      if (spec === undefined) return;
      const output = execFileSync(spec.command, [...spec.args], {
        env: spec.env,
        cwd: spec.cwd,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(output).toContain("private=refused");
      expect(output).toContain("device=read");
      expect(output).toContain("console=read");
      expect(output).toContain("state=written");
      expect(output).toContain("write=refused");
    },
  );
});
