import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertObservedClaudeHosts,
  assertClaudeTurnEvidence,
  assertClaudeTemporaryConfigRemoved,
  assertProcessGroupsExited,
  claudeHostAllowlist,
  ClaudeKeychainHelperFailure,
  claudeProviderCommand,
  claudeSmokeTurnRequest,
  combineClaudeLifecycleFailures,
  createClaudeKeychainHandleRegistry,
  findOwnedClaudeProcessGroups,
  keychainHelperInvocation,
  packagedClaudeEnvironment,
  resolveConfiguredClaudeBinary,
  readClaudeSmokeModes,
  redactClaudeSmokeText,
  runClaudeCleanupChecks,
  runBoundedClaudeKeychainHelper,
  runClaudeLifecycleMatrix,
  sanitizedClaudeSmokeSubprocessEnvironment,
  smokeSubprocessSpec,
  waitForClaudeChildLaunch,
  withIncrementalClaudeCleanup,
  cleanupClaudeCredential,
  startClaudeConnectObserver,
  type ClaudeProcessSnapshot,
  type ClaudeConnectObserver,
} from "./smoke-packaged-claude";

const openObservers: ClaudeConnectObserver[] = [];

afterEach(async () => {
  await Promise.all(openObservers.splice(0).map((observer) => observer.close()));
});

describe("packaged Claude process attribution", () => {
  const baseline: ReadonlyArray<ClaudeProcessSnapshot> = [
    snapshot(100, 1, 100, "/usr/local/bin/claude --version"),
  ];

  it("excludes baseline and unrelated matching processes while returning every exact owned group", () => {
    const server = snapshot(200, 190, 190, "/package/apps/server/dist/main.mjs");
    const probe = snapshot(300, server.pid, 300, "/usr/local/bin/claude --version");
    const query = snapshot(
      301,
      server.pid,
      301,
      "/usr/local/bin/claude --output-format stream-json",
    );
    const unrelated = snapshot(400, 1, 400, "/usr/local/bin/claude --version");

    expect(
      findOwnedClaudeProcessGroups(baseline, [...baseline, server, unrelated, probe, query], {
        serverCommand: "/package/apps/server/dist/main.mjs",
        claudeExecutable: "/usr/local/bin/claude",
      }),
    ).toEqual([300, 301]);
  });

  it("attributes surviving renamed descendants to the captured groups", () => {
    expect(() =>
      assertProcessGroupsExited([300, 301], [snapshot(302, 1, 301, "renamed child")]),
    ).toThrow("managed Claude process groups 301");
  });
});

