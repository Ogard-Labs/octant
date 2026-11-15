import { Schema } from "effect";
import { ToolEgressLaunch, ToolEgressRuleId } from "@octant/contracts";
import { startToolEgressProxy } from "../harness/nativeHarnessEgressProxy";
import { configureSandboxRestrictionsAuthority, trackSandboxChild } from "./sandboxRuntimePolicy";
import { spawnSync, spawn } from "node:child_process";
import { createServer, connect as netConnect } from "node:net";
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
import { join, dirname } from "node:path";
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
  const shared =
    process.platform === "linux"
      ? realpathSync(mkdtempSync("/dev/shm/octant-policy-readonly-"))
      : join(base, "shared");
  if (process.platform === "linux") directories.push(shared);
  const cache = join(base, "cache");
  const scratch = join(base, "scratch");
  for (const path of [project, shared, cache, scratch]) if (!existsSync(path)) mkdirSync(path);
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
      root: project,
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
      // Match the toolchain read baseline used by the existing native launchers.
      // Home/private denials and the selected read-only roots still apply last.
      allowFileReadStar: true,
      sandboxPolicy: selection,
    });
  const run = (script: string, selection = sandboxPolicy) => {
    const prepared = launch(script, selection);
    return spawnSync(prepared.command, [...prepared.args], {
      cwd: project,
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin", HOME: scratch },
    });
  };
  return { base, project, shared, cache, scratch, sandboxPolicy, launch, run };
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
    expect(
      result.status,
      JSON.stringify({
        error: result.error?.message,
        signal: result.signal,
        stderr: result.stderr,
      }),
    ).toBe(0);
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
      const command = `printf network-client-ready; /bin/bash -c 'echo hello > /dev/tcp/127.0.0.1/${address.port}'`;
      const allowed = run(command, {
        ...sandboxPolicy,
        policy: { ...sandboxPolicy.policy, network: "unrestricted" },
      });
      expect(
        allowed.status,
        JSON.stringify({
          error: allowed.error?.message,
          signal: allowed.signal,
          stderr: allowed.stderr,
        }),
      ).toBe(0);
      const denied = run(command);
      expect(denied.status, denied.stderr).not.toBe(0);
      expect(denied.stdout).toContain("network-client-ready");
      expect(denied.error).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("blocks a host Unix socket even when network access is unrestricted", async () => {
    const { project, sandboxPolicy, run } = fixture();
    const socketPath = join(project, "host.sock");
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const command = `/usr/bin/python3 -c 'import socket; print("unix-client-ready", flush=True); s=socket.socket(socket.AF_UNIX); s.connect("${socketPath}")'`;
      const open = run(command, {
        ...sandboxPolicy,
        policy: { ...sandboxPolicy.policy, network: "unrestricted" },
      });
      expect(
        open.status,
        JSON.stringify({ error: open.error?.message, signal: open.signal, stderr: open.stderr }),
      ).toBe(0);
      const blocked = run(command, {
        ...sandboxPolicy,
        policy: { ...sandboxPolicy.policy, hostServices: "blocked" },
      });
      expect(blocked.status, blocked.stderr).not.toBe(0);
      expect(blocked.stdout).toContain("unix-client-ready");
      expect(blocked.error).toBeUndefined();
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
        policy: { ...sandboxPolicy.policy, credentials: "isolated" },
      }),
    ).toThrow(ProcessConfinementError);
    expect(existsSync(marker)).toBe(false);
  });
  it.skipIf(process.platform !== "linux")(
    "revokes detached descendants with the owned PID namespace",
    async () => {
      const f = fixture();
      const heartbeat = join(f.project, "heartbeat");
      const prepared = f.launch(
        "setsid /bin/sh -c 'while :; do echo tick >> heartbeat; sleep 0.02; done' & while :; do sleep 1; done",
      );
      const cleanups: Array<() => Promise<void>> = [];
      configureSandboxRestrictionsAuthority({
        validateSelection: () => true,
        registerCleanup: (_id, cleanup) => {
          cleanups.push(cleanup);
          return () => undefined;
        },
        active: () => f.sandboxPolicy,
        beginTurn: () => ({ status: "refused", message: "unused" }),
        storageDirectory: () => undefined,
        deny: () => undefined,
      });
      const child = spawn(prepared.command, [...prepared.args], {
        cwd: f.project,
        env: { PATH: "/usr/bin:/bin", HOME: f.scratch },
        stdio: "ignore",
      });
      try {
        trackSandboxChild(f.sandboxPolicy, child);
        await waitUntil(() => existsSync(heartbeat) && readFileSync(heartbeat).length > 8);
        await Promise.all(cleanups.map((cleanup) => cleanup()));
        const after = readFileSync(heartbeat, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(readFileSync(heartbeat, "utf8")).toBe(after);
      } finally {
        child.kill("SIGKILL");
        configureSandboxRestrictionsAuthority(undefined);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "allows the brokered destination while denying direct TCP and ambient Unix services",
    async () => {
      const f = fixture();
      const hostSocket = join(f.project, "host.sock");
      const server = createServer((socket) => {
        socket.once("data", () => {
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const unix = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => unix.listen(hostSocket, resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing TCP address");
      const proxy = await startToolEgressProxy({
        launch: Schema.decodeUnknownSync(ToolEgressLaunch)({
          launchId: "30000000-0000-4000-8000-000000000001",
          threadId: "10000000-0000-4000-8000-000000000001",
          projectId: f.sandboxPolicy.context.projectId,
        }),
        endpoint: { kind: "unix-socket", parentDirectory: f.base },
        taint: () => ({ threadTainted: false, parentTainted: false }),
        rules: () => [],
        clock: () => new Date().toISOString(),
        decision: {
          kind: "provider-runtime",
          decide: ({ host, port }) =>
            host === "allowed.example.com" && port === 80
              ? {
                  kind: "allow",
                  host,
                  port,
                  by: "project-rule",
                  ruleId: Schema.decodeUnknownSync(ToolEgressRuleId)(
                    "40000000-0000-4000-8000-000000000001",
                  ),
                }
              : { kind: "refuse", reason: "no-rule", host, port },
          privateAddressAllowed: () => false,
        },
        records: {
          launchStarted: async () => ({ status: "appended" }),
          decisionsRecorded: async () => ({ status: "appended" }),
          launchSummarized: async () => ({ status: "appended" }),
        },
        resolveAll: async () => ["93.184.216.34"],
        connect: () => netConnect({ host: "127.0.0.1", port: address.port, allowHalfOpen: true }),
      });
      if (proxy.status !== "listening") throw new Error("Proxy failed");
      try {
        const token = Buffer.from(`octant:${proxy.proxy.token}`).toString("base64");
        const script = `import socket
for family, target in [(socket.AF_INET, ("127.0.0.1", ${address.port})), (socket.AF_UNIX, "${hostSocket}")]:
 try:
  s=socket.socket(family); s.settimeout(1); s.connect(target)
 except OSError:
  pass
 else:
  raise RuntimeError("ambient service escaped")
s=socket.socket(); s.connect(("127.0.0.1", 3128)); s.sendall(b"GET http://allowed.example.com/ HTTP/1.1\\r\\nHost: allowed.example.com\\r\\nProxy-Authorization: Basic ${token}\\r\\nConnection: close\\r\\n\\r\\n"); assert b"200" in s.recv(4096)`;
        writeFileSync(join(f.project, "probe.py"), script);
        const selected = {
          ...f.sandboxPolicy,
          policy: {
            ...f.sandboxPolicy.policy,
            hostServices: "blocked" as const,
            network: "unrestricted" as const,
          },
        };
        const launch = makeProcessConfinementLive().prepare({
          executable: "/usr/bin/python3",
          args: [join(f.project, "probe.py")],
          boundRoot: f.project,
          temporaryDirectory: f.scratch,
          networkEgress: { kind: "proxied", endpoint: proxy.proxy.endpoint },
          sandboxPolicy: selected,
        });
        const result = await new Promise<{ code: number | null; stderr: string }>(
          (resolve, reject) => {
            let stderr = "";
            const child = spawn(launch.command, [...launch.args], {
              cwd: f.project,
              env: { PATH: "/usr/bin:/bin", HOME: f.scratch },
            });
            child.stderr.on("data", (chunk) => {
              stderr += chunk;
            });
            child.once("error", reject);
            child.once("exit", (code) => resolve({ code, stderr }));
          },
        );
        expect(result.code, result.stderr).toBe(0);
      } finally {
        await proxy.proxy.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => unix.close(() => resolve()));
      }
    },
  );

  it("runs a permitted dependency-install, edit, test and Git workflow with persistent atomic writes", () => {
    const f = fixture();
    const node = process.execPath;
    const npm = join(dirname(node), "npm");
    if (!existsSync(npm))
      throw new Error("The native workflow requires npm beside the test runtime");
    writeFileSync(
      join(f.project, "package.json"),
      JSON.stringify({
        name: "sandbox-workflow",
        version: "1.0.0",
        private: true,
        scripts: {
          postinstall: `node -e 'require("fs").writeFileSync("installed", "ready")'`,
          test: `node -e 'if(require("fs").readFileSync("result", "utf8")!=="changed")process.exit(1)'`,
        },
      }),
    );
    const script = `set -eu
npm install --offline --no-audit --no-fund --cache "$TMPDIR/npm"
node -e 'const f=require("fs");f.writeFileSync("result.new","changed");f.renameSync("result.new","result")'
npm test
/usr/bin/git init -q
/usr/bin/git add package.json package-lock.json result installed
/usr/bin/git -c user.name=Sandbox -c user.email=sandbox@example.invalid commit -qm 'Allowed workflow'
/usr/bin/git diff --exit-code
`;
    const launch = makeProcessConfinementLive().prepare({
      executable: "/bin/sh",
      args: ["-c", script],
      boundRoot: f.project,
      temporaryDirectory: f.scratch,
      networkEgress: "none",
      allowFileReadStar: true,
      sandboxPolicy: f.sandboxPolicy,
      readRoots: [dirname(dirname(node))],
    });
    const result = spawnSync(launch.command, [...launch.args], {
      cwd: f.project,
      env: { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: f.scratch, TMPDIR: f.scratch },
      encoding: "utf8",
      timeout: 20000,
    });
    expect(
      result.status,
      JSON.stringify({
        error: result.error?.message,
        signal: result.signal,
        stderr: result.stderr,
      }),
    ).toBe(0);
    expect(readFileSync(join(f.project, "result"), "utf8")).toBe("changed");
    expect(readFileSync(join(f.project, "installed"), "utf8")).toBe("ready");
    expect(existsSync(join(f.project, ".git", "index.lock"))).toBe(false);
  });
});

async function waitUntil(check: () => boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Native child did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
