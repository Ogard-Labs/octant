import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Fiber, Schema, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveReportedHostVersion } from "@octant/host-runtime";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  EventActor,
  ToolEgressLaunchId,
  type CodeThread,
  type ProviderExecutionPolicy,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ToolActionAuthority,
} from "@octant/contracts";
import { decodeCodeRelativePath } from "@octant/contracts/code";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { decodeProjectId } from "@octant/contracts/projects";
import type { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import {
  SshDestination,
  SshExecutorPath,
  SshRemotePath,
  type SshTargetStatus,
} from "@octant/contracts/ssh-target";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import type { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import { createNativeHarnessComposition } from "../harness/nativeHarnessComposition";
import {
  ToolEgressRules,
  toolEgressLaunchTaintReference,
} from "../harness/nativeHarnessEgressRules";
import { createNativeHarnessConnection } from "../harness/nativeHarnessLoop";
import { MemoryNativeHarnessTranscriptStore } from "../harness/nativeHarnessTranscriptStore";
import type {
  NativeHarnessRequest,
  NativeHarnessResponse,
  NativeHarnessTransport,
} from "../harness/nativeHarnessTransport";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { bindSshRemoteHarness, type SshRemoteHarnessOptions } from "./sshRemoteHarness";
import { SshRemoteProjectService } from "./sshRemoteProjectService";
import { SshTargetConnectionService } from "./sshTargetConnectionService";
import type { SshTargetStore } from "./sshTargetStore";
import { openSshTargetTestStore } from "./sshTargetStore.test-support";

/**
 * End-to-end evidence for remote SSH targets: the system OpenSSH client, a
 * loopback `sshd` as the target, and the real executor, bundled as the
 * headless artifact bundles it. Each "target" is the same machine reached
 * through a different executor path, a wrapper that sets up what that target
 * would be like: a non-root user with working bubblewrap, a non-root user
 * whose `/usr/bin/bwrap` is missing or is a fake that confines nothing, or a
 * root login.
 *
 * It runs only as root on Linux with OpenSSH server and bubblewrap installed,
 * because dropping the executor to another user and replacing
 * `/usr/bin/bwrap` inside a private mount namespace both need root. Nothing
 * reads or changes the person's own SSH setup: the client runs with a
 * configuration file of the test's own (`-F`), the server with its own host
 * keys and authorized keys, and the executor with a temporary home.
 */

const SSHD = "/usr/sbin/sshd";
const SSH = "/usr/bin/ssh";
const BWRAP = "/usr/bin/bwrap";
const NOBODY = 65_534;
const runnable =
  process.platform === "linux" &&
  process.getuid?.() === 0 &&
  [SSHD, SSH, BWRAP, "/usr/bin/setpriv", "/usr/bin/unshare", "/run/sshd"].every((path) =>
    existsSync(path),
  );

const executorEntry = fileURLToPath(new URL("./executorMain.ts", import.meta.url));
const destination = Schema.decodeUnknownSync(SshDestination)("127.0.0.1");
const executorPath = Schema.decodeUnknownSync(SshExecutorPath);
const remotePath = Schema.decodeUnknownSync(SshRemotePath);
const developmentBuild = resolveReportedHostVersion({});

let root = "";
let sshd: ChildProcess | undefined;
let sshdPort = 0;
let store: SshTargetStore | undefined;
let journal: { readonly journal: Journal; readonly connection: SqliteConnection } | undefined;
let closeStore = () => {};

function run(command: string, args: ReadonlyArray<string>): void {
  const result = spawnSync(command, [...args], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.error?.message || ""}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("sshd did not start");
}

function startSshd(hostKey: string): void {
  writeFileSync(
    join(root, "sshd_config"),
    [
      `Port ${String(sshdPort)}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${join(root, "authorized_keys")}`,
      `PidFile ${join(root, "sshd.pid")}`,
      "StrictModes no",
      "UsePAM no",
      "PermitRootLogin prohibit-password",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "",
    ].join("\n"),
  );
  sshd = spawn(SSHD, ["-D", "-e", "-f", join(root, "sshd_config")], { stdio: "ignore" });
}

async function stopSshd(): Promise<void> {
  const running = sshd;
  sshd = undefined;
  if (running === undefined || running.exitCode !== null) return;
  await new Promise((resolve) => {
    running.once("close", resolve);
    running.kill("SIGTERM");
  });
}

/** One target: an executor path whose wrapper prepares what that target is like. */
function target(name: string, body: string): ReturnType<typeof executorPath> {
  const directory = join(root, "targets", name);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const path = join(directory, "octant");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return executorPath(path);
}

function asNobody(bwrapReplacement?: string): string {
  const executor = `setpriv --reuid=${String(NOBODY)} --regid=${String(NOBODY)} --clear-groups -- ${process.execPath} ${join(root, "executor", "executor.mjs")}`;
  const environment = `export HOME=${join(root, "nobody-home")} TMPDIR=${join(root, "nobody-tmp")}`;
  if (bwrapReplacement === undefined) return `${environment}\nexec ${executor}`;
  return `${environment}\nexec unshare --mount --propagation private -- /bin/sh -c 'mount --bind ${bwrapReplacement} ${BWRAP} && exec ${executor}'`;
}

function openedStore(): SshTargetStore {
  if (store === undefined) throw new Error("the store opens before the tests");
  return store;
}

function service(buildVersion = developmentBuild) {
  return new SshTargetConnectionService({
    store: openedStore(),
    buildVersion,
    sshExecutable: join(root, "ssh"),
    environment: { PATH: "/usr/bin:/bin" },
  });
}

async function register(
  connections: SshTargetConnectionService,
  path: ReturnType<typeof executorPath>,
): Promise<SshTargetStatus> {
  const probe = await connections.probeHostKey(destination);
  if (probe.status !== "ok") throw new Error(`probe refused: ${probe.reason}`);
  const registered = await connections.register({
    probeId: probe.value.probeId,
    fingerprint: probe.value.fingerprint,
    executorPath: path,
  });
  if (registered.status !== "ok") throw new Error(`registration refused: ${registered.reason}`);
  return registered.value;
}

function projectsOn(connections: SshTargetConnectionService): SshRemoteProjectService {
  return new SshRemoteProjectService({
    store: openedStore(),
    connections,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
}

/**
 * A checkout the target's user owns, with a committed file changed since, an
 * untracked one, and a link that leads out of it to a file beside it.
 */
function remoteCheckout(): string {
  const checkout = join(root, "remote-app");
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  writeFileSync(join(checkout, "src", "main.ts"), "export {};\n");
  const git = (...args: ReadonlyArray<string>) =>
    run("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Octant",
      "-c",
      "user.email=octant@example.invalid",
      ...args,
    ]);
  git("init", "-q", "--initial-branch=main");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  writeFileSync(join(checkout, "README.md"), "hello\nchanged on the target\n");
  writeFileSync(join(checkout, "new.txt"), "untracked\n");
  writeFileSync(join(root, "outside-secret"), "not the checkout's\n");
  symlinkSync(join(root, "outside-secret"), join(checkout, "escape"));
  symlinkSync(checkout, join(root, "remote-link"));
  run("chown", ["-R", `${String(NOBODY)}:${String(NOBODY)}`, checkout]);
  return checkout;
}

/** A checkout with a bug, and a test that fails until it is fixed. */
function harnessCheckout(name: string): string {
  const checkout = join(root, name);
  mkdirSync(checkout);
  writeFileSync(join(checkout, "math.js"), "export const add = (a, b) => a - b;\n");
  writeFileSync(
    join(checkout, "check.sh"),
    "grep -q 'a + b' math.js && echo PASS || { echo FAIL; exit 1; }\n",
  );
  run("chown", ["-R", `${String(NOBODY)}:${String(NOBODY)}`, checkout]);
  return checkout;
}

/** The executor of the session the target holds now, as its runtime directory names it. */
function executorProcess(): number {
  const parent = join(root, "nobody-tmp", `octant-executor-${String(NOBODY)}`);
  const pids = readdirSync(parent)
    .map((name) => /^session-(\d+)-/u.exec(name)?.[1])
    .filter((pid): pid is string => pid !== undefined)
    .map(Number)
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const [pid] = pids;
  if (pids.length !== 1 || pid === undefined) throw new Error(`executors: ${pids.join(",")}`);
  return pid;
}

function processRunning(pattern: string): boolean {
  return spawnSync("pgrep", ["-f", pattern]).status === 0;
}

const harnessInstance = decodeProviderInstanceId("80000000-0000-4000-8000-000000000a01");
const harnessSession = decodeProviderSessionId("80000000-0000-4000-8000-000000000a02");
const harnessModel = "local-model-stub" as ProviderModelId;
const isTerminal = (event: ProviderRuntimeEvent) =>
  event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted";

/**
 * One harness turn as a Code turn runner drives it: the native harness loop
 * over a local model stub that answers from a script and keeps every request
 * it was sent, each tool request executed through the turn's tool set and
 * answered, and the turn interrupted when its target's session ends.
 */
async function harnessTurn(input: {
  readonly tools: AppManagedToolSet;
  readonly script: NativeHarnessResponse[];
  readonly prompt: string;
  /** Receives the turn's interrupt, for the tool set's disconnect to call. */
  readonly interruptible?: (interrupt: () => void) => void;
}): Promise<{
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly requests: ReadonlyArray<NativeHarnessRequest>;
}> {
  const requests: NativeHarnessRequest[] = [];
  const transport: NativeHarnessTransport = {
    open: async () => ({
      fits: () => true,
      send: async (request) => {
        requests.push(request);
        const next = input.script.shift();
        if (next === undefined) throw new Error("The model stub ran out of replies.");
        return next;
      },
      release: () => undefined,
    }),
  };
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* createNativeHarnessConnection({
          instanceId: harnessInstance,
          driverKind: "openai-compatible",
          projectRoot: "/unused-on-this-host",
          mode: "code",
          transport,
          transcripts: new MemoryNativeHarnessTranscriptStore(),
          admitTurn: () => undefined,
          clock: () => new Date().toISOString(),
          correlationId: () => randomUUID(),
        });
        yield* connection.start({
          sessionId: harnessSession,
          modelId: harnessModel,
          executionPolicy: "approval-gated",
          tools: input.tools.definitions,
        });
        const turn = new AbortController();
        input.interruptible?.(() => {
          turn.abort();
          void Effect.runPromise(connection.interrupt(harnessSession)).catch(() => undefined);
        });
        const stream = yield* connection.subscribe;
        const consumed = yield* Effect.fork(
          stream.pipe(
            Stream.takeUntil(isTerminal),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
                if (event.kind !== "tool-request") return;
                void input.tools
                  .execute({
                    name: event.toolName,
                    inputJson: event.inputJson,
                    signal: turn.signal,
                  })
                  .then((outcome) =>
                    Effect.runPromise(
                      connection.answerTool({
                        sessionId: harnessSession,
                        requestId: event.requestId,
                        resultJson: JSON.stringify(outcome.result),
                        isError: outcome.isError === true,
                      }),
                    ),
                  )
                  .catch(() => undefined);
              }),
            ),
          ),
        );
        yield* connection.send({
          sessionId: harnessSession,
          prompt: input.prompt,
          context: [],
          attachments: [],
          tools: input.tools.definitions,
        });
        yield* Fiber.join(consumed);
      }),
    ),
  );
  return { events, requests };
}