describe("packaged Claude dual-auth harness", () => {
  it("requires an explicit absolute executable Claude binary", async () => {
    const accessCalls: Array<readonly [string, number]> = [];
    const checkAccess = async (path: string, mode: number) => {
      accessCalls.push([path, mode]);
    };

    await expect(resolveConfiguredClaudeBinary({}, checkAccess)).rejects.toThrow(/explicit/i);
    await expect(
      resolveConfiguredClaudeBinary({ OCTANT_CLAUDE_BINARY_PATH: "" }, checkAccess),
    ).rejects.toThrow(/explicit/i);
    await expect(
      resolveConfiguredClaudeBinary({ OCTANT_CLAUDE_BINARY_PATH: "bin/claude" }, checkAccess),
    ).rejects.toThrow(/absolute/i);
    await expect(
      resolveConfiguredClaudeBinary(
        { OCTANT_CLAUDE_BINARY_PATH: "/opt/claude/bin/claude" },
        checkAccess,
      ),
    ).resolves.toBe("/opt/claude/bin/claude");
    expect(accessCalls).toEqual([["/opt/claude/bin/claude", 1]]);

    const source = await readFile(new URL("./smoke-packaged-claude.ts", import.meta.url), "utf8");
    expect(source).not.toContain('runCommand("/usr/bin/which"');
  });

  it("gives every smoke subprocess a positive environment without ambient credentials", () => {
    const source = {
      HOME: "/Users/test",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "api-private",
      ANTHROPIC_AUTH_TOKEN: "auth-private",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-private",
      OCTANT_CREDENTIAL_BROKER_TOKEN: "broker-private",
      OCTANT_DESKTOP_BRIDGE_SECRET: "bridge-private",
      OCTANT_CLAUDE_API_KEY_SMOKE: "1",
      OCTANT_TEST_CREDENTIAL: "test-private",
      AWS_SECRET_ACCESS_KEY: "aws-private",
    };
    const expected = {
      HOME: "/Users/test",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    };

    expect(sanitizedClaudeSmokeSubprocessEnvironment(source)).toEqual(expected);
    const spec = smokeSubprocessSpec("/usr/bin/true", ["safe"], source);
    expect(spec).toEqual({ command: "/usr/bin/true", args: ["safe"], env: expected });
    expect(JSON.stringify(spec)).not.toMatch(
      /api-private|auth-private|oauth-private|broker-private|bridge-private|test-private|aws-private/,
    );
  });

  it("gates subscription and API-key modes independently", () => {
    expect(readClaudeSmokeModes({ OCTANT_CLAUDE_SUBSCRIPTION_SMOKE: "1" })).toEqual([
      "subscription",
    ]);
    expect(readClaudeSmokeModes({ OCTANT_CLAUDE_API_KEY_SMOKE: "1" })).toEqual(["api-key"]);
    expect(
      readClaudeSmokeModes({
        OCTANT_CLAUDE_SUBSCRIPTION_SMOKE: "1",
        OCTANT_CLAUDE_API_KEY_SMOKE: "1",
      }),
    ).toEqual(["subscription", "api-key"]);
    expect(() => readClaudeSmokeModes({})).toThrow(/select.*auth mode/i);
  });

  it("launches isolated packaged data with observer control but without ambient credentials", () => {
    expect(
      packagedClaudeEnvironment(
        {
          HOME: "/Users/test",
          ANTHROPIC_API_KEY: "private-value",
          CLAUDE_CODE_OAUTH_TOKEN: "private-oauth",
        },
        "/tmp/octant-claude-data",
        "/tmp/octant-claude-temp",
        43123,
      ),
    ).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: "/tmp/octant-claude-temp",
      OCTANT_DATA_DIR: "/tmp/octant-claude-data",
      OCTANT_SERVER_PORT: "13773",
      OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
      OCTANT_CLAUDE_CONNECT_OBSERVER_URL: "http://127.0.0.1:43123",
    });
  });

  it("configures only the explicit external binary and generic packaged turn route", async () => {
    const instanceId = "80000000-0000-4000-8000-000000000701";
    expect(claudeProviderCommand(instanceId, "/usr/local/bin/claude", "api-key")).toEqual({
      kind: "create-claude-provider",
      instanceId,
      expectedVersion: 0,
      displayName: "Claude packaged API-key smoke",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/usr/local/bin/claude",
        authentication: "api-key",
      },
    });
    expect(claudeSmokeTurnRequest("claude-model")).toMatchObject({
      action: "complete",
      modelId: "claude-model",
      prompt: expect.stringContaining("octant-smoke"),
    });
    const source = await readFile(new URL("./smoke-packaged-claude.ts", import.meta.url), "utf8");
    expect(source).toContain("/packaged-smoke-turn");
    expect(source).not.toContain("claudeSmokeTestHelpers");
  });

  it("passes API keys only through Keychain helper stdin", () => {
    const invocation = keychainHelperInvocation("/Applications/Octant/helper", {
      operation: "set",
      providerInstanceId: "80000000-0000-4000-8000-000000000701",
      credential: "private-value",
    });
    expect(invocation.args).toEqual([]);
    expect(invocation.stdin).toContain("private-value");
    expect(`${invocation.command}\0${invocation.args.join("\0")}`).not.toContain("private-value");
  });

  it("deletes the exact smoke Keychain item and rejects residue", async () => {
    const clean = {
      cancelActive: async () => undefined,
      delete: async () => undefined,
      has: async () => false,
    };
    await expect(cleanupClaudeCredential(clean, "fixture-id")).resolves.toBeUndefined();
    const residue = await cleanupClaudeCredential(
      { ...clean, has: async () => true },
      "fixture-id",
    ).catch((error) => error);
    expect(residue).toBeInstanceOf(AggregateError);
    expect((residue as AggregateError).errors.map((error) => error.message)).toEqual([
      "Packaged Claude Keychain item remains.",
    ]);
  });

  it("drains a stale helper before later successful delete and residue checks", async () => {
    const closed = deferred<number | null>();
    const stdin = deferred<void>();
    const stdout = deferred<string>();
    const stderr = deferred<string>();
    let terminationShouldFail = true;
    const calls: string[] = [];
    const registry = createClaudeKeychainHandleRegistry({
      drainTimeoutMs: 5,
      terminationTimeoutMs: 5,
    });
    registry.track({
      closed: closed.promise,
      stdin: stdin.promise,
      stdout: stdout.promise,
      stderr: stderr.promise,
      terminate: async () => {
        calls.push("terminate-stale");
        if (terminationShouldFail) await new Promise<void>(() => undefined);
        stdin.resolve();
        stdout.resolve("");
        stderr.resolve("");
        closed.resolve(null);
      },
    });

    const setupFailure = await registry.cancelActive().catch((error) => error);
    expect(setupFailure).toBeInstanceOf(AggregateError);
    expect(registry.activeCount()).toBe(1);

    const failure = await cleanupClaudeCredential(
      {
        cancelActive: registry.cancelActive,
        delete: async () => void calls.push("delete"),
        has: async () => {
          calls.push("has");
          return false;
        },
      },
      "fixture-id",
    ).catch((error) => error);

    expect(calls).toEqual(["terminate-stale", "terminate-stale", "delete", "has"]);
    expect(registry.activeCount()).toBe(1);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => error.message)).toEqual([
      "Packaged Claude stale Keychain helper cleanup failed.",
    ]);
    expect(serializeError(failure)).not.toMatch(/stale-private-detail/i);

    terminationShouldFail = false;
    await expect(registry.cancelActive()).resolves.toBeUndefined();
    expect(registry.activeCount()).toBe(0);
    await expect(registry.cancelActive()).resolves.toBeUndefined();
    expect(calls).toEqual([
      "terminate-stale",
      "terminate-stale",
      "delete",
      "has",
      "terminate-stale",
    ]);
  });

  it("rejects only Claude API temporary configuration residue", () => {
    expect(() => assertClaudeTemporaryConfigRemoved(["unrelated"])).not.toThrow();
    expect(() => assertClaudeTemporaryConfigRemoved(["octant-claude-config-abc"])).toThrow(
      /configuration directory remains/i,
    );
  });

  it("accepts only normalized generic smoke completion evidence", () => {
    const evidence = {
      events: [
        { kind: "text-delta", text: "oc" },
        { kind: "text-delta", text: "tant" },
        { kind: "text-delta", text: "-" },
        { kind: "text-delta", text: "smoke" },
        { kind: "usage", inputTokens: 1, outputTokens: 2 },
        { kind: "completed" },
      ],
      observation: { readiness: "ready" },
    };
    expect(() => assertClaudeTurnEvidence(evidence)).not.toThrow();
    expect(() =>
      assertClaudeTurnEvidence({ ...evidence, events: [{ kind: "completed" }] }),
    ).toThrow(/normalized text, usage, or terminal/i);
    expect(() =>
      assertClaudeTurnEvidence({
        ...evidence,
        events: [
          { kind: "text-delta", text: "octant-" },
          { kind: "text-delta", text: "smoke" },
          { kind: "text-delta", text: "three" },
          { kind: "usage", inputTokens: 1, outputTokens: 2 },
          { kind: "completed" },
        ],
      }),
    ).toThrow(/four streamed text chunks/i);
    expect(() =>
      assertClaudeTurnEvidence({
        ...evidence,
        events: [
          { kind: "text-delta", text: "four" },
          { kind: "text-delta", text: "chunks" },
          { kind: "text-delta", text: "without" },
          { kind: "text-delta", text: "sentinel" },
          { kind: "usage", inputTokens: 1, outputTokens: 2 },
          { kind: "completed" },
        ],
      }),
    ).toThrow(/octant-smoke sentinel/i);
  });
});

