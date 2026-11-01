import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeProviderInstance,
  decodeProviderToolingAppliedRecord,
  type ProviderInstance,
  type ProviderToolingAppliedRecord,
  type ProviderToolingPlan,
  type ProviderToolingRequest,
} from "@octant/contracts";
import type { ProviderCredentialStore } from "./credentialBrokerClient";
import { runProviderToolingProcess } from "./providerToolingProcess";
import { ProviderToolingService, type ProviderToolingCaller } from "./providerToolingService";

const CLAUDE_ID = "80000000-0000-4000-8000-0000000000a1";
const CODEX_ID = "80000000-0000-4000-8000-0000000000a2";
const SECRET = "plain-secret-value-123";
const LOCAL: ProviderToolingCaller = { kind: "local-window", windowId: "window-1" };
const REMOTE: ProviderToolingCaller = { kind: "remote-device", windowId: "device-1" };

let root: string;
let bin: string;
let claudeHome: string;
let codexHome: string;
let log: string;

/**
 * A stand-in provider program: it records its arguments as JSON (so any
 * character survives), the variables a test asks about, and answers like the
 * real thing for the list commands.
 */
function installFakeCli(name: "claude" | "codex", options: { readonly exitCode?: number } = {}) {
  const script = `#!/bin/sh
LOG="${log}.${name}"
${process.execPath} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "$LOG.json" "$@"
printf '%s' "\${MCP_CLIENT_SECRET-}" > "$LOG.secret"
printf '%s' "\${ANTHROPIC_API_KEY-}\${OPENAI_API_KEY-}" > "$LOG.canary"
printf '%s' "\${CLAUDE_CONFIG_DIR-}|\${CODEX_HOME-}" > "$LOG.dirs"
pwd > "$LOG.cwd"
case "$1 $2" in
  "mcp list") if [ "${name}" = codex ]; then echo '[{"name":"files","enabled":true,"transport":{"type":"stdio","command":"node","args":["a"]}}]'; else printf 'Checking MCP server health…\\n\\nfiles: node a - ✓ Connected\\n'; fi; exit 0 ;;
  "plugin list") echo '[{"id":"hello@market","version":"1.0.0","scope":"user","enabled":true}]'; [ "${name}" = codex ] && echo '{"installed":[{"name":"hello","marketplaceName":"market","version":"1.0.0","enabled":true}]}' ; exit 0 ;;
  "plugin marketplace") echo '[{"name":"market","source":"github","repo":"owner/repo"}]'; exit 0 ;;
esac
echo "ran: $*"
echo "secret-seen: \${MCP_CLIENT_SECRET-}"
exit ${options.exitCode ?? 0}
`;
  const path = join(bin, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function recordedArgv(name: string): ReadonlyArray<string> {
  return JSON.parse(readFileSync(`${log}.${name}.json`, "utf8"));
}

function instance(kind: "claude" | "codex"): ProviderInstance {
  return decodeProviderInstance(
    kind === "claude"
      ? {
          id: CLAUDE_ID,
          displayName: "Claude A",
          driverKind: "claude",
          configuration: {
            kind: "claude-agent-sdk",
            binaryPath: join(bin, "claude"),
            authentication: "subscription",
            configDirectory: claudeHome,
          },
          enabled: true,
          environmentPolicy: "inherit-host",
          version: 1,
          createdAt: "2026-07-16T11:00:00.000Z",
          updatedAt: "2026-07-16T11:00:00.000Z",
        }
      : {
          id: CODEX_ID,
          displayName: "Codex A",
          driverKind: "codex",
          configuration: {
            kind: "codex-cli",
            binaryPath: join(bin, "codex"),
            codexHome,
          },
          enabled: true,
          environmentPolicy: "inherit-host",
          version: 1,
          createdAt: "2026-07-16T11:00:00.000Z",
          updatedAt: "2026-07-16T11:00:00.000Z",
        },
  );
}

class Broker implements ProviderCredentialStore {
  readonly held = new Map<string, string>();
  readonly deleted: string[] = [];
  async set(id: string, value: string) {
    this.held.set(id, value);
  }
  async delete(id: string) {
    this.held.delete(id);
    this.deleted.push(id);
  }
  async has(id: string) {
    return this.held.has(id);
  }
  async resolve(id: string) {
    const value = this.held.get(id);
    if (value === undefined) throw new Error("missing");
    return value;
  }
}

function make(
  options: { broker?: Broker | null; now?: () => number; replace?: ProviderInstance } = {},
) {
  const records: ProviderToolingAppliedRecord[] = [];
  const broker = options.broker === null ? undefined : (options.broker ?? new Broker());
  let current: Record<string, ProviderInstance> = {
    [CLAUDE_ID]: instance("claude"),
    [CODEX_ID]: instance("codex"),
  };
  const service = new ProviderToolingService({
    readInstance: (id) => current[String(id)],
    runner: runProviderToolingProcess,
    hostEnvironment: () => ({
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      ANTHROPIC_API_KEY: "host-canary-key",
      OPENAI_API_KEY: "host-canary-key",
    }),
    homeDirectory: root,
    workingDirectory: join(root, "work"),
    ...(broker === undefined ? {} : { secrets: broker }),
    record: (change) => records.push(change),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    service,
    records,
    broker,
    setInstance(next: ProviderInstance) {
      current = { ...current, [String(next.id)]: next };
    },
  };
}

async function planned(
  service: ProviderToolingService,
  id: string,
  request: ProviderToolingRequest,
): Promise<ProviderToolingPlan> {
  const plan = await service.plan(LOCAL, id as never, request);
  if (plan.status !== "planned") throw new Error(`not planned: ${JSON.stringify(plan)}`);
  return plan;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "octant-tooling-"));
  bin = join(root, "bin");
  claudeHome = join(root, "claude-home");
  codexHome = join(root, "codex-home");
  log = join(root, "log");
  for (const dir of [bin, claudeHome, codexHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  installFakeCli("claude");
  installFakeCli("codex");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("provider tooling service", () => {
  it("lists what an account has through its own commands, in that account's folder and without host keys", async () => {
    const { service } = make();
    const claude = await service.list(LOCAL, CLAUDE_ID as never);
    expect(claude.status).toBe("listed");
    if (claude.status !== "listed") return;
    expect(claude.sections.map((section) => section.kind)).toEqual([
      "mcp-servers",
      "plugins",
      "marketplaces",
    ]);
    expect(claude.sections[0]?.entries[0]).toMatchObject({ name: "files" });
    expect(claude.accountDirectory).toBe(claudeHome);
    expect(claude.runsAsItself).toBe(false);
    expect(readFileSync(`${log}.claude.dirs`, "utf8")).toBe(`${claudeHome}|`);
    expect(readFileSync(`${log}.claude.canary`, "utf8")).toBe("");
    expect(readFileSync(`${log}.claude.cwd`, "utf8").trim()).toContain("work");

    const codex = await service.list(LOCAL, CODEX_ID as never);
    expect(codex.status).toBe("listed");
    expect(readFileSync(`${log}.codex.dirs`, "utf8")).toBe(`|${codexHome}`);
    expect(readFileSync(`${log}.codex.canary`, "utf8")).toBe("");
  });

  it("runs a confirmed plan once with every hostile value as one argument and no shell", async () => {
    const { service, records } = make();
    const marker = join(root, "pwned");
    const hostile = [
      "a b",
      "a;b",
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      "'q' \"q\"",
      "--help",
      "-x",
      "x".repeat(2000),
    ];
    const plan = await planned(service, CLAUDE_ID, {
      kind: "mcp-add-stdio",
      name: "files",
      command: "/opt/my server/run",
      args: hostile,
      env: [{ name: "MODE", value: `a b;$(touch ${marker})` }],
    });
    expect(plan.commandLine).toContain("claude");
    const applied = await service.apply(LOCAL, { planId: plan.planId, digest: plan.digest });
    expect(applied.status).toBe("applied");
    expect(recordedArgv("claude")).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--env",
      `MODE=a b;$(touch ${marker})`,
      "--",
      "files",
      "/opt/my server/run",
      ...hostile,
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(records).toEqual([
      {
        provider: "claude",
        providerInstanceId: CLAUDE_ID,
        commandKind: "mcp-add-stdio",
        name: "files",
        outcome: "succeeded",
        usedSecret: false,
      },
    ]);
    const again = await service.apply(LOCAL, { planId: plan.planId, digest: plan.digest });
    expect(again).toMatchObject({ status: "refused" });
    expect(records).toHaveLength(1);
  });

  it("holds a secret in the broker, hands it over by environment only, and leaves it out of everything returned or recorded", async () => {
    const { service, records, broker } = make();
    const plan = await planned(service, CLAUDE_ID, {
      kind: "mcp-add-url",
      name: "hosted",
      url: "https://example.com/mcp",
      oauthClientId: "client-1",
      oauthClientSecret: SECRET,
    });
    expect(plan.usesSecret).toBe(true);
    expect(plan.commandLine).toContain("MCP_CLIENT_SECRET=<secret>");
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    expect(broker?.held.get(plan.planId)).toBe(SECRET);

    const applied = await service.apply(LOCAL, { planId: plan.planId, digest: plan.digest });
    expect(applied.status).toBe("applied");
    // The program printed the secret it received; the answer shows a placeholder.
    expect(readFileSync(`${log}.claude.secret`, "utf8")).toBe(SECRET);
    expect(JSON.stringify(applied)).not.toContain(SECRET);
    expect(applied.status === "applied" && applied.output).toContain("secret-seen: <secret>");
    expect(recordedArgv("claude").join(" ")).not.toContain(SECRET);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records[0]).toMatchObject({ usedSecret: true, name: "hosted" });
    expect(broker?.held.size).toBe(0);
    expect(broker?.deleted).toEqual([plan.planId]);
  });

  it("refuses a secret Codex would put on its command line, and refuses a secret when the host has no broker", async () => {
    const { service } = make();
    expect(
      await service.plan(LOCAL, CODEX_ID as never, {
        kind: "mcp-add-url",
        name: "hosted",
        url: "https://example.com/mcp",
        oauthClientSecret: SECRET,
      }),
    ).toMatchObject({ status: "refused", reason: "secret-unsupported" });
    const withoutBroker = make({ broker: null });
    expect(
      await withoutBroker.service.plan(LOCAL, CLAUDE_ID as never, {
        kind: "mcp-add-url",
        name: "hosted",
        url: "https://example.com/mcp",
        oauthClientId: "c",
        oauthClientSecret: SECRET,
      }),
    ).toMatchObject({ status: "refused", reason: "unavailable" });
  });

  it("refuses every step from a paired device and runs nothing", async () => {
    const { service, records } = make();
    expect(await service.list(REMOTE, CLAUDE_ID as never)).toMatchObject({
      reason: "not-a-local-window",
    });
    expect(
      await service.plan(REMOTE, CLAUDE_ID as never, { kind: "mcp-remove", name: "files" }),
    ).toMatchObject({ reason: "not-a-local-window" });
    const plan = await planned(service, CLAUDE_ID, { kind: "mcp-remove", name: "files" });
    expect(await service.apply(REMOTE, { planId: plan.planId, digest: plan.digest })).toMatchObject(
      { reason: "not-a-local-window" },
    );
    expect(existsSync(`${log}.claude.json`)).toBe(false);
    expect(records).toEqual([]);
  });

  it("runs only the plan that was shown, in the window that asked, before it expires", async () => {
    let clock = 1_000_000;
    const { service } = make({ now: () => clock });
    const plan = await planned(service, CODEX_ID, { kind: "mcp-remove", name: "files" });
    expect(
      await service.apply(LOCAL, { planId: plan.planId, digest: "0".repeat(64) }),
    ).toMatchObject({ reason: "changed-plan" });
    expect(
      await service.apply(
        { kind: "local-window", windowId: "other-window" },
        { planId: plan.planId, digest: plan.digest },
      ),
    ).toMatchObject({ reason: "unknown-plan" });
    expect(
      await service.apply(LOCAL, {
        planId: "11111111-1111-4111-8111-111111111111",
        digest: plan.digest,
      }),
    ).toMatchObject({ reason: "unknown-plan" });
    clock += 11 * 60_000;
    expect(await service.apply(LOCAL, { planId: plan.planId, digest: plan.digest })).toMatchObject({
      reason: "expired-plan",
    });
    expect(existsSync(`${log}.codex.json`)).toBe(false);
  });

  it("refuses to run a plan whose account moved to another folder after it was shown", async () => {
    const { service, setInstance } = make();
    const plan = await planned(service, CLAUDE_ID, { kind: "mcp-remove", name: "files" });
    const moved = instance("claude");
    if (moved.driverKind !== "claude") throw new Error("fixture");
    setInstance({
      ...moved,
      configuration: { ...moved.configuration, configDirectory: join(root, "elsewhere") },
    });
    expect(await service.apply(LOCAL, { planId: plan.planId, digest: plan.digest })).toMatchObject({
      reason: "changed-plan",
    });
    expect(existsSync(`${log}.claude.json`)).toBe(false);
  });

  it("reports a failing command with its scrubbed output and records the failure", async () => {
    installFakeCli("codex", { exitCode: 3 });
    const { service, records } = make();
    const plan = await planned(service, CODEX_ID, { kind: "mcp-remove", name: "files" });
    const result = await service.apply(LOCAL, { planId: plan.planId, digest: plan.digest });
    expect(result).toMatchObject({ status: "failed", exitCode: 3, timedOut: false });
    expect(records[0]).toMatchObject({ outcome: "failed", commandKind: "mcp-remove" });
  });

  it("refuses an account that is not Claude Code or Codex", async () => {
    const { service } = make();
    expect(
      await service.list(LOCAL, "80000000-0000-4000-8000-0000000000ff" as never),
    ).toMatchObject({ reason: "unknown-account" });
  });
});

describe("the journal record of a change", () => {
  it("carries no field a secret could travel in", () => {
    expect(() =>
      decodeProviderToolingAppliedRecord({
        provider: "claude",
        providerInstanceId: CLAUDE_ID,
        commandKind: "mcp-add-url",
        outcome: "succeeded",
        usedSecret: true,
        secret: SECRET,
      }),
    ).toThrow();
  });
});

describe("the provider process runner", () => {
  it("stops a command that runs too long and reports the timeout", async () => {
    const sleeper = join(bin, "sleeper");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 30\n");
    chmodSync(sleeper, 0o755);
    const result = await runProviderToolingProcess({
      binary: sleeper,
      argv: [],
      environment: { PATH: "/usr/bin:/bin" },
      cwd: root,
      timeoutMs: 200,
      outputLimitBytes: 1024,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
  });

  it("caps what a command prints", async () => {
    const loud = join(bin, "loud");
    writeFileSync(loud, "#!/bin/sh\nyes aaaaaaaaaaaaaaaaaaaaaaaa | head -c 100000\n");
    chmodSync(loud, 0o755);
    const result = await runProviderToolingProcess({
      binary: loud,
      argv: [],
      environment: { PATH: "/usr/bin:/bin" },
      cwd: root,
      timeoutMs: 5000,
      outputLimitBytes: 2048,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(2048);
  });

  it("reports a program that cannot start without throwing", async () => {
    const result = await runProviderToolingProcess({
      binary: join(root, "missing"),
      argv: [],
      environment: {},
      cwd: root,
      timeoutMs: 1000,
      outputLimitBytes: 1024,
    });
    expect(result).toMatchObject({ startFailed: true, exitCode: null });
  });
});

function installedBinary(name: string): string | undefined {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

describe.skipIf(installedBinary("claude") === undefined || installedBinary("codex") === undefined)(
  "against the installed command line tools",
  () => {
    it(
      "lists, adds, and removes a local server in throwaway folders",
      { timeout: 120_000 },
      async () => {
        const claudeBinary = installedBinary("claude") as string;
        const codexBinary = installedBinary("codex") as string;
        const records: ProviderToolingAppliedRecord[] = [];
        const claudeInstance = instance("claude");
        const codexInstance = instance("codex");
        if (claudeInstance.driverKind !== "claude" || codexInstance.driverKind !== "codex") {
          throw new Error("fixture");
        }
        const instances: Record<string, ProviderInstance> = {
          [CLAUDE_ID]: {
            ...claudeInstance,
            configuration: { ...claudeInstance.configuration, binaryPath: claudeBinary },
          },
          [CODEX_ID]: {
            ...codexInstance,
            configuration: { ...codexInstance.configuration, binaryPath: codexBinary },
          },
        };
        const service = new ProviderToolingService({
          readInstance: (id) => instances[String(id)],
          runner: runProviderToolingProcess,
          hostEnvironment: () => ({
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? root,
          }),
          homeDirectory: root,
          workingDirectory: join(root, "work"),
          record: (change) => records.push(change),
        });
        for (const id of [CLAUDE_ID, CODEX_ID]) {
          const before = await service.list(LOCAL, id as never);
          expect(before.status).toBe("listed");
          const request: ProviderToolingRequest = {
            kind: "mcp-add-stdio",
            name: "octant-probe",
            command: "/bin/echo",
            args: ["hi there", "--flag"],
            env: [],
          };
          const add = await planned(service, id, request);
          expect(
            await service.apply(LOCAL, { planId: add.planId, digest: add.digest }),
          ).toMatchObject({
            status: "applied",
          });
          const listed = await service.list(LOCAL, id as never);
          expect(
            listed.status === "listed" &&
              listed.sections[0]?.entries.some((entry) => entry.name === "octant-probe"),
          ).toBe(true);
          const remove = await planned(service, id, { kind: "mcp-remove", name: "octant-probe" });
          expect(
            await service.apply(LOCAL, { planId: remove.planId, digest: remove.digest }),
          ).toMatchObject({ status: "applied" });
        }
        // The commands changed the throwaway folders, never the host's own.
        expect(existsSync(join(claudeHome, ".claude.json"))).toBe(true);
        expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
        expect(records.map((record) => record.outcome)).toEqual([
          "succeeded",
          "succeeded",
          "succeeded",
          "succeeded",
        ]);
      },
    );
  },
);
