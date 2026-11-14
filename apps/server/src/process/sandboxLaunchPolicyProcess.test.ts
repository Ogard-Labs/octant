import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { makeProcessConfinementLive, ProcessConfinementError } from "./seatbeltProfile";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-policy-native-")));
  directories.push(base);
  const project = join(base, "project");
  const shared = join(base, "shared");
  const cache = join(base, "cache");
  const scratch = join(base, "scratch");
  for (const path of [project, shared, cache, scratch]) mkdirSync(path);
  const sandboxPolicy = decodeSandboxPolicySelection({
    policy: {
      schemaVersion: 1,
      revision: 1,
      filesystem: { readOnlyRoots: [shared], readWriteRoots: [cache], protectedPaths: [] },
      network: "deny",
      credentials: "existing-policy",
      hostServices: "existing-policy",
    },
    context: {
      hostId: "host",
      projectId: "20000000-0000-4000-8000-000000000001",
      checkoutId: "checkout",
      sessionId: "epoch:session",
      provider: "native-harness",
    },
  });
  const launch = (script: string, selection = sandboxPolicy) =>
    makeProcessConfinementLive().prepare({
      executable: "/bin/sh",
      args: ["-c", script],
      boundRoot: project,
      temporaryDirectory: scratch,
      networkEgress: "allow",
      sandboxPolicy: selection,
    });
  const run = (script: string, selection = sandboxPolicy) => {
    const prepared = launch(script, selection);
    return spawnSync(prepared.command, [...prepared.args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin", HOME: scratch },
    });
  };
  return { base, project, shared, cache, sandboxPolicy, launch, run };
}

describe.skipIf(
  (process.platform !== "linux" && process.platform !== "darwin") ||
    (process.platform === "linux" &&
      !existsSync("/usr/bin/bwrap") &&
      process.env["OCTANT_REQUIRE_LINUX_ISOLATION"] !== "1") ||
    (process.platform === "darwin" && !existsSync("/usr/bin/sandbox-exec")),
)("native sandbox policy launch", () => {
  it("permits scoped writes and tests while confining child processes", () => {
    const { base, project, shared, cache, run } = fixture();
    writeFileSync(join(shared, "input"), "shared input");
    writeFileSync(join(base, "outside"), "outside canary");
    symlinkSync(join(base, "outside"), join(project, "outside-link"));
    const script = `set -eu
cat "$1/input" > result
printf 'cache' > "$2/build"
/bin/sh -c 'test "$(cat result)" = "shared input"'
if /bin/sh -c 'printf changed > "$1/input"' child "$1"; then exit 31; fi
if /bin/sh -c 'rm "$1/input"' child "$1"; then exit 32; fi
if /bin/sh -c 'mv "$1" "$1-moved"' child "$1"; then exit 33; fi
if cat outside-link; then exit 34; fi
if cat "$3/outside"; then exit 35; fi
/bin/sh -c 'printf changed > "$1/outside"' child "$3" || true`;
    writeFileSync(join(project, "workflow"), script);
    const result = run(`/bin/sh ./workflow '${shared}' '${cache}' '${base}'`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(project, "result"), "utf8")).toBe("shared input");
    expect(readFileSync(join(cache, "build"), "utf8")).toBe("cache");
    expect(readFileSync(join(shared, "input"), "utf8")).toBe("shared input");
    expect(readFileSync(join(base, "outside"), "utf8")).toBe("outside canary");
  });

  it("enforces a selected network denial even when the original launch allowed networking", async () => {
    const { sandboxPolicy, run } = fixture();
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
      const command = `/bin/bash -c 'echo hello > /dev/tcp/127.0.0.1/${address.port}'`;
      const allowed = run(command, {
        ...sandboxPolicy,
        policy: { ...sandboxPolicy.policy, network: "unrestricted" },
      });
      expect(allowed.status, allowed.stderr).toBe(0);
      const denied = run(command);
      expect(denied.status, denied.stderr).not.toBe(0);
      expect(denied.error).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("refuses unsupported requirements before invoking any executable", () => {
    const { project, sandboxPolicy, launch } = fixture();
    const marker = join(project, "must-not-exist");
    expect(() =>
      launch(`touch '${marker}'`, {
        ...sandboxPolicy,
        policy: { ...sandboxPolicy.policy, hostServices: "blocked" },
      }),
    ).toThrow(ProcessConfinementError);
    expect(existsSync(marker)).toBe(false);
  });
});