describe("packaged Claude cleanup and redaction", () => {
  it("cleans acquired resources when the observer fails to start", async () => {
    const cleaned: string[] = [];
    const failure = await withIncrementalClaudeCleanup(async (registerCleanup) => {
      registerCleanup("temporary configuration", async () => void cleaned.push("temporary"));
      await Promise.reject(new Error("observer-start-private-detail"));
    }).catch((error) => error);

    expect(cleaned).toEqual(["temporary"]);
    expect(failure).toBeInstanceOf(Error);
    expect(serializeError(failure)).not.toMatch(/observer-start-private-detail/i);
  });

  it("awaits asynchronous app spawn errors and runs every acquired cleanup", async () => {
    const child = new EventEmitter() as EventEmitter & { pid?: number };
    const cleaned: string[] = [];
    const failurePromise = withIncrementalClaudeCleanup(async (registerCleanup) => {
      registerCleanup("temporary configuration", async () => void cleaned.push("temporary"));
      registerCleanup("listener", async () => void cleaned.push("listener"));
      registerCleanup("process", async () => void cleaned.push("process"));
      registerCleanup("application", async () => void cleaned.push("application"));
      const launch = waitForClaudeChildLaunch(child, 100);
      queueMicrotask(() => child.emit("error", new Error("spawn-private-detail")));
      await launch;
    });

    const failure = await failurePromise.catch((error) => error);
    expect(cleaned).toEqual(["application", "process", "listener", "temporary"]);
    expect(failure).toBeInstanceOf(Error);
    expect(serializeError(failure)).not.toMatch(/spawn-private-detail/i);
  });

  it("bounds cleanup finalizers and continues after a timeout", async () => {
    const calls: string[] = [];
    let finishHung: (() => void) | undefined;
    const failure = await runClaudeCleanupChecks(
      [
        [
          "hung",
          async () =>
            await new Promise<void>((resolve) => {
              finishHung = resolve;
            }),
          async () => {
            calls.push("cancel-hung");
            finishHung?.();
          },
        ],
        ["later", async () => void calls.push("later")],
      ],
      5,
    ).catch((error) => error);

    expect(calls).toEqual(["cancel-hung", "later"]);
    expect(failure).toBeInstanceOf(AggregateError);
  });

  it("terminates and drains helper hangs during setup and incremental cleanup", async () => {
    const starts: Array<{
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
      readonly stdin: string;
    }> = [];
    const terminations: string[] = [];
    const drains: string[] = [];
    const startHelper = (
      _command: string,
      args: ReadonlyArray<string>,
      env: NodeJS.ProcessEnv,
      stdin: string,
    ) => {
      const closed = deferred<number | null>();
      const stdout = deferred<string>();
      const stderr = deferred<string>();
      const input = deferred<void>();
      starts.push({ args, env, stdin });
      void closed.promise.then(() => drains.push("closed"));
      void stdout.promise.then(() => drains.push("stdout"));
      void stderr.promise.then(() => drains.push("stderr"));
      void input.promise.then(() => drains.push("stdin"));
      return {
        closed: closed.promise,
        stdout: stdout.promise,
        stderr: stderr.promise,
        stdin: input.promise,
        terminate: async () => {
          terminations.push("terminate");
          input.resolve();
          stdout.resolve("");
          stderr.resolve("");
          closed.resolve(null);
        },
      };
    };
    const invoke = () =>
      runBoundedClaudeKeychainHelper(
        keychainHelperInvocation("/Applications/Octant/helper", {
          operation: "set",
          providerInstanceId: "fixture-id",
          credential: "private-helper-value",
        }),
        {
          HOME: "/Users/test",
          ANTHROPIC_API_KEY: "ambient-private-value",
        },
        { timeoutMs: 5, startHelper },
      );
    const cleaned: string[] = [];
    const failure = await withIncrementalClaudeCleanup(async (registerCleanup) => {
      registerCleanup("temporary", async () => void cleaned.push("temporary"));
      registerCleanup("Keychain", async () => void (await invoke()));
      await invoke();
    }).catch((error) => error);

    expect(starts).toHaveLength(2);
    expect(terminations).toEqual(["terminate", "terminate"]);
    expect(drains).toHaveLength(8);
    expect(cleaned).toEqual(["temporary"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.every(
        (error) => error instanceof Error && !error.message.includes("private"),
      ),
    ).toBe(true);
    expect(starts.every(({ args }) => !args.join("\0").includes("private-helper-value"))).toBe(
      true,
    );
    expect(starts.every(({ env }) => !JSON.stringify(env).includes("ambient-private-value"))).toBe(
      true,
    );
    expect(starts.every(({ stdin }) => stdin.includes("private-helper-value"))).toBe(true);

    const directFailure = await invoke().catch((error) => error);
    expect(directFailure).toBeInstanceOf(ClaudeKeychainHelperFailure);
    expect((directFailure as ClaudeKeychainHelperFailure).code).toBe("timeout");
    expect(serializeError(directFailure)).not.toMatch(/private-helper-value|ambient-private-value/);
  });

  it("runs graceful and forced lifecycles and aggregates both failures", async () => {
    const calls: string[] = [];
    const failure = await runClaudeLifecycleMatrix(async (shutdown) => {
      calls.push(shutdown);
      throw new Error(`${shutdown}-private-detail`);
    }).catch((error) => error);

    expect(calls).toEqual(["graceful", "forced"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(serializeError(failure)).not.toMatch(/private-detail/i);
  });

  it("aggregates primary, graceful/forced, Keychain, temp, and listener failures", async () => {
    const cleanup = await runClaudeCleanupChecks([
      [
        "process",
        async () => {
          throw new Error("raw process detail");
        },
      ],
      [
        "keychain",
        async () => {
          throw new Error("sk-" + "ant-private");
        },
      ],
      [
        "temp",
        async () => {
          throw new Error("/private/api-config");
        },
      ],
      [
        "listener",
        async () => {
          throw new Error("token=private");
        },
      ],
    ]).catch((error) => error);
    const failure = combineClaudeLifecycleFailures(new Error("probe secret"), cleanup);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(5);
    expect(serializeError(failure)).not.toMatch(/sk-ant|private|raw process|probe secret/i);
  });

  it("redacts supplied secrets and credential-shaped values", () => {
    const apiLikeValue = "sk-" + "ant-api03-secret";
    expect(
      redactClaudeSmokeText(
        `ANTHROPIC_API_KEY=${apiLikeValue} authorization=Bearer oauth-secret account=a@b.test`,
        ["oauth-secret"],
      ),
    ).toBe("[redacted]");
  });
});

describe("Claude CONNECT privacy observer", () => {
  it("forwards TLS bytes unchanged and records normalized hostnames only", async () => {
    const received: Buffer[] = [];
    const upstream = createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(Buffer.from(chunk));
        socket.write(chunk);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const observer = await startClaudeConnectObserver({
      connect: () => ({ host: "127.0.0.1", port: upstreamPort }),
    });
    openObservers.push(observer);
    const client = await connect(observer.port);
    client.write(
      `CONNECT API.Anthropic.COM.:443 HTTP/1.1\r\nHost: ignored.invalid\r\nAuthorization: secret\r\n\r\n`,
    );
    await onceData(client);
    const opaqueTls = Buffer.from([22, 3, 1, 0, 4, 0xde, 0xad, 0xbe, 0xef]);
    client.write(opaqueTls);
    expect(await onceData(client)).toEqual(opaqueTls);
    client.destroy();
    await observer.close();
    openObservers.splice(openObservers.indexOf(observer), 1);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));

    expect(Buffer.concat(received)).toEqual(opaqueTls);
    expect(observer.hostnames()).toEqual(["api.anthropic.com"]);
    expect(JSON.stringify(observer.hostnames())).not.toMatch(
      /authorization|ignored|secret|CONNECT/i,
    );
  });

  it("uses reviewed mode-specific allowlists and fails closed for bypass or forbidden hosts", () => {
    expect(claudeHostAllowlist("api-key")).toEqual(new Set(["api.anthropic.com"]));
    expect(claudeHostAllowlist("subscription")).toEqual(
      new Set(["api.anthropic.com", "claude.ai"]),
    );
    expect(() => assertObservedClaudeHosts("api-key", [])).toThrow(/blocked.*bypass/i);
    for (const host of [
      "statsig.anthropic.com",
      "sentry.io",
      "downloads.claude.ai",
      "storage.googleapis.com",
      "mcp-proxy.anthropic.com",
      "unknown.example",
    ]) {
      expect(() => assertObservedClaudeHosts("api-key", [host])).toThrow(/not allowed/i);
    }
  });
});

function snapshot(pid: number, ppid: number, pgid: number, command: string): ClaudeProcessSnapshot {
  return { pid, ppid, pgid, command };
}

function serializeError(error: unknown): string {
  return JSON.stringify(error, (_key, value) => {
    if (value instanceof AggregateError) return { message: value.message, errors: value.errors };
    if (value instanceof Error) return { message: value.message };
    return value;
  });
}

async function connect(port: number) {
  const { connect } = await import("node:net");
  return await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function onceData(socket: NodeJS.EventEmitter): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(Buffer.from(chunk)));
    socket.once("error", reject);
  });
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
