import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { deferredProxyEnvironment, DEFERRED_PROXY_SOURCE } from "./deferredProxyEnvironment";

describe("confined proxy environment promotion", () => {
  it("keeps proxy values and recipient arguments out of the fixed split recipe", () => {
    const args = ["literal spaces", "$(never-evaluate)", "--name=value"];
    const launch = deferredProxyEnvironment("/usr/bin/recipient", args);
    expect(launch.command).toBe("/usr/bin/env");
    expect(launch.args.slice(-4)).toEqual(["/usr/bin/recipient", ...args]);
    expect(launch.args[1]).toContain("${OCTANT_COMMAND_PROXY_URL}");
    expect(launch.args[1]).not.toContain("never-evaluate");
    expect(launch.args).toContain("-u");
  });
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "uses native env substitution without resplitting values and removes the private source before the recipient",
    () => {
      const value = "http://octant:synthetic_$(not-a-command) token@127.0.0.1:1";
      const launch = deferredProxyEnvironment("/bin/sh", [
        "-c",
        'test "$HTTP_PROXY" = "$EXPECTED_PROXY" && test "$https_proxy" = "$EXPECTED_PROXY" && test "$ALL_PROXY" = "$EXPECTED_PROXY" && test "${OCTANT_COMMAND_PROXY_URL+x}" != x && test "$NODE_USE_ENV_PROXY" = 1 && test -z "$NO_PROXY"',
      ]);
      const result = spawnSync(launch.command, [...launch.args], {
        env: { PATH: "/usr/bin:/bin", [DEFERRED_PROXY_SOURCE]: value, EXPECTED_PROXY: value },
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 4096,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    },
  );
});