/** The result the model was handed for one call, from the request that followed it. */
function toolResult(requests: ReadonlyArray<NativeHarnessRequest>, toolCallId: string): unknown {
  for (const request of requests) {
    for (const message of request.history) {
      const found = message.toolResults?.find((result) => result.toolCallId === toolCallId);
      if (found !== undefined) return JSON.parse(found.resultJson);
    }
  }
  return undefined;
}

const systemActor = Schema.decodeUnknownSync(EventActor)({
  kind: "system",
  actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const personActor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
});
/** The public address the test names for its fixture; the target dials the fixture instead. */
const FIXTURE_ADDRESS = "93.184.216.10";

/**
 * This host's side of a remote-bound Code thread: the harness composition
 * with the remote tool set, the egress rules and journal its commands'
 * proxies decide and record with, and an approval surface that answers as the
 * test says. The tool authority is the thread's posture now.
 */
function remoteHarnessHost(input: {
  readonly connections: SshTargetConnectionService;
  readonly project: SshRemoteProject;
  readonly posture: () => ProviderExecutionPolicy;
  readonly approve: Pick<NativeHarnessApprovalStore, "ask">["ask"];
  readonly fixturePort?: number;
}) {
  if (journal === undefined) throw new Error("the journal opens before the tests");
  const { journal: events, connection } = journal;
  const thread = {
    id: randomUUID(),
    projectId: input.project.id,
    providerInstanceId: harnessInstance,
    modelId: harnessModel,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  } as unknown as CodeThread;
  const threadId = String(thread.id);
  const tainted = (id: string) =>
    readThreadExternalContentTaint(connection, id).externalContentIngested;
  const ingestion = new ExternalContentIngestionStore({
    journal: events,
    connection,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    actor: systemActor,
  });
  const rules = new ToolEgressRules({
    journal: events,
    readCodeThread: (id) =>
      id === threadId ? { projectId: String(input.project.id), commandsProxied: true } : undefined,
    readThreadTaint: tainted,
    recordLaunchTaint: ({ threadId: marked, launchId }) => {
      const recorded = ingestion.record({
        threadId: marked,
        provenance: { origin: "external-content", sourceLabel: "tool-egress" },
        contentReference: toolEgressLaunchTaintReference(launchId),
        correlationId: launchId,
        authorized: true,
      });
      return recorded.kind === "recorded" || recorded.kind === "already-recorded"
        ? "recorded"
        : "unavailable";
    },
    hostActor: systemActor,
    personActor,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const authority = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    mode: "code",
    projectId: input.project.id,
    providerInstanceId: harnessInstance,
    extension: { kind: "core" },
  } as unknown as ToolActionAuthority;
  const { connections } = input;
  // The target's resolver has no record for the fixture's name, and the
  // proxy refuses a private address, so the test answers the name with a
  // public address and has the target dial the fixture in its place. The
  // decision, its record, and the connection from the target are the real
  // ones.
  const throughFixture: SshRemoteHarnessOptions["connections"] = {
    admit: (targetId, request) => connections.admit(targetId, request),
    session: (targetId) => connections.session(targetId),
    harnessFile: (session, admission, request) =>
      connections.harnessFile(session, admission, request),
    runCommand: (session, admission, request, options) =>
      connections.runCommand(session, admission, request, options),
    resolveOnTarget: async (session, host) =>
      host === "allowed.example.com"
        ? [FIXTURE_ADDRESS]
        : connections.resolveOnTarget(session, host),
    dialFromTarget: (session, destination) =>
      connections.dialFromTarget(
        session,
        destination.address === FIXTURE_ADDRESS && input.fixturePort !== undefined
          ? { address: "127.0.0.1", port: input.fixturePort }
          : destination,
      ),
  };
  const egressDirectory = join(root, "host-egress");
  mkdirSync(egressDirectory, { recursive: true, mode: 0o700 });
  const composition = createNativeHarnessComposition({
    authority: {
      resolve: () => authority,
      service: new ToolCallAuthorityService({
        resolveGrantedAuthority: () => authority,
        resolveLiveFacts: () => ({
          providerAppManagedTools: "supported",
          host: { computerUseEnabled: false },
          executionPolicy: input.posture(),
          approvalSatisfied: input.posture() === "full-access",
          externalContentIngested: tainted(threadId),
        }),
      }),
    },
    isHarnessProvider: () => true,
    approvals: { ask: input.approve },
    readCodeExecutionPolicy: () => input.posture(),
    remoteHarness: (bind) =>
      bindSshRemoteHarness(
        {
          connections: throughFixture,
          egress: {
            startLaunch: (launch) => rules.startLaunch(launch),
            endpoint: { kind: "unix-socket", parentDirectory: egressDirectory },
            launchId: () => Schema.decodeUnknownSync(ToolEgressLaunchId)(randomUUID()),
          },
          uuid: randomUUID,
        },
        bind,
      ),
    hostId: authority.hostId,
    readThreadTaint: tainted,
    isChildAuthorityCurrent: () => false,
    recordExternalContentIngestion: (record) => ingestion.record(record),
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  return {
    thread,
    rules,
    composition,
    egressEvents: () =>
      events
        .replayAggregateType({ aggregateType: "thread-egress", afterSequence: 0, limit: 1_000 })
        .filter((event) => String(event.aggregateId) === threadId),
  };
}

/** Whether a launch summary has an entry for exactly this host. */
function summarizesHost(payload: unknown, host: string): boolean {
  if (typeof payload !== "object" || payload === null || !("entries" in payload)) return false;
  const { entries } = payload;
  return (
    Array.isArray(entries) &&
    entries.some(
      (entry: unknown) =>
        typeof entry === "object" && entry !== null && "host" in entry && entry.host === host,
    )
  );
}

function reasons(status: SshTargetStatus): ReadonlyArray<string> {
  return status.admission.map((entry) =>
    entry.decision.status === "admitted" ? "admitted" : entry.decision.reason,
  );
}

describe.skipIf(!runnable)("SSH targets against a loopback sshd", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "octant-ssh-loopback-"));
    chmodSync(root, 0o755);
    for (const key of ["host-key", "host-key-rotated", "user-key"]) {
      run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, key)]);
    }
    writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "user-key.pub")));
    sshdPort = await freePort();
    writeFileSync(
      join(root, "client_config"),
      [
        "Host *",
        `  Port ${String(sshdPort)}`,
        "  User root",
        `  IdentityFile ${join(root, "user-key")}`,
        "  IdentitiesOnly yes",
        "",
      ].join("\n"),
    );
    // The person's configuration in this test is the test's own file.
    writeFileSync(
      join(root, "ssh"),
      `#!/bin/sh\nexec ${SSH} -F ${join(root, "client_config")} "$@"\n`,
      {
        mode: 0o700,
      },
    );
    for (const directory of ["nobody-home", "nobody-home/.ssh", "nobody-tmp"]) {
      mkdirSync(join(root, directory), { mode: 0o700 });
      chownSync(join(root, directory), NOBODY, NOBODY);
    }
    mkdirSync(join(root, "root-home", ".ssh"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "root-tmp"), { mode: 0o700 });
    writeFileSync(join(root, "bwrap-not-executable"), "", { mode: 0o644 });
    writeFileSync(
      join(root, "bwrap-confines-nothing"),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--" ]; then shift; exec "$@"; fi\n  shift\ndone\nexit 0\n',
      { mode: 0o755 },
    );
    mkdirSync(join(root, "executor"), { mode: 0o755 });
    run("bun", [
      "build",
      executorEntry,
      "--target=node",
      "--format=esm",
      `--outfile=${join(root, "executor", "executor.mjs")}`,
    ]);
    chmodSync(join(root, "executor", "executor.mjs"), 0o644);
    // A data directory with a space, as macOS's Application Support is.
    const opened = openSshTargetTestStore(root, join(root, "Application Support"));
    store = opened.store;
    journal = { journal: opened.journal, connection: opened.connection };
    closeStore = () => opened.connection.close();
    startSshd(join(root, "host-key"));
    await waitForPort(sshdPort);
  }, 120_000);

  afterAll(async () => {
    await stopSshd();
    closeStore();
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("attests a non-root target with working bubblewrap and admits every confined posture", async () => {
    const connections = service();
    const status = await register(connections, target("confined", asNobody()));
    expect(status).toMatchObject({
      connection: "connected",
      remoteUser: "nobody",
      platform: "linux",
    });
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);

    // The executor and its runtime directory end with the session.
    connections.close();
    const runtimeParent = join(root, "nobody-tmp", `octant-executor-${String(NOBODY)}`);
    for (let attempt = 0; attempt < 50 && readdirSync(runtimeParent).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readdirSync(runtimeParent)).toEqual([]);
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses a target whose bubblewrap is missing", async () => {
    const connections = service();
    const status = await register(
      connections,
      target("no-bwrap", asNobody(join(root, "bwrap-not-executable"))),
    );
    expect(status.connection).toBe("connected");
    expect(reasons(status)).toEqual([
      "confinement-backend-missing",
      "confinement-backend-missing",
      "confinement-backend-missing",
    ]);
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses every posture when a fake confinement lets a canary escape, naming the escape", async () => {
    const connections = service();
    const status = await register(
      connections,
      target("fake-bwrap", asNobody(join(root, "bwrap-confines-nothing"))),
    );
    expect(reasons(status)).toEqual([
      "confinement-canary-escaped",
      "confinement-canary-escaped",
      "confinement-canary-escaped",
    ]);
    expect(status.admission[0]?.decision).toMatchObject({
      reason: "confinement-canary-escaped",
      posture: "plan",
    });
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses an executor of another build without asking it to attest", async () => {
    const connections = service("0.0.0-another-build");
    const status = await register(connections, target("other-build", asNobody()));
    expect(status.connection).toBe("executor-version-mismatch");
    expect(reasons(status)).toEqual([
      "executor-version-mismatch",
      "executor-version-mismatch",
      "executor-version-mismatch",
    ]);
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses a root login", async () => {
    const connections = service();
    const status = await register(
      connections,
      target(
        "root-login",
        `export HOME=${join(root, "root-home")} TMPDIR=${join(root, "root-tmp")}\nexec ${process.execPath} ${join(root, "executor", "executor.mjs")}`,
      ),
    );
    expect(status).toMatchObject({ connection: "connected", remoteUser: "root" });
    expect(reasons(status)).toEqual(["remote-root-user", "remote-root-user", "remote-root-user"]);
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("refuses a changed host key until the person confirms the new one", async () => {
    const connections = service();
    const registered = await register(connections, target("rotated", asNobody()));
    expect(reasons(registered)).toEqual(["admitted", "admitted", "admitted"]);
    connections.close();

    await stopSshd();
    startSshd(join(root, "host-key-rotated"));
    await waitForPort(sshdPort);
    try {
      const reconnected = await connections.connect(registered.target.id);
      expect(reconnected).toMatchObject({
        status: "ok",
        value: { connection: "host-key-changed" },
      });
      if (reconnected.status === "ok") {
        expect(reasons(reconnected.value)).toEqual([
          "host-key-changed",
          "host-key-changed",
          "host-key-changed",
        ]);
      }

      const probe = await connections.probeHostKey(destination);
      if (probe.status !== "ok") throw new Error("probe refused");
      expect(probe.value.fingerprint).not.toBe(registered.fingerprint);
      const repinned = await connections.repin({
        targetId: registered.target.id,
        probeId: probe.value.probeId,
        fingerprint: probe.value.fingerprint,
      });
      expect(repinned).toMatchObject({ status: "ok", value: { connection: "connected" } });
      if (repinned.status === "ok") {
        expect(reasons(repinned.value)).toEqual(["admitted", "admitted", "admitted"]);
      }
    } finally {
      connections.close();
      connections.remove(registered.target.id);
      await stopSshd();
      startSshd(join(root, "host-key"));
      await waitForPort(sshdPort);
    }
  }, 180_000);

  it("binds a remote root on an attested target and reads its files, Git status, and diff from the target", async () => {
    const checkout = remoteCheckout();
    const connections = service();
    const status = await register(connections, target("project-reads", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    const projects = projectsOn(connections);

    // The journal records the folder the executor resolved, not the link.
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(join(root, "remote-link")),
      name: "Remote app",
    });
    expect(bound).toMatchObject({ status: "ok", value: { remoteRoot: checkout } });
    if (bound.status !== "ok") return;
    const projectId = bound.value.id;
    expect(projects.list().map((project) => project.id)).toContain(projectId);

    const listed = await projects.listDirectory({ projectId });
    expect(listed).toMatchObject({ status: "ok", value: { truncated: false } });
    if (listed.status !== "ok") return;
    expect(listed.value.entries).toEqual([
      { kind: "file", path: "new.txt", byteLength: 10 },
      { kind: "file", path: "README.md", byteLength: 28 },
      { kind: "directory", path: "src" },
    ]);
    expect(
      await projects.listDirectory({ projectId, directory: decodeCodeRelativePath("src") }),
    ).toMatchObject({
      status: "ok",
      value: { entries: [{ kind: "file", path: "src/main.ts" }] },
    });

    const read = await projects.readFile({ projectId, path: decodeCodeRelativePath("README.md") });
    expect(read.status === "ok" && Buffer.from(read.value.contentBase64, "base64").toString()).toBe(
      "hello\nchanged on the target\n",
    );
    // The link leads out of the root; the executor refuses it on the target.
    expect(await projects.readFile({ projectId, path: decodeCodeRelativePath("escape") })).toEqual({
      status: "refused",
      reason: "outside-root",
    });

    const gitStatus = await projects.gitStatus({ projectId });
    expect(gitStatus).toMatchObject({
      status: "ok",
      value: { head: { kind: "branch", name: "main" }, truncated: false },
    });
    if (gitStatus.status === "ok") {
      expect(gitStatus.value.entries).toEqual(
        expect.arrayContaining([
          { path: "README.md", index: " ", worktree: "M" },
          { path: "new.txt", index: "?", worktree: "?" },
        ]),
      );
    }
    const diff = await projects.gitDiff({ projectId, path: decodeCodeRelativePath("README.md") });
    expect(diff.status === "ok" && diff.value.text).toContain("+changed on the target");

    // A folder that holds the remote user's ~/.ssh is never bound.
    expect(
      await projects.bind({
        targetId: status.target.id,
        remoteRoot: remotePath(root),
        name: "All",
      }),
    ).toEqual({ status: "refused", reason: "root-not-confinable" });

    // With its session gone, the Project reads nothing until it attests again.
    connections.close();
    expect(await projects.gitStatus({ projectId })).toEqual({
      status: "refused",
      reason: "not-admitted",
      decision: { status: "refused", reason: "target-unreachable" },
    });
    connections.remove(status.target.id);
    expect(await projects.listDirectory({ projectId })).toEqual({
      status: "refused",
      reason: "not-admitted",
      decision: { status: "refused", reason: "target-removed" },
    });
  }, 180_000);

  it("runs no program a hostile checkout's Git configuration names when it reads status and diff", async () => {
    const checkout = join(root, "hostile-app");
    mkdirSync(checkout);
    const git = (...args: ReadonlyArray<string>) =>
      run("git", [
        "-C",
        checkout,
        "-c",
        "user.name=O",
        "-c",
        "user.email=o@example.invalid",
        ...args,
      ]);
    git("init", "-q", "--initial-branch=main");
    writeFileSync(join(checkout, "notes.txt"), "kept\n");
    git("add", ".");
    git("commit", "-q", "-m", "initial");
    // Each program lives in the root, which the confined Git can read, and
    // prints what a diff would show if it ran.
    const program = join(checkout, "hostile.sh");
    writeFileSync(program, "#!/bin/sh\ncat\necho HOSTILE-PROGRAM-RAN\n", { mode: 0o755 });
    writeFileSync(join(checkout, ".gitattributes"), "* filter=hostile diff=hostile\n");
    const included = join(checkout, "included.config");
    writeFileSync(included, `[core]\n\tpager = ${program}\n`);
    writeFileSync(
      join(checkout, ".git", "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tbare = false",
        `\tfsmonitor = ${program}`,
        `\tpager = ${program}`,
        `\thooksPath = ${checkout}`,
        `\tsshCommand = ${program}`,
        "[diff]",
        `\texternal = ${program}`,
        '[diff "hostile"]',
        `\tcommand = ${program}`,
        `\ttextconv = ${program}`,
        '[filter "hostile"]',
        `\tclean = ${program}`,
        `\tsmudge = ${program}`,
        "[pager]",
        `\tdiff = ${program}`,
        `\tstatus = ${program}`,
        "[include]",
        `\tpath = ${included}`,
        '[includeIf "gitdir:/"]',
        `\tpath = ${included}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(checkout, "notes.txt"), "kept\nchanged\n");
    run("chown", ["-R", `${String(NOBODY)}:${String(NOBODY)}`, checkout]);

    const connections = service();
    const status = await register(connections, target("hostile-reads", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    const projects = projectsOn(connections);
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(checkout),
      name: "Hostile",
    });
    if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
    const projectId = bound.value.id;
    try {
      const gitStatus = await projects.gitStatus({ projectId });
      expect(gitStatus).toMatchObject({ status: "ok", value: { head: { name: "main" } } });
      expect(JSON.stringify(gitStatus)).not.toContain("HOSTILE-PROGRAM-RAN");
      for (const path of [undefined, decodeCodeRelativePath("notes.txt")]) {
        const diff = await projects.gitDiff({ projectId, ...(path === undefined ? {} : { path }) });
        expect(diff.status === "ok" && diff.value.text).toContain("+changed");
        expect(JSON.stringify(diff)).not.toContain("HOSTILE-PROGRAM-RAN");
      }
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 180_000);

  it("refuses to bind or read a remote root on a target whose canary escaped", async () => {
    const connections = service();
    const status = await register(
      connections,
      target("fake-bwrap-project", asNobody(join(root, "bwrap-confines-nothing"))),
    );
    const projects = projectsOn(connections);
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(join(root, "remote-app")),
      name: "Remote app",
    });
    expect(bound).toMatchObject({
      status: "refused",
      reason: "not-admitted",
      decision: { reason: "confinement-canary-escaped" },
    });
    // A Project bound while the target attested reads nothing once it does not.
    const projectId = decodeProjectId(randomUUID());
    openedStore().bindProject({
      id: projectId,
      name: "Bound earlier",
      targetId: status.target.id,
      remoteRoot: remotePath(join(root, "remote-app")),
      boundAt: decodeUtcTimestamp(new Date().toISOString()),
    });
    expect(
      await projects.readFile({ projectId, path: decodeCodeRelativePath("README.md") }),
    ).toMatchObject({
      status: "refused",
      reason: "not-admitted",
      decision: { reason: "confinement-canary-escaped" },
    });
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("runs a harness turn's reads, edits, tests, and network on the target with approvals, deciding and journaling its egress here", async () => {
    const checkout = harnessCheckout("harness-app");
    const fixture = createHttpServer((_request, response) => {
      response.end("hello from the fixture\n");
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const fixtureAddress = fixture.address();
    const fixturePort =
      typeof fixtureAddress === "object" && fixtureAddress !== null ? fixtureAddress.port : 0;
    const connections = service();
    const status = await register(connections, target("harness", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Harness app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const approvals: string[] = [];
      let posture: ProviderExecutionPolicy = "approval-gated";
      const host = remoteHarnessHost({
        connections,
        project: bound.value,
        posture: () => posture,
        approve: async (ask) => {
          approvals.push(ask.toolName);
          return "approved";
        },
        fixturePort,
      });
      expect(
        host.rules.answer({
          threadId: String(host.thread.id),
          principal: { kind: "local-window" },
          grants: [
            {
              host: "allowed.example.com",
              port: fixturePort,
              scope: { kind: "thread", lifetime: "1h" },
            },
          ],
        }),
      ).toMatchObject({ kind: "answered" });
      const composed = host.composition.forRemoteCode({
        thread: host.thread,
        project: bound.value,
        windowId: "window",
        onTargetDisconnected: () => undefined,
      });
      if (composed.status !== "composed") throw new Error(`tools refused: ${composed.status}`);
      const call = (toolCallId: string, toolName: string, args: object) => ({
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(args),
      });
      const turn = await harnessTurn({
        tools: composed.tools,
        prompt: "Fix add() and run the check.",
        script: [
          { text: "Reading.", toolCalls: [call("read-1", "read", { path: "math.js" })] },
          {
            text: "Fixing.",
            toolCalls: [
              call("edit-1", "edit", { path: "math.js", oldText: "a - b", newText: "a + b" }),
            ],
          },
          {
            text: "Testing.",
            toolCalls: [
              call("test-1", "bash", {
                command: 'sh check.sh; ls "$HOME/.ssh" >/dev/null 2>&1 || echo SSH-HIDDEN',
              }),
            ],
          },
          {
            text: "Fetching.",
            toolCalls: [
              call("net-1", "bash", {
                command: [
                  `curl -sS --max-time 20 http://allowed.example.com:${String(fixturePort)}/`,
                  `curl -sS -o /dev/null -w 'blocked:%{http_code}\\n' --max-time 20 http://blocked.example.com:${String(fixturePort)}/`,
                ].join("; "),
              }),
            ],
          },
          { text: "Fixed, tested, and fetched.", toolCalls: [] },
        ],
      });
      expect(turn.events.at(-1)?.kind).toBe("completed");

      expect(toolResult(turn.requests, "read-1")).toMatchObject({
        kind: "file",
        path: "math.js",
        lines: ["export const add = (a, b) => a - b;", ""],
      });
      expect(toolResult(turn.requests, "edit-1")).toMatchObject({
        kind: "edited",
        path: "math.js",
        replacements: 1,
      });
      // The edit landed in the target's folder, as the target's user.
      expect(readFileSync(join(checkout, "math.js"), "utf8")).toBe(
        "export const add = (a, b) => a + b;\n",
      );
      expect(statSync(join(checkout, "math.js")).uid).toBe(NOBODY);
      // The check ran on the target, confined: the remote user's ~/.ssh is
      // not there for it.
      const tested = toolResult(turn.requests, "test-1");
      expect(tested).toMatchObject({ status: "ran", exitCode: 0 });
      expect(JSON.stringify(tested)).toContain("PASS");
      expect(JSON.stringify(tested)).toContain("SSH-HIDDEN");
      const fetched = JSON.stringify(toolResult(turn.requests, "net-1"));
      expect(fetched).toContain("hello from the fixture");
      expect(fetched).toContain("blocked:403");
      // Each write and command asked first; reading did not.
      expect(approvals).toEqual(["edit", "bash", "bash"]);

      // This host's proxy decided both destinations and journaled them.
      const recorded = host.egressEvents();
      const names = recorded.map((event) => event.eventName);
      expect(names).toContain("thread.egress-launch-started@1");
      const summary = recorded.find(
        (event) =>
          event.eventName === "thread.egress-launch-summarized@1" &&
          summarizesHost(event.payload, "allowed.example.com"),
      );
      expect(summary?.payload).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({
            host: "allowed.example.com",
            decision: "allowed",
            requests: 1,
          }),
          expect.objectContaining({
            host: "blocked.example.com",
            decision: "refused",
            reason: "no-rule",
          }),
        ]),
      });

      // Plan offers no tool that writes or runs a command on the target.
      posture = "plan";
      const planned = host.composition.forRemoteCode({
        thread: host.thread,
        project: bound.value,
        windowId: "window",
        onTargetDisconnected: () => undefined,
      });
      if (planned.status !== "composed") throw new Error("plan tools refused");
      const offered = planned.tools.definitions.map((definition) => definition.name);
      expect(offered).toContain("read");
      expect(offered).not.toContain("bash");
      expect(offered).not.toContain("edit");
      expect(offered).not.toContain("write");
      planned.release();
      composed.release();
    } finally {
      fixture.close();
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);

  it("interrupts the turn when the target's session ends, withdraws its approval, stops its command, and queues nothing", async () => {
    const checkout = harnessCheckout("disconnect-app");
    const connections = service();
    const status = await register(connections, target("disconnect", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Disconnect app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);

      // A command running when the session ends dies with it.
      const commandHost = remoteHarnessHost({
        connections,
        project: bound.value,
        posture: () => "approval-gated",
        approve: async () => "approved",
      });
      let disconnected = 0;
      let interrupt: () => void = () => undefined;
      const running = commandHost.composition.forRemoteCode({
        thread: commandHost.thread,
        project: bound.value,
        windowId: "window",
        onTargetDisconnected: () => {
          disconnected += 1;
          interrupt();
        },
      });
      if (running.status !== "composed") throw new Error(`tools refused: ${running.status}`);
      const longCommand = "sleep 37; touch ran-after-disconnect";
      const turn = harnessTurn({
        tools: running.tools,
        prompt: "Run the slow job.",
        interruptible: (stop) => {
          interrupt = stop;
        },
        script: [
          {
            text: "Running.",
            toolCalls: [
              {
                toolCallId: "slow-1",
                toolName: "bash",
                argumentsJson: JSON.stringify({ command: longCommand }),
              },
            ],
          },
          { text: "unused", toolCalls: [] },
        ],
      });
      for (let attempt = 0; attempt < 100 && !processRunning("sleep 37"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(processRunning("sleep 37")).toBe(true);
      process.kill(executorProcess(), "SIGKILL");
      const interrupted = await turn;
      expect(interrupted.events.at(-1)?.kind).toBe("interrupted");
      expect(disconnected).toBe(1);
      for (let attempt = 0; attempt < 50 && processRunning("sleep 37"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(processRunning("sleep 37")).toBe(false);
      expect(connections.session(status.target.id)).toBeUndefined();

      // An approval pending when the session ends is withdrawn, and the
      // command it would have run never runs, on this session or the next.
      expect((await connections.connect(status.target.id)).status).toBe("ok");
      const withdrawn: string[] = [];
      const askedHost = remoteHarnessHost({
        connections,
        project: bound.value,
        posture: () => "approval-gated",
        approve: (ask) =>
          new Promise((resolve) => {
            withdrawn.push("asked");
            ask.signal?.addEventListener("abort", () => {
              withdrawn.push("withdrawn");
              resolve("cancelled");
            });
          }),
      });
      let stopAsked: () => void = () => undefined;
      const asking = askedHost.composition.forRemoteCode({
        thread: askedHost.thread,
        project: bound.value,
        windowId: "window",
        onTargetDisconnected: () => stopAsked(),
      });
      if (asking.status !== "composed") throw new Error(`tools refused: ${asking.status}`);
      const pending = harnessTurn({
        tools: asking.tools,
        prompt: "Mark it.",
        interruptible: (stop) => {
          stopAsked = stop;
        },
        script: [
          {
            text: "Marking.",
            toolCalls: [
              {
                toolCallId: "mark-1",
                toolName: "bash",
                argumentsJson: JSON.stringify({ command: "touch approved-after-disconnect" }),
              },
            ],
          },
          { text: "unused", toolCalls: [] },
        ],
      });
      for (let attempt = 0; attempt < 100 && withdrawn.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      process.kill(executorProcess(), "SIGKILL");
      expect((await pending).events.at(-1)?.kind).toBe("interrupted");
      expect(withdrawn).toEqual(["asked", "withdrawn"]);

      // A new session attests afresh, and nothing of either turn arrives.
      expect((await connections.connect(status.target.id)).status).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(existsSync(join(checkout, "ran-after-disconnect"))).toBe(false);
      expect(existsSync(join(checkout, "approved-after-disconnect"))).toBe(false);
      // The old turn's tools refuse rather than use the new session.
      expect(
        await asking.tools.execute({
          name: "read",
          inputJson: JSON.stringify({ path: "math.js" }),
        }),
      ).toMatchObject({ isError: true });
      running.release();
      asking.release();
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);
});
