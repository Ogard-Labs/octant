import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
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
import {
  decodeCodeRelativePath,
  decodeCodeTerminalId,
  decodeCodeThread,
  type CodeCheckoutIdentity,
} from "@octant/contracts/code";
import {
  decodeCodeEvidenceReference,
  type CodeEvidenceReference,
  type CodeOperationEventFrame,
} from "@octant/contracts/code-operations";
import { WindowId } from "@octant/contracts/shell";
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
import { CodeContentStore } from "../code/codeContentStore";
import { CodeOperationEventStore } from "../code/codeOperationEventStore";
import { createCodeOperationRuntime } from "../code/codeOperationRuntime";
import { CodeService, type CodePersistencePort } from "../code/codeService";
import { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import { codeTurnExecutionPolicyReader } from "../code/codeTurnExecutionPolicy";
import { CodeProjectAccess } from "../codeProjectAccess";
import { createNativeHarnessAuthority } from "../harness/nativeHarnessAuthority";
import {
  readCodeCheckout,
  readCodeCheckoutAggregateVersion,
  readCodeCheckouts,
  readCodeFileReference,
  readCodeFileReferences,
  readCodeRuntimeWorkAggregateVersion,
  readCodeRuntimeWorks,
  readCodeThread,
  readCodeThreadActivity,
  readCodeThreads,
  readCodeThreadView,
} from "../persistence/codeProjection";
import { readThreadIdModes } from "../persistence/threadIdentity";
import type { PrincipalRouteContext } from "../principalRouteContext";
import {
  bindRemoteCodeTurn,
  remoteCodeCheckoutRoot,
  remoteCodeProjectOf,
  withRemoteCodeCheckouts,
} from "./sshRemoteCodeThreads";
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
import { createRemoteCodeAcpClientTools } from "../code/codeAcpClientTools";
import { makeAcpDriver } from "../providers/acpDriver";
import { placeableAcpProfile } from "../providers/acpPlacement.test-support";
import type { AcpProviderProfile } from "../providers/acpProfiles";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { acquireProviderConnection } from "@octant/provider-sdk/process-placement";
import { runRemotePlacementConformance } from "@octant/provider-sdk/process-placement-conformance";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import type {
  ProviderDriver,
  ProviderPlacedLaunch,
  ProviderPlacedProcess,
  ProviderRemotePlacementPosture,
  ProviderRemoteProcessPlacement,
} from "@octant/provider-sdk/driver";
import { PROVIDER_RUNTIME_EGRESS_AGGREGATE } from "@octant/contracts/ssh-target-events";
import { createProviderRuntimeEgress, type ProviderRuntimeEgress } from "./providerRuntimeEgress";
import { bindSshRemoteHarness, type SshRemoteHarnessOptions } from "./sshRemoteHarness";
import { SshRemoteProjectService } from "./sshRemoteProjectService";
import { SshRemoteTerminalService } from "./sshRemoteTerminalService";
import {
  SshTargetConnectionService,
  type SshTargetConnectionServiceOptions,
  type SshTargetPlacementInput,
} from "./sshTargetConnectionService";
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

/**
 * A reconnect here waits until the test runs it, so a test that kills a
 * session sees exactly the state it asserts; the one that proves reconnecting
 * runs its attempt itself.
 */
const HELD_RECONNECTS: NonNullable<SshTargetConnectionServiceOptions["reconnect"]> = {
  schedule: () => () => undefined,
};

function service(
  buildVersion = developmentBuild,
  runtimeEgress?: ProviderRuntimeEgress,
  reconnect = HELD_RECONNECTS,
) {
  return new SshTargetConnectionService({
    store: openedStore(),
    buildVersion,
    sshExecutable: join(root, "ssh"),
    environment: { PATH: "/usr/bin:/bin" },
    ...(runtimeEgress === undefined ? {} : { runtimeEgress }),
    reconnect,
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

const terminalWindow = Schema.decodeUnknownSync(WindowId)(randomUUID());

function terminalsOn(
  connections: SshTargetConnectionService,
  projects: SshRemoteProjectService,
): SshRemoteTerminalService {
  return new SshRemoteTerminalService({ projects, connections, store: openedStore() });
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

const productWindow = Schema.decodeUnknownSync(WindowId)(randomUUID());
const pairedDevice = Schema.decodeUnknownSync(WindowId)(randomUUID());
const pairedDeviceRequest: PrincipalRouteContext = {
  principal: {
    kind: "remote-device",
    hostId: "local",
    deviceId: String(pairedDevice),
    credentialGeneration: 1,
    origin: "https://device.example",
    protocolVersion: 1,
    capabilityDigest: "a".repeat(64),
    sessionId: randomUUID(),
  } as never,
  scopeId: pairedDevice,
};

/** Which provider a remote-bound thread's turn resolves. */
type ProductProvider = "harness" | "undeclared-runtime" | "declared-runtime" | "placed-acp";

/**
 * This host's product path for a remote-bound Project's threads, wired as
 * the host wires it: the Code service that prepares the Project's checkout
 * and creates threads, and the Code turn runtime that runs their turns,
 * with the remote checkout, the harness's authority over the binding, the
 * remote tool set bound to the target's session, the turn's posture reader,
 * and Project access for a local window bound to the Project or a paired
 * device. Inference is a local model stub answering from `script`; this
 * host's Git ports record every call, so a test can show none was made.
 */
function remoteCodeProduct(input: {
  readonly connections: SshTargetConnectionService;
  readonly project: SshRemoteProject;
  readonly approve: Pick<NativeHarnessApprovalStore, "ask">["ask"];
  readonly provider?: ProductProvider;
  readonly fixturePort?: number;
}) {
  if (journal === undefined) throw new Error("the journal opens before the tests");
  const { journal: events, connection } = journal;
  const store = openedStore();
  const clock = () => new Date().toISOString();
  const tainted = (id: string) =>
    readThreadExternalContentTaint(connection, id).externalContentIngested;
  const ingestion = new ExternalContentIngestionStore({
    journal: events,
    connection,
    uuid: randomUUID,
    clock,
    actor: systemActor,
  });
  const persistence: CodePersistencePort = {
    journal: events,
    readCodeSettings: () => undefined,
    readCodeThread: (id) => readCodeThread(connection, id),
    readThreadIdModes: (id) => readThreadIdModes(connection, id),
    readCodeThreads: () => readCodeThreads(connection),
    readCodeThreadActivity: () => readCodeThreadActivity(connection),
    readCodeRuntimeWorks: (id) => readCodeRuntimeWorks(connection, id),
    readCodeCheckout: (id) => readCodeCheckout(connection, id),
    readCodeCheckoutAggregateVersion: (id) => readCodeCheckoutAggregateVersion(connection, id),
    readCodeCheckouts: () => readCodeCheckouts(connection),
    readCodeFileReference: (id) => readCodeFileReference(connection, id),
    readCodeFileReferences: (id) => readCodeFileReferences(connection, id),
    readCodeThreadView: (id) => readCodeThreadView(connection, id),
  };
  // A local window reaches the Project its workspace names; a paired device
  // reaches any Project this host holds, as for a local Project.
  const access = new CodeProjectAccess({
    readWorkspace: (scope) =>
      String(scope) === String(productWindow)
        ? ({ contextByMode: { code: { projectId: input.project.id } } } as never)
        : undefined,
    hasActiveCodeProject: (id) => store.getProject(String(id)) !== undefined,
    isWindowLive: (scope) => String(scope) === String(productWindow),
  });
  const codeService = new CodeService({
    persistence,
    access: {
      canBrowseProject: (id) => store.getProject(String(id)) !== undefined,
      canAccessProject: (scope, id) => access.canAccessProject(scope, id),
    },
    checkouts: withRemoteCodeCheckouts(store, {
      observe: async () => {
        throw new Error("No local Project is bound in this test.");
      },
    }),
    roots: { resolve: async () => undefined },
    files: {
      open: async () => ({
        status: "failed" as const,
        failure: { category: "unavailable" as const, code: "helper-unavailable" },
      }),
      save: async () => ({
        status: "failed" as const,
        failure: { category: "unavailable" as const, code: "helper-unavailable" },
      }),
    },
    content: new CodeContentStore(),
    uuid: randomUUID,
    clock,
    workingDirectories: { resolve: async () => undefined },
    onWorkingDirectoryChanged: async () => undefined,
    // Every native confirmation is given, so a refusal is the Project's own.
    approvals: { validate: async () => true },
  });
  const rules = new ToolEgressRules({
    journal: events,
    readCodeThread: (id) => {
      const thread = readCodeThread(connection, id as never);
      return thread === undefined
        ? undefined
        : { projectId: String(thread.projectId), commandsProxied: true };
    },
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
    clock,
  });
  const { connections } = input;
  // As in the harness host above: the fixture's public name resolves to a
  // public address, which the target dials as the fixture.
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
  const sessionAuthority = new CodeSessionAuthorityStore();
  const runtimeHolder: { current?: ReturnType<typeof createCodeOperationRuntime> } = {};
  const hostId = "00000000-0000-4000-8000-0000000000ab" as never;
  const composition = createNativeHarnessComposition({
    authority: createNativeHarnessAuthority({
      hostId,
      persistence: {
        readProject: () => undefined,
        readCodeThread: (id) => readCodeThread(connection, id),
        readProviderInstance: () => ({ enabled: true }) as never,
        readChatThread: () => undefined,
      },
      workThreads: { read: () => undefined },
      readThreadTaint: (id) => readThreadExternalContentTaint(connection, id),
      holdsRemoteCodeBinding: (thread) => remoteCodeProjectOf(store, thread) !== undefined,
    }),
    isHarnessProvider: () => true,
    approvals: { ask: input.approve },
    readCodeExecutionPolicy: codeTurnExecutionPolicyReader({
      readCodeThread: (id) => readCodeThread(connection, id),
      codeSessionAuthority: sessionAuthority,
      codeOperationRuntime: {
        threadWithActiveTurnPosture: (thread) =>
          runtimeHolder.current?.threadWithActiveTurnPosture?.(thread) ?? thread,
      },
    }),
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
    hostId,
    readThreadTaint: tainted,
    isChildAuthorityCurrent: () => false,
    recordExternalContentIngestion: (record) => ingestion.record(record),
    uuid: randomUUID,
    clock,
  });
  // The model stub answers each request with the next scripted reply and
  // keeps what it was sent; a provider that is not the harness records
  // whether anything ever acquired it.
  const script: NativeHarnessResponse[] = [];
  const requests: NativeHarnessRequest[] = [];
  const acquired: string[] = [];
  const transport: NativeHarnessTransport = {
    open: async () => ({
      fits: () => true,
      send: async (request) => {
        requests.push(request);
        const next = script.shift();
        if (next === undefined) throw new Error("The model stub ran out of replies.");
        return next;
      },
      release: () => undefined,
    }),
  };
  const provider = input.provider ?? "harness";
  // One store across turns, as the host's journal is, so a later turn takes
  // up the session an earlier one opened.
  const transcripts = new MemoryNativeHarnessTranscriptStore();
  // The ACP driver for a profile that carries a guard and denies a Project
  // entry, as a shipped placeable profile does, counting starts on this host.
  const placedAcp = placedAcpDriver({
    ...placeableAcpProfile,
    process: {
      ...placeableAcpProfile.process,
      guards: { NO_COLOR: "1" },
      forbiddenRootEntries: [".mcp.json"],
    },
  });
  const harnessDriver: ProviderDriver = {
    kind:
      provider === "harness"
        ? "openai-compatible"
        : provider === "undeclared-runtime"
          ? "codex"
          : // An ACP agent's kind, so the turn reaches the runtime path's check.
            "copilot",
    ...(provider === "declared-runtime"
      ? {
          remotePlacement: {
            postures: ["plan", "approval-gated", "auto-accept-edits"],
            appToolTransport: "stdio",
          },
        }
      : {}),
    probe: () => Effect.die(new Error("The test provider is not probed.")),
    acquire: (acquireInput) => {
      acquired.push(acquireInput.projectRoot);
      return provider === "harness"
        ? createNativeHarnessConnection({
            instanceId: harnessInstance,
            driverKind: "openai-compatible",
            projectRoot: acquireInput.projectRoot,
            mode: "code",
            transport,
            transcripts,
            admitTurn: () => undefined,
            clock,
            correlationId: () => randomUUID(),
          })
        : Effect.die(new Error("A runtime that cannot run on the target was launched."));
    },
  };
  const driver: ProviderDriver =
    provider === "placed-acp"
      ? {
          ...placedAcp.driver,
          acquire: (acquireInput) => {
            acquired.push(
              `${acquireInput.projectRoot}${acquireInput.placement === undefined ? "" : " placed"}`,
            );
            return placedAcp.driver.acquire(acquireInput);
          },
        }
      : harnessDriver;
  const threadProvider =
    provider === "placed-acp"
      ? { providerInstanceId: acpInstance, modelId: acpModel }
      : { providerInstanceId: harnessInstance, modelId: harnessModel };
  const evidence = new Map<string, string>();
  const put = (content: string): CodeEvidenceReference => {
    const reference = decodeCodeEvidenceReference({
      contentId: randomUUID(),
      digest: createHash("sha256").update(content).digest("hex"),
      byteLength: Buffer.byteLength(content),
    });
    evidence.set(String(reference.contentId), content);
    return reference;
  };
  const localGit: string[] = [];
  const noted =
    <T>(name: string, answer: T) =>
    async () => {
      localGit.push(name);
      return answer;
    };
  const failed = { status: "failed" as const };
  const runtime = createCodeOperationRuntime({
    persistence: {
      journal: events,
      readCodeRuntimeWorkAggregateVersion: (id) =>
        readCodeRuntimeWorkAggregateVersion(connection, id),
      readCodeThread: (id) => readCodeThread(connection, id),
      readCodeCheckout: (id) => readCodeCheckout(connection, id),
      readReviewFinding: () => undefined,
      readReviewFindings: () => [],
    },
    windowAccess: {
      canAccessProject: (scope, id) => access.canAccessProject(scope, id),
      standingAuthority: (run) => access.standingAuthority(run),
    },
    resolveCheckoutRoot: async (_scope, thread, checkout: CodeCheckoutIdentity) =>
      checkout.kind === "remote-root" ? remoteCodeCheckoutRoot(store, thread) : undefined,
    resolveProviderDriver: () => driver,
    remoteCodeTurn: (turn) =>
      bindRemoteCodeTurn(
        { store, connections: input.connections, composition, uuid: randomUUID },
        turn,
      ),
    supportsAppManagedTools: () => true,
    sessionAuthority,
    credentialResolver: { resolve: async () => undefined },
    resolvePullRequestTarget: async () => undefined,
    reviewFiles: { resolve: () => undefined },
    evidence: {
      put,
      read: async (reference) => evidence.get(String(reference.contentId)),
    },
    gitObservationPort: {
      observe: noted("observe", { status: "unavailable" as const }),
      observeRemotes: noted("remotes", []),
    },
    gitMutationPort: {
      stage: noted("stage", failed),
      unstage: noted("unstage", failed),
      commit: noted("commit", failed),
      push: noted("push", failed),
      discard: noted("discard", failed),
      revertCommit: noted("revert", failed),
      snapshotWorkingTree: noted("checkpoint", failed),
      restoreWorkingTree: noted("restore", failed),
      releaseCheckpoint: async () => {
        localGit.push("release");
      },
    },
    actor: personActor,
    clock,
    uuid: randomUUID,
  });
  runtimeHolder.current = runtime;
  const operations = new CodeOperationEventStore({
    journal: events,
    uuid: randomUUID,
    clock,
    actor: personActor,
  });
  const asScope = <T>(scope: WindowId, run: () => Promise<T>): Promise<T> =>
    String(scope) === String(pairedDevice) ? access.run(pairedDeviceRequest, run) : run();
  return {
    rules,
    script,
    requests,
    acquired,
    localGit,
    /** Every start of the placed ACP agent on this host, which must stay none. */
    localAcpStarts: placedAcp.localStarts,
    /** What the provider said in a turn's frames, read back from the evidence store. */
    said: (frames: ReadonlyArray<CodeOperationEventFrame>) =>
      frames
        .map((frame) =>
          frame.event.kind === "provider-content" && frame.event.channel === "message"
            ? (evidence.get(String(frame.event.content.contentId)) ?? "")
            : "",
        )
        .join(""),
    /** Prepares the Project's checkout and creates a thread on it, as the composer does. */
    createThread: async (
      scope: WindowId,
      executionPolicy: ProviderExecutionPolicy,
    ): Promise<CodeThread> => {
      const prepared = await asScope(scope, () =>
        codeService.execute(scope, {
          kind: "prepare-code-project-checkout",
          projectId: input.project.id,
        }),
      );
      if (prepared.kind !== "checkout-prepared") throw new Error("checkout not prepared");
      expect(prepared.checkout.kind).toBe("remote-root");
      const now = clock();
      const created = await asScope(scope, () =>
        codeService.execute(scope, {
          kind: "create-code-thread",
          thread: decodeCodeThread({
            id: randomUUID(),
            projectId: input.project.id,
            bindingRevisionId: prepared.bindingRevisionId,
            repositoryId: prepared.checkout.repositoryId,
            checkoutId: prepared.checkout.id,
            title: "On the target",
            lifecycle: "active",
            ...threadProvider,
            executionPolicy,
            permissionPersistence: "current-session",
            deliveryTarget: {
              branchIntent: "main",
              remoteName: "origin",
              proposedBaseRepository: "octant/remote-app",
              proposedBaseBranch: "main",
              outcomeKind: "local-implementation",
              confirmedAt: now,
            },
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
        }),
      );
      if (created.kind !== "thread-created") throw new Error("thread not created");
      return created.thread;
    },
    /** Sends one turn through the Code turn runtime and waits for it to settle. */
    runTurn: async (
      scope: WindowId,
      thread: CodeThread,
      prompt: string,
      executionPolicy?: ProviderExecutionPolicy,
    ) => {
      const operationId = randomUUID();
      const started = await asScope(scope, () =>
        runtime.execute(scope, {
          kind: "start-provider-turn",
          operationId,
          threadId: thread.id,
          checkoutId: thread.checkoutId,
          sessionId: randomUUID(),
          prompt: put(prompt),
          ...(executionPolicy === undefined ? {} : { executionPolicy }),
        }),
      );
      const frames = async (): Promise<ReadonlyArray<CodeOperationEventFrame>> => {
        const replay = operations.replay({
          threadId: thread.id,
          operationId: operationId as never,
          afterCursor: 0,
          limit: 256,
        });
        return replay.status === "ok" ? replay.frames : [];
      };
      const settled = (all: ReadonlyArray<CodeOperationEventFrame>) =>
        all.findLast(
          (frame) =>
            frame.event.kind === "operation-state" &&
            (frame.event.state === "completed" ||
              frame.event.state === "interrupted" ||
              frame.event.state === "failed"),
        );
      if (!("state" in started) || started.state === "running") {
        for (let attempt = 0; attempt < 1_200 && settled(await frames()) === undefined;) {
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      // The turn is settled once its runtime let it go, as a window sees it:
      // a placed runtime stops on the target first.
      for (let attempt = 0; attempt < 300 && runtime.turnInProgress?.(String(thread.id));) {
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const all = await frames();
      const end = settled(all)?.event;
      return {
        operationId,
        started,
        state: end?.kind === "operation-state" ? end.state : undefined,
        failure: end?.kind === "operation-state" ? end.failure?.message : undefined,
        frames: all,
      };
    },
    /** Any other Code operation on the thread, which acts on a folder of this host. */
    observeGit: (scope: WindowId, thread: CodeThread) =>
      runtime.execute(scope, {
        kind: "observe-git",
        operationId: randomUUID(),
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        gitOperationId: randomUUID(),
        maxDiffBytes: 4_096,
      }),
    /** Where a fork of the thread through one of its turns would start. */
    forkPoint: (scope: WindowId, thread: CodeThread, throughOperationId: string) =>
      runtime.forkPoint(scope, thread, throughOperationId),
    egressEvents: (threadId: string) =>
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

/**
 * A provider runtime as the loopback target runs it: it reads one JSON
 * request per line and answers each on a line of its own, trying what it is
 * asked (writing, reading, connecting directly, or fetching through its
 * proxy variables) and reporting whether it worked.
 */
const FIXTURE_RUNTIME = String.raw`#!${process.execPath}
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
process.stderr.write("fixture runtime started\n");
const answer = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  let settled = false;
  const done = (ok, detail) => {
    if (settled) return;
    settled = true;
    answer({ id: request.id, ok, detail });
  };
  try {
    switch (request.op) {
      case "echo":
        return done(true, request.text);
      case "env":
        return done(true, process.env[request.name] ?? null);
      case "write":
        fs.writeFileSync(request.path, "written by the runtime");
        return done(true);
      case "write-home":
        fs.writeFileSync(path.join(process.env.HOME, "note"), "home");
        return done(true);
      case "read":
        return done(true, fs.readFileSync(request.path, "utf8"));
      case "list":
        fs.readdirSync(request.path);
        return done(true);
      case "spawn": {
        const started = require("node:child_process").spawnSync(request.path, ["-c", "exit 0"]);
        return started.error === undefined ? done(true, started.status) : done(false, started.error.code);
      }
      case "connect": {
        const socket = net.connect({ host: request.host, port: request.port });
        socket.once("connect", () => { socket.destroy(); done(true); });
        socket.once("error", (error) => done(false, error.code));
        setTimeout(() => { socket.destroy(); done(false, "timeout"); }, 3000);
        return;
      }
      case "fetch": {
        const proxy = new URL(process.env.HTTPS_PROXY);
        const credential = Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
        const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
        let received = "";
        let tunneled = false;
        socket.once("error", (error) => done(false, error.code));
        socket.on("data", (chunk) => {
          received += chunk.toString("latin1");
          if (!received.includes("\r\n\r\n")) return;
          const status = received.split("\r\n")[0];
          if (!tunneled) {
            if (!status.includes(" 200 ")) { socket.destroy(); return done(false, received.split("\r\n\r\n")[1] || status); }
            tunneled = true;
            received = "";
            socket.write("GET / HTTP/1.1\r\nHost: " + request.host + "\r\nConnection: close\r\n\r\n");
            return;
          }
          socket.destroy();
          done(true, status);
        });
        socket.write("CONNECT " + request.host + ":443 HTTP/1.1\r\nHost: " + request.host + ":443\r\nProxy-Authorization: Basic " + credential + "\r\n\r\n");
        setTimeout(() => { socket.destroy(); done(false, "timeout"); }, 10000);
        return;
      }
      default:
        return done(false, "unknown");
    }
  } catch (error) {
    done(false, error.code ?? String(error));
  }
});
lines.on("close", () => process.exit(0));
`;

/** The fixture runtime as an executable in `folder`, owned by root, as an installed agent would be. */
function runtimeBinary(folder: string, mode = 0o755): string {
  mkdirSync(folder, { recursive: true, mode });
  chmodSync(folder, mode);
  const path = join(folder, "agent");
  writeFileSync(path, FIXTURE_RUNTIME, { mode: 0o755 });
  return path;
}

const runtimeInstance = decodeProviderInstanceId("80000000-0000-4000-8000-000000000b01");
const placedDriver = {
  remotePlacement: {
    postures: ["plan", "approval-gated", "auto-accept-edits"],
    appToolTransport: "stdio",
  },
} as const;

/**
 * The placement of a runtime on the project's target, with `binary` set as
 * that provider instance's runtime there first, as the person sets it.
 */
function placementFor(
  connections: SshTargetConnectionService,
  project: SshRemoteProject,
  posture: ProviderRemotePlacementPosture,
  binary: string,
  overrides: Partial<SshTargetPlacementInput> = {},
): ProviderRemoteProcessPlacement {
  const session = connections.session(project.targetId);
  if (session === undefined) throw new Error("no session");
  const providerInstanceId = overrides.providerInstanceId ?? runtimeInstance;
  const set = connections.setRuntimeBinary({
    targetId: project.targetId,
    providerInstanceId,
    path: remotePath(binary),
  });
  if (set.status !== "ok") throw new Error(set.message);
  const placed = connections.placement({
    session,
    driver: placedDriver,
    root: project.remoteRoot,
    projectId: String(project.id),
    threadId: randomUUID(),
    providerInstanceId,
    posture,
    permissionPersistence: "current-session",
    currentPosture: () => posture,
    ...overrides,
  });
  if (placed.status !== "placed") throw new Error(placed.failure.message);
  return placed.placement;
}

/** This host's real runtime proxy, journaled, on a Unix socket in its own folder. */
function journaledRuntimeEgress(folder: string): ProviderRuntimeEgress {
  if (journal === undefined) throw new Error("the journal opens before the tests");
  const egressDirectory = join(root, folder);
  mkdirSync(egressDirectory, { recursive: true, mode: 0o700 });
  return createProviderRuntimeEgress({
    journal: journal.journal,
    endpoint: { kind: "unix-socket", parentDirectory: egressDirectory },
    hostActor: systemActor,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
}

/** A launched fixture runtime, its scope, and a way to ask it one thing at a time. */
async function launchRuntime(
  placement: ProviderRemoteProcessPlacement,
  launch: { readonly executable: string; readonly args?: ReadonlyArray<string> } & Pick<
    ProviderPlacedLaunch,
    "accountState"
  >,
) {
  const scope = Effect.runSync(Scope.make());
  const runtime: ProviderPlacedProcess = await Effect.runPromise(
    Scope.extend(placement.launch({ ...launch, args: launch.args ?? [] }), scope),
  );
  let received = "";
  Effect.runFork(
    Stream.runForEach(runtime.output, (chunk) =>
      Effect.sync(() => {
        received += Buffer.from(chunk).toString("utf8");
      }),
    ),
  );
  let next = 0;
  const ask = async (
    request: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly detail?: unknown }> => {
    next += 1;
    const id = next;
    await Effect.runPromise(runtime.write(Buffer.from(`${JSON.stringify({ ...request, id })}\n`)));
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const line = received
        .split("\n")
        .filter((candidate) => candidate.length > 0)
        .map((candidate) => JSON.parse(candidate) as { id: number; ok: boolean; detail?: unknown })
        .find((candidate) => candidate.id === id);
      if (line !== undefined) {
        return line.detail === undefined ? { ok: line.ok } : { ok: line.ok, detail: line.detail };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`the runtime did not answer ${JSON.stringify(request)}`);
  };
  return {
    runtime,
    ask,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

function currentSession(
  connections: SshTargetConnectionService,
  targetId: SshTargetStatus["target"]["id"],
) {
  const session = connections.session(targetId);
  if (session === undefined) throw new Error("no session");
  return session;
}

/** Why a launch through the placement failed, or undefined when it started. */
async function launchFailure(
  placement: ProviderRemoteProcessPlacement,
  executable: string,
): Promise<string | undefined> {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(placement.launch({ executable, args: [] })),
  );
  if (Exit.isSuccess(exit)) return undefined;
  return exit.cause._tag === "Fail" ? exit.cause.error.message : "failed";
}

function reasons(status: SshTargetStatus): ReadonlyArray<string> {
  return status.admission.map((entry) =>
    entry.decision.status === "admitted" ? "admitted" : entry.decision.reason,
  );
}

/**
 * An ACP agent as the loopback target runs it: it negotiates ACP, opens
 * sessions in the folder it is given, and on each prompt does what the
 * prompt names. `hello` answers with its working folder and the account
 * state its variable points at; `write <path>`, `read <path>`, and `run
 * <command line>` ask the client for that file or terminal, whatever the
 * client said it offers, and report the answer; `env <name>` reports a
 * variable it was started with, and `peek <path>` reads a file itself, as an
 * agent loading its Project's configuration would.
 */
const FIXTURE_ACP_AGENT = String.raw`#!${process.execPath}
"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let nextId = 0;
const pending = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    send({ id: nextId, method, params });
  });
const say = (sessionId, text) =>
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
const outcome = (answer) => (answer.error === undefined ? "ok" : "refused " + answer.error.message);
const options = { model: "agent-k2", mode: "default" };
const configOptions = () => [
  { type: "select", id: "model", name: "Model", currentValue: options.model, options: [{ value: "agent-k2", name: "Agent K2" }] },
  { type: "select", id: "mode", name: "Mode", currentValue: options.mode, options: [{ value: "plan", name: "Plan" }, { value: "default", name: "Default" }] },
];
let sessions = 0;
const sessionFolders = new Map();
async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((part) => part.text).join("");
  const [verb, ...rest] = text.split(" ");
  const argument = rest.join(" ");
  if (verb === "write") {
    say(sessionId, "write: " + outcome(await ask("fs/write_text_file", { sessionId, path: argument, content: "written by the agent" })));
  } else if (verb === "read") {
    const answer = await ask("fs/read_text_file", { sessionId, path: argument });
    say(sessionId, answer.error === undefined ? "read: " + answer.result.content : "read: " + outcome(answer));
  } else if (verb === "run") {
    const created = await ask("terminal/create", { sessionId, command: argument });
    if (created.error !== undefined) {
      say(sessionId, "run: " + outcome(created));
    } else {
      const terminalId = created.result.terminalId;
      const exit = await ask("terminal/wait_for_exit", { sessionId, terminalId });
      const output = await ask("terminal/output", { sessionId, terminalId });
      await ask("terminal/release", { sessionId, terminalId });
      say(sessionId, "run: exit " + String(exit.result.exitCode) + " " + output.result.output);
    }
  } else if (verb === "env") {
    say(sessionId, "env: " + String(process.env[argument]));
  } else if (verb === "peek") {
    let seen;
    try {
      seen = fs.readFileSync(argument, "utf8");
    } catch (error) {
      seen = "unreadable " + error.code;
    }
    say(sessionId, "peek: " + (seen === "" ? "empty" : seen));
  } else {
    say(sessionId, "hello from " + sessionFolders.get(sessionId) + " signed in with " + process.env.FIXTURE_AGENT_HOME);
  }
  send({ id, result: { stopReason: "end_turn" } });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (resolve !== undefined) resolve(message);
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fixture-agent", version: "0.4.2" } } });
  }
  if (method === "session/new") {
    sessions += 1;
    const sessionId = "fixture-session-" + String(sessions);
    sessionFolders.set(sessionId, params.cwd);
    return send({ id, result: { sessionId, configOptions: configOptions() } });
  }
  if (method === "session/load") {
    sessionFolders.set(params.sessionId, params.cwd);
    return send({ id, result: { configOptions: configOptions() } });
  }
  if (method === "session/set_config_option") {
    options[params.configId] = params.value;
    return send({ id, result: { configOptions: configOptions() } });
  }
  if (method === "session/prompt") return void prompt(id, params);
  if (method === "session/close") return send({ id, result: {} });
  if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } });
});
lines.on("close", () => process.exit(0));
`;

const acpInstance = decodeProviderInstanceId("80000000-0000-4000-8000-000000000c01");
const acpSession = decodeProviderSessionId("80000000-0000-4000-8000-000000000c02");
const acpModel = "agent-k2" as ProviderModelId;

/** The ACP agent as an executable in `folder`, owned by root, as an installed agent would be. */
function acpAgentBinary(folder: string): string {
  mkdirSync(folder, { recursive: true, mode: 0o755 });
  const path = join(folder, "fixture-agent");
  writeFileSync(path, FIXTURE_ACP_AGENT, { mode: 0o755 });
  return path;
}

/** The ACP driver for a placeable fixture profile, counting every start on this host. */
function placedAcpDriver(profile: AcpProviderProfile = placeableAcpProfile) {
  let localStarts = 0;
  const registry = new ProviderRuntimeRegistry();
  const driver = makeAcpDriver({
    profile,
    instanceId: acpInstance,
    binaryPath: "/nonexistent/local/fixture-agent",
    managedHome: join(root, "acp-local-home"),
    process: {
      start: () =>
        Effect.sync(() => {
          localStarts += 1;
        }).pipe(
          Effect.zipRight(
            Effect.fail({ category: "unavailable" as const, message: "Not on this host." }),
          ),
        ),
    },
    runtimeRegistry: registry,
  });
  return {
    driver,
    localStarts: () => localStarts,
    released: () => registry.activeSessionCount(acpInstance) === 0,
  };
}

/**
 * One ACP turn on the target as a Code turn runner drives it: the driver
 * acquired with the placement, its session started with the client tools'
 * definitions, each tool request executed through the tool set and
 * answered, and the agent's reply returned.
 */
async function acpTurn(input: {
  readonly driver: ProviderDriver;
  readonly placement: ProviderRemoteProcessPlacement;
  readonly root: string;
  readonly posture: ProviderRemotePlacementPosture;
  readonly tools: AppManagedToolSet;
  readonly prompt: string;
}): Promise<string> {
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* acquireProviderConnection(input.driver, {
          instanceId: acpInstance,
          projectRoot: input.root,
          mode: "code",
          placement: input.placement,
        });
        yield* connection.start({
          sessionId: acpSession,
          modelId: acpModel,
          executionPolicy: input.posture,
          tools: input.tools.definitions,
        });
        const stream = yield* connection.subscribe;
        const collected = yield* Effect.fork(
          stream.pipe(
            Stream.takeUntil(isTerminal),
            Stream.tap((event) =>
              event.kind !== "tool-request"
                ? Effect.void
                : Effect.promise(async () => {
                    const outcome = await input.tools.execute({
                      name: event.toolName,
                      inputJson: event.inputJson,
                    });
                    await Effect.runPromise(
                      connection.answerTool({
                        sessionId: acpSession,
                        requestId: event.requestId,
                        resultJson: JSON.stringify(outcome.result),
                        isError: outcome.isError === true,
                      }),
                    );
                  }).pipe(Effect.forkDaemon, Effect.asVoid),
            ),
            Stream.runCollect,
          ),
        );
        yield* connection.send({
          sessionId: acpSession,
          prompt: input.prompt,
          context: [],
          attachments: [],
          tools: input.tools.definitions,
        });
        const turn = Array.from(yield* Fiber.join(collected));
        yield* connection.stop(acpSession);
        return turn;
      }),
    ),
  );
  const last = events.at(-1);
  if (last?.kind !== "completed") throw new Error(`the ACP turn ended ${JSON.stringify(last)}`);
  return events.map((event) => (event.kind === "text-delta" ? event.text : "")).join("");
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
      // The headless artifact keeps its native pseudo-terminal module beside
      // the bundle, in its own node_modules; so does this one.
      "--external=node-pty",
      `--outfile=${join(root, "executor", "executor.mjs")}`,
    ]);
    chmodSync(join(root, "executor", "executor.mjs"), 0o644);
    mkdirSync(join(root, "executor", "node_modules"), { mode: 0o755 });
    symlinkSync(
      dirname(createRequire(import.meta.url).resolve("node-pty/package.json")),
      join(root, "executor", "node_modules", "node-pty"),
    );
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
    // Nor does it open a terminal or make a worktree there.
    expect(await projects.createWorktree({ projectId, name: "escaped" })).toMatchObject({
      status: "refused",
      reason: "not-admitted",
      decision: { reason: "confinement-canary-escaped" },
    });
    const terminals = terminalsOn(connections, projects);
    const started = await terminals.execute(terminalWindow, {
      kind: "start",
      projectId,
      terminalId: decodeCodeTerminalId(randomUUID()),
      columns: 80,
      rows: 24,
    });
    expect(started).toMatchObject({ kind: "project-terminal-refused", reason: "unavailable" });
    expect(started.kind === "project-terminal-refused" && started.message).toMatch(
      /^Confinement did not hold on the target/u,
    );
    connections.close();
    connections.remove(status.target.id);
  }, 120_000);

  it("opens a confined terminal and a managed worktree on the target, and ends the shell with its session", async () => {
    const parent = join(root, "nobody-projects");
    mkdirSync(parent, { mode: 0o755 });
    chownSync(parent, NOBODY, NOBODY);
    const checkout = join(parent, "service");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "README.md"), "service\n");
    run("git", ["-C", checkout, "init", "-q", "--initial-branch=main"]);
    run("git", ["-C", checkout, "add", "."]);
    run("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Octant",
      "-c",
      "user.email=octant@example.invalid",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    // A hook the checkout names never runs when Octant creates a worktree.
    writeFileSync(
      join(checkout, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\ntouch ${join(root, "hook-ran")}\n`,
      { mode: 0o755 },
    );
    run("chown", ["-R", `${String(NOBODY)}:${String(NOBODY)}`, checkout]);

    const connections = service();
    const status = await register(connections, target("terminals", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    const projects = projectsOn(connections);
    const bound = await projects.bind({
      targetId: status.target.id,
      remoteRoot: remotePath(checkout),
      name: "Service",
    });
    if (bound.status !== "ok") throw new Error("bind refused");
    const projectId = bound.value.id;

    // The worktree is Git's own, beside the root, on its own branch.
    const created = await projects.createWorktree({ projectId, name: "feature" });
    const worktreePath = join(parent, ".octant-worktrees", String(projectId), "feature");
    expect(created).toMatchObject({
      status: "ok",
      value: { name: "feature", branch: "octant/feature", path: worktreePath },
    });
    if (created.status !== "ok") return;
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
    expect(existsSync(join(root, "hook-ran"))).toBe(false);
    expect(statSync(join(parent, ".octant-worktrees")).mode & 0o777).toBe(0o700);
    expect(await projects.gitStatus({ projectId, worktreeId: created.value.id })).toMatchObject({
      status: "ok",
      value: { head: { kind: "branch", name: "octant/feature" } },
    });

    // A shell in the worktree commits there, and cannot write beside it.
    const terminals = terminalsOn(connections, projects);
    const terminalId = decodeCodeTerminalId(randomUUID());
    expect(
      await terminals.execute(terminalWindow, {
        kind: "start",
        projectId,
        terminalId,
        worktreeId: created.value.id,
        columns: 120,
        rows: 30,
      }),
    ).toMatchObject({
      kind: "project-terminal",
      terminal: { state: "running", posture: "approval-gated" },
    });
    const output = async (): Promise<string> => {
      const read = await terminals.execute(terminalWindow, {
        kind: "read-output",
        projectId,
        terminalId,
        afterCharacters: 0,
      });
      return read.kind === "project-terminal" ? (read.output?.text ?? "") : read.message;
    };
    await terminals.execute(terminalWindow, {
      kind: "write",
      projectId,
      terminalId,
      data: [
        "pwd",
        // Each marker is printed by `printf`, so the typed line never matches it.
        "echo made > made.txt && git add made.txt && git -c user.name=O -c user.email=o@example.invalid commit -qm made && printf 'COMMIT-%s\\n' OK",
        `touch ${join(parent, "beside.txt")}`,
        "printf 'END-%s\\n' SCRIPT",
        "",
      ].join("\r"),
    });
    await expect.poll(output, { timeout: 30_000 }).toContain("END-SCRIPT");
    const printed = await output();
    expect(printed).toContain(worktreePath);
    expect(printed).toContain("COMMIT-OK");
    // Outside its folders the shell writes nowhere that reaches the target's disk.
    expect(existsSync(join(parent, "beside.txt"))).toBe(false);
    expect(
      spawnSync(
        "git",
        ["-c", "safe.directory=*", "-C", checkout, "log", "-1", "--format=%s", "octant/feature"],
        {
          encoding: "utf8",
        },
      ).stdout.trim(),
    ).toBe("made");

    await terminals.execute(terminalWindow, {
      kind: "write",
      projectId,
      terminalId,
      data: "exit\r",
    });
    await expect
      .poll(async () => {
        const view = await terminals.execute(terminalWindow, {
          kind: "attach",
          projectId,
          terminalId,
        });
        return view.kind === "project-terminal" ? view.terminal.state : view.reason;
      })
      .toBe("exited");

    // A worktree holding an untracked file is kept; a clean one is removed,
    // and its branch stays.
    writeFileSync(join(worktreePath, "untracked.txt"), "keep me\n");
    chownSync(join(worktreePath, "untracked.txt"), NOBODY, NOBODY);
    expect(await projects.removeWorktree({ worktreeId: created.value.id })).toEqual({
      status: "refused",
      reason: "worktree-dirty",
    });
    rmSync(join(worktreePath, "untracked.txt"));
    expect(await projects.removeWorktree({ worktreeId: created.value.id })).toEqual({
      status: "ok",
      value: null,
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect(projects.listWorktrees()).toEqual([]);

    // A shell's session ends: the shell and what it started die with it.
    const second = decodeCodeTerminalId(randomUUID());
    await terminals.execute(terminalWindow, {
      kind: "start",
      projectId,
      terminalId: second,
      columns: 80,
      rows: 24,
    });
    await terminals.execute(terminalWindow, {
      kind: "write",
      projectId,
      terminalId: second,
      data: "sleep 4243 & printf 'START%s\\n' ED\r",
    });
    await expect
      .poll(async () => {
        const read = await terminals.execute(terminalWindow, {
          kind: "read-output",
          projectId,
          terminalId: second,
          afterCharacters: 0,
        });
        return read.kind === "project-terminal" ? (read.output?.text ?? "") : "";
      })
      .toContain("STARTED");
    expect(processRunning("sleep 4243")).toBe(true);
    connections.close();
    await expect
      .poll(async () => {
        const view = await terminals.execute(terminalWindow, {
          kind: "attach",
          projectId,
          terminalId: second,
        });
        return view.kind === "project-terminal" ? view.terminal.state : view.reason;
      })
      .toBe("interrupted");
    await expect.poll(() => processRunning("sleep 4243"), { timeout: 10_000 }).toBe(false);
    expect(openedStore().runningTerminals()).toEqual([]);
    connections.remove(status.target.id);
  }, 180_000);

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

  it("creates a Code thread in a remote-bound Project and runs its harness turn through the Code turn runtime, reading, editing, testing, and fetching on the target with approvals", async () => {
    const checkout = harnessCheckout("product-app");
    const fixture = createHttpServer((_request, response) => {
      response.end("hello from the fixture\n");
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const fixtureAddress = fixture.address();
    const fixturePort =
      typeof fixtureAddress === "object" && fixtureAddress !== null ? fixtureAddress.port : 0;
    const connections = service();
    const status = await register(connections, target("product", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Product app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const approvals: string[] = [];
      const product = remoteCodeProduct({
        connections,
        project: bound.value,
        approve: async (ask) => {
          approvals.push(ask.toolName);
          return "approved";
        },
        fixturePort,
      });

      // Full access needs remembering for the Project, which a remote-bound
      // Project cannot do yet, so no thread is created holding it.
      await expect(product.createThread(productWindow, "full-access")).rejects.toMatchObject({
        failure: { category: "unauthorized" },
      });
      const thread = await product.createThread(productWindow, "approval-gated");
      expect(
        product.rules.answer({
          threadId: String(thread.id),
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
      const call = (toolCallId: string, toolName: string, args: object) => ({
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(args),
      });
      product.script.push(
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
      );
      const turn = await product.runTurn(productWindow, thread, "Fix add() and run the check.");
      expect(turn.state).toBe("completed");
      expect(toolResult(product.requests, "read-1")).toMatchObject({
        kind: "file",
        path: "math.js",
        lines: ["export const add = (a, b) => a - b;", ""],
      });
      expect(toolResult(product.requests, "edit-1")).toMatchObject({
        kind: "edited",
        path: "math.js",
        replacements: 1,
      });
      // The edit landed in the target's folder, as the target's user.
      expect(readFileSync(join(checkout, "math.js"), "utf8")).toBe(
        "export const add = (a, b) => a + b;\n",
      );
      expect(statSync(join(checkout, "math.js")).uid).toBe(NOBODY);
      const tested = JSON.stringify(toolResult(product.requests, "test-1"));
      expect(tested).toContain("PASS");
      expect(tested).toContain("SSH-HIDDEN");
      const fetched = JSON.stringify(toolResult(product.requests, "net-1"));
      expect(fetched).toContain("hello from the fixture");
      expect(fetched).toContain("blocked:403");
      // Each write and command asked first; reading did not.
      expect(approvals).toEqual(["edit", "bash", "bash"]);
      const summary = product
        .egressEvents(String(thread.id))
        .find(
          (event) =>
            event.eventName === "thread.egress-launch-summarized@1" &&
            summarizesHost(event.payload, "allowed.example.com"),
        );
      expect(summary?.payload).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ host: "allowed.example.com", decision: "allowed" }),
          expect.objectContaining({ host: "blocked.example.com", decision: "refused" }),
        ]),
      });
      // Inference ran here against the path as the target names it, and no
      // Git of this host checkpointed or observed that path, though on this
      // loopback target it is also a folder here.
      expect(product.acquired).toEqual([String(bound.value.remoteRoot)]);
      expect(product.localGit).toEqual([]);
      const started = turn.frames.find((frame) => frame.event.kind === "conversation-turn-started");
      expect(started?.event).not.toHaveProperty("checkpoint");
      // Every other Code operation would act on a folder of this host.
      expect(await product.observeGit(productWindow, thread)).toMatchObject({
        kind: "operation-failed",
        failure: {
          category: "unavailable",
          message: expect.stringContaining("on an SSH target"),
        },
      });
      expect(product.localGit).toEqual([]);
      // Forking captures the checkout as it stands with this host's Git, so a
      // remote thread is not forked: nothing here checkpoints the path.
      expect(await product.forkPoint(productWindow, thread, turn.operationId)).toEqual({
        status: "refused",
        reason: "unavailable",
      });
      expect(product.localGit).toEqual([]);

      // A turn narrowed to Plan is offered no write or command, and what the
      // model asks for anyway changes nothing on the target.
      const asked = product.requests.length;
      product.script.push(
        {
          text: "Changing.",
          toolCalls: [
            call("plan-write", "write", { path: "planned.txt", content: "no" }),
            call("plan-bash", "bash", { command: "touch planned-command" }),
          ],
        },
        { text: "Planned.", toolCalls: [] },
        { text: "Planned.", toolCalls: [] },
      );
      const planned = await product.runTurn(productWindow, thread, "Plan only.", "plan");
      expect(planned.state).toBe("completed");
      const offered = (product.requests[asked]?.tools ?? []).map((tool) => tool.name);
      expect(offered).toContain("read");
      expect(offered).not.toContain("bash");
      expect(offered).not.toContain("edit");
      expect(offered).not.toContain("write");
      expect(existsSync(join(checkout, "planned.txt"))).toBe(false);
      expect(existsSync(join(checkout, "planned-command"))).toBe(false);
      expect(approvals).toEqual(["edit", "bash", "bash"]);
    } finally {
      fixture.close();
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);

  it("refuses a runtime that cannot run on the target before anything launches, and gives a paired device no more than the Project's authority", async () => {
    const checkout = harnessCheckout("refusal-app");
    const connections = service();
    const status = await register(connections, target("refusal", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Refusal app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);

      // A driver that declares no placement is refused with admission's own
      // reason; one that declares it, while the person has set no path for
      // its runtime on this target. Neither is acquired, here or on the target.
      for (const [provider, message] of [
        ["undeclared-runtime", "Octant cannot confine this runtime on an SSH target"],
        ["declared-runtime", "Set where this provider's runtime is on the SSH target"],
      ] as const) {
        const product = remoteCodeProduct({
          connections,
          project: bound.value,
          approve: async () => "approved",
          provider,
        });
        const thread = await product.createThread(productWindow, "approval-gated");
        const turn = await product.runTurn(productWindow, thread, "Run on the target.");
        expect(turn.started).toMatchObject({ kind: "provider-turn-state", state: "failed" });
        expect(JSON.stringify(turn.started)).toContain(message);
        expect(product.acquired).toEqual([]);
        expect(product.localGit).toEqual([]);
      }

      // A paired device reaches the Project's threads, never more: no Full
      // access, and a Plan turn it sends writes and runs nothing.
      const asked: string[] = [];
      const product = remoteCodeProduct({
        connections,
        project: bound.value,
        approve: async (ask) => {
          asked.push(ask.toolName);
          return "approved";
        },
      });
      await expect(product.createThread(pairedDevice, "full-access")).rejects.toMatchObject({
        failure: { category: "unauthorized" },
      });
      const thread = await product.createThread(pairedDevice, "approval-gated");
      product.script.push(
        {
          text: "Changing.",
          toolCalls: [
            {
              toolCallId: "device-write",
              toolName: "write",
              argumentsJson: JSON.stringify({ path: "device.txt", content: "no" }),
            },
            {
              toolCallId: "device-bash",
              toolName: "bash",
              argumentsJson: JSON.stringify({ command: "touch device-command" }),
            },
          ],
        },
        { text: "Done.", toolCalls: [] },
        { text: "Done.", toolCalls: [] },
      );
      const planned = await product.runTurn(pairedDevice, thread, "Change it.", "plan");
      expect(planned.state).toBe("completed");
      const offered = (product.requests[0]?.tools ?? []).map((tool) => tool.name);
      expect(offered).toContain("read");
      expect(offered).not.toContain("bash");
      expect(offered).not.toContain("write");
      expect(existsSync(join(checkout, "device.txt"))).toBe(false);
      expect(existsSync(join(checkout, "device-command"))).toBe(false);
      expect(asked).toEqual([]);
      // A window whose workspace names another Project reaches nothing here.
      const stranger = Schema.decodeUnknownSync(WindowId)(randomUUID());
      await expect(product.createThread(stranger, "approval-gated")).rejects.toMatchObject({
        failure: { category: "unauthorized" },
      });
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);

  it("runs a placed ACP agent's Code turns through the Code turn runtime, started only through the placement with its guard, its Project's denied entry covered, and its client files on the target", async () => {
    const checkout = harnessCheckout("placed-acp-app");
    writeFileSync(join(checkout, ".mcp.json"), '{"servers":"started without approval"}\n');
    run("chown", [`${String(NOBODY)}:${String(NOBODY)}`, join(checkout, ".mcp.json")]);
    const agent = acpAgentBinary(join(root, "acp-bin"));
    const accountFolder = join(root, "nobody-home", ".fixture-agent");
    mkdirSync(accountFolder, { recursive: true, mode: 0o700 });
    chownSync(accountFolder, NOBODY, NOBODY);
    const connections = service(developmentBuild, journaledRuntimeEgress("placed-acp-egress"));
    const status = await register(connections, target("placed-acp", asNobody()));
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Placed ACP app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const remoteRoot = String(bound.value.remoteRoot);
      const set = connections.setRuntimeBinary({
        targetId: status.target.id,
        providerInstanceId: acpInstance,
        path: remotePath(agent),
      });
      if (set.status !== "ok") throw new Error(set.message);
      const product = remoteCodeProduct({
        connections,
        project: bound.value,
        approve: async () => "approved",
        provider: "placed-acp",
      });
      // The remote refusals hold for a placed agent as for the harness: no
      // thread is created holding Full access or Auto-accept edits.
      for (const posture of ["full-access", "auto-accept-edits"] as const) {
        await expect(product.createThread(productWindow, posture)).rejects.toMatchObject({
          failure: { category: "unauthorized" },
        });
      }
      const thread = await product.createThread(productWindow, "approval-gated");
      const said = async (prompt: string, executionPolicy?: ProviderExecutionPolicy) => {
        const turn = await product.runTurn(productWindow, thread, prompt, executionPolicy);
        expect({ state: turn.state, failure: turn.failure, started: turn.started }).toMatchObject({
          state: "completed",
          failure: undefined,
        });
        return product.said(turn.frames);
      };

      // The agent runs in the bound root on the target (which a transcript
      // names as the checkout), signed in with the target's own account
      // state, with its guard set there.
      expect(await said("hello")).toBe(`hello from [CHECKOUT] signed in with ${accountFolder}`);
      expect(await said("env NO_COLOR")).toContain("env: 1");
      // The Project entry its local launch denies is covered on the target
      // too, while the rest of the root stays readable to it.
      expect(await said(`peek ${join(remoteRoot, ".mcp.json")}`)).toMatch(
        /^peek: (?:empty|unreadable )/u,
      );
      expect(await said(`peek ${join(remoteRoot, "math.js")}`)).toContain("peek: export const add");
      // Its client requests are the remote harness's calls on the target.
      expect(await said(`read ${join(remoteRoot, "math.js")}`)).toContain(
        "read: export const add = (a, b) => a - b;",
      );
      expect(await said(`write ${join(remoteRoot, "agent-wrote")}`)).toContain("write: ok");
      expect(readFileSync(join(checkout, "agent-wrote"), "utf8")).toBe("written by the agent");
      expect(statSync(join(checkout, "agent-wrote")).uid).toBe(NOBODY);
      // A turn narrowed to Plan is offered no write, and one asked for anyway
      // changes nothing on the target.
      expect(await said(`write ${join(remoteRoot, "plan-wrote")}`, "plan")).toContain(
        "write: refused",
      );
      expect(existsSync(join(checkout, "plan-wrote"))).toBe(false);

      // Every turn acquired the agent through the placement, against the
      // path as the target names it; nothing started here, and no Git of
      // this host observed the path.
      expect(product.acquired.length).toBe(7);
      expect(new Set(product.acquired)).toEqual(new Set([`${remoteRoot} placed`]));
      expect(product.localAcpStarts()).toBe(0);
      expect(product.localGit).toEqual([]);
      for (let attempt = 0; attempt < 100 && processRunning(agent); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(processRunning(agent)).toBe(false);
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);

  it("stops a remote-bound thread's turn as target-disconnected when the session ends, queues nothing, and runs the next turn once the host reconnected on its own", async () => {
    const checkout = harnessCheckout("product-disconnect-app");
    const due: Array<() => void> = [];
    const connections = service(developmentBuild, undefined, {
      random: () => 0.5,
      schedule: (run) => {
        due.push(run);
        return () => undefined;
      },
    });
    const status = await register(connections, target("product-disconnect", asNobody()));
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Product disconnect app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const product = remoteCodeProduct({
        connections,
        project: bound.value,
        approve: async () => "approved",
      });
      const thread = await product.createThread(productWindow, "approval-gated");
      product.script.push(
        {
          text: "Running.",
          toolCalls: [
            {
              toolCallId: "slow-1",
              toolName: "bash",
              argumentsJson: JSON.stringify({ command: "sleep 41; touch ran-after-disconnect" }),
            },
          ],
        },
        { text: "unused", toolCalls: [] },
      );
      const turn = product.runTurn(productWindow, thread, "Run the slow job.");
      for (let attempt = 0; attempt < 100 && !processRunning("sleep 41"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(processRunning("sleep 41")).toBe(true);
      process.kill(executorProcess(), "SIGKILL");
      const stopped = await turn;
      expect(stopped.state).toBe("interrupted");
      expect(stopped.failure).toContain("target-disconnected");
      for (let attempt = 0; attempt < 50 && processRunning("sleep 41"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(processRunning("sleep 41")).toBe(false);

      // While the host reconnects, a new turn is refused before it launches,
      // saying so.
      expect(connections.list()[0]).toMatchObject({
        connection: "reconnecting",
        reconnect: { status: "waiting", attempt: 1 },
      });
      const refused = await product.runTurn(productWindow, thread, "Again.");
      expect(JSON.stringify(refused.started)).toContain("reconnecting on its own (attempt 1 of 8)");

      // The host reconnects on its own: a new session to the same pinned key
      // attests afresh, and nothing of the stopped turn arrives.
      expect(due).toHaveLength(1);
      due[0]?.();
      for (
        let attempt = 0;
        attempt < 600 && connections.list()[0]?.connection !== "connected";
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(connections.list()[0]).toMatchObject({ connection: "connected" });
      expect(connections.list()[0]?.reconnect).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(existsSync(join(checkout, "ran-after-disconnect"))).toBe(false);

      // The thread is usable again: its next turn runs on the new session.
      // The interrupted turn left its model reply unread; this turn has its own.
      product.script.splice(0);
      product.script.push(
        {
          text: "Back.",
          toolCalls: [
            {
              toolCallId: "back-1",
              toolName: "bash",
              argumentsJson: JSON.stringify({ command: "touch ran-after-reconnect" }),
            },
          ],
        },
        { text: "Done.", toolCalls: [] },
      );
      const again = await product.runTurn(productWindow, thread, "Run it now.");
      expect(again.state).toBe("completed");
      expect(existsSync(join(checkout, "ran-after-reconnect"))).toBe(true);
      expect(existsSync(join(checkout, "ran-after-disconnect"))).toBe(false);
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);

  it("places a runtime in Plan and approval-gated that echoes beside reads and a command, kept to its root and home, reaching public names only through a journaled proxy here", async () => {
    const checkout = harnessCheckout("runtime-app");
    const binary = runtimeBinary(join(root, "runtime-bin"));
    const outsideFolder = join(root, "nobody-elsewhere");
    mkdirSync(outsideFolder, { mode: 0o700 });
    chownSync(outsideFolder, NOBODY, NOBODY);
    const accountFolder = join(root, "nobody-home", ".agent-state");
    mkdirSync(accountFolder, { mode: 0o700 });
    writeFileSync(join(accountFolder, "token"), "signed in on the target");
    run("chown", ["-R", `${String(NOBODY)}:${String(NOBODY)}`, accountFolder]);
    const fixture = createHttpServer((_request, response) => {
      response.end("hello from a public host\n");
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const fixtureAddress = fixture.address();
    const fixturePort =
      typeof fixtureAddress === "object" && fixtureAddress !== null ? fixtureAddress.port : 0;
    if (journal === undefined) throw new Error("the journal opens before the tests");
    const realEgress = journaledRuntimeEgress("host-runtime-egress");
    // The target's resolver has no record for the fixture's names, so the
    // test answers them: the public one with a public address the target
    // then dials the fixture in place of, the other with a private one. The
    // decisions, their records, and the connection from the target are real.
    const runtimeEgress: ProviderRuntimeEgress = {
      start: (scope) =>
        realEgress.start({
          ...scope,
          resolveAll: async (host) =>
            host === "api.provider.example"
              ? [FIXTURE_ADDRESS]
              : host === "private.provider.example"
                ? ["10.20.30.40"]
                : scope.resolveAll(host),
          connect: (destination) =>
            scope.connect(
              destination.address === FIXTURE_ADDRESS
                ? { address: "127.0.0.1", port: fixturePort }
                : destination,
            ),
        }),
    };
    const connections = service(developmentBuild, runtimeEgress);
    const status = await register(connections, target("runtimes", asNobody()));
    expect(reasons(status)).toEqual(["admitted", "admitted", "admitted"]);
    try {
      for (const posture of ["plan", "approval-gated", "auto-accept-edits"] as const) {
        expect(
          connections.admitProviderRuntime(status.target.id, placedDriver, {
            posture,
            permissionPersistence: "current-session",
          }),
        ).toEqual({ status: "admitted" });
      }
      const projects = projectsOn(connections);
      const bound = await projects.bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Runtime app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const accountState = [
        { path: ".agent-state", access: "read-only", variable: "AGENT_STATE" },
      ] as const;
      const sshDirectory = join(root, "nobody-home", ".ssh");

      // Plan: the root read-only, its own home writable, the network only this host's proxy.
      const plan = await launchRuntime(placementFor(connections, bound.value, "plan", binary), {
        executable: binary,
        accountState,
      });
      expect(await plan.ask({ op: "echo", text: "one" })).toEqual({ ok: true, detail: "one" });
      // Reads and a command keep their turn beside the running runtime.
      const [listed, command] = await Promise.all([
        projects.listDirectory({ projectId: bound.value.id }),
        connections.runCommand(
          currentSession(connections, status.target.id),
          {
            posture: "approval-gated",
            permissionPersistence: "current-session",
            subject: { kind: "octant-launch" },
          },
          {
            kind: "run-command",
            root: bound.value.remoteRoot,
            command: "echo beside the runtime",
            posture: "approval-gated",
            network: "none",
            timeoutMs: 30_000,
          },
        ),
      ]);
      expect(listed.status).toBe("ok");
      expect(
        command.status === "replied" &&
          command.reply.kind === "command-ran" &&
          Buffer.from(command.reply.stdout, "base64").toString(),
      ).toBe("beside the runtime\n");
      expect(await plan.ask({ op: "echo", text: "two" })).toEqual({ ok: true, detail: "two" });
      expect(await plan.ask({ op: "write", path: join(checkout, "plan-wrote") })).toMatchObject({
        ok: false,
      });
      expect(await plan.ask({ op: "write-home" })).toEqual({ ok: true });
      expect(await plan.ask({ op: "list", path: sshDirectory })).toMatchObject({ ok: false });
      expect(await plan.ask({ op: "connect", host: "127.0.0.1", port: sshdPort })).toMatchObject({
        ok: false,
      });
      // Its forwarder started it, yet it still starts nothing itself: not its
      // own binary, and not a shell.
      for (const program of [binary, "/bin/sh"]) {
        expect(await plan.ask({ op: "spawn", path: program })).toEqual({
          ok: false,
          detail: "EPERM",
        });
      }
      expect(await plan.ask({ op: "fetch", host: "api.provider.example" })).toEqual({
        ok: true,
        detail: "HTTP/1.1 200 OK",
      });
      const planPrivate = await plan.ask({ op: "fetch", host: "private.provider.example" });
      expect(String(planPrivate.detail)).toContain("private-destination");
      const stateFolder = await plan.ask({ op: "env", name: "AGENT_STATE" });
      expect(stateFolder).toEqual({ ok: true, detail: accountFolder });
      expect(await plan.ask({ op: "read", path: join(accountFolder, "token") })).toEqual({
        ok: true,
        detail: "signed in on the target",
      });
      expect(await plan.ask({ op: "write", path: join(accountFolder, "token") })).toMatchObject({
        ok: false,
      });
      await plan.close();
      expect(await Effect.runPromise(plan.runtime.ended)).toMatchObject({ kind: "exited" });
      expect(existsSync(join(checkout, "plan-wrote"))).toBe(false);

      // Approval-gated: the root writable, the network only this host's proxy.
      const writing = await launchRuntime(
        placementFor(connections, bound.value, "approval-gated", binary),
        { executable: binary, accountState },
      );
      expect(await writing.ask({ op: "write", path: join(checkout, "agent-wrote") })).toEqual({
        ok: true,
      });
      expect(
        await writing.ask({ op: "write", path: join(outsideFolder, "escaped") }),
      ).toMatchObject({ ok: false });
      expect(await writing.ask({ op: "list", path: sshDirectory })).toMatchObject({ ok: false });
      // The writing postures may start programs, so Plan's refusal above is its filter.
      expect(await writing.ask({ op: "spawn", path: binary })).toMatchObject({ ok: true });
      expect(await writing.ask({ op: "connect", host: "127.0.0.1", port: sshdPort })).toMatchObject(
        { ok: false },
      );
      expect(await writing.ask({ op: "fetch", host: "api.provider.example" })).toEqual({
        ok: true,
        detail: "HTTP/1.1 200 OK",
      });
      const privateFetch = await writing.ask({ op: "fetch", host: "private.provider.example" });
      expect(privateFetch).toMatchObject({ ok: false });
      expect(String(privateFetch.detail)).toContain("private-destination");
      const loopbackFetch = await writing.ask({ op: "fetch", host: "127.0.0.1" });
      expect(String(loopbackFetch.detail)).toContain("ip-literal");
      await writing.close();
      expect(readFileSync(join(checkout, "agent-wrote"), "utf8")).toBe("written by the runtime");
      expect(existsSync(join(outsideFolder, "escaped"))).toBe(false);

      // The launch and every decision are journaled on this host, naming the
      // thread's runtime and the target, and never the content.
      const recorded = journal.journal.replayAggregateType({
        aggregateType: PROVIDER_RUNTIME_EGRESS_AGGREGATE,
        afterSequence: 0,
        limit: 1_000,
      });
      const launches = recorded.filter(
        (event) =>
          event.eventName === "provider-runtime-egress.launch-started@1" &&
          (event.payload as { readonly targetId?: unknown }).targetId === status.target.id,
      );
      // One launch each for the Plan and the approval-gated runtime.
      expect(launches).toHaveLength(2);
      for (const launchStarted of launches) {
        const launchSummary = recorded.find(
          (event) =>
            event.eventName === "provider-runtime-egress.launch-summarized@1" &&
            String(event.aggregateId) === String(launchStarted.aggregateId),
        );
        expect(launchSummary?.payload).toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({ host: "api.provider.example", decision: "allowed" }),
          ]),
        });
      }
      const started = launches[1];
      expect(started?.payload).toMatchObject({
        providerInstanceId: runtimeInstance,
        targetId: status.target.id,
      });
      const summary = recorded.find(
        (event) =>
          event.eventName === "provider-runtime-egress.launch-summarized@1" &&
          String(event.aggregateId) === String(started?.aggregateId),
      );
      expect(summary?.payload).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ host: "api.provider.example", decision: "allowed" }),
          expect.objectContaining({
            host: "private.provider.example",
            decision: "refused",
            reason: "private-destination",
          }),
        ]),
      });
    } finally {
      connections.close();
      connections.remove(status.target.id);
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }, 240_000);

  it("refuses a runtime binary inside the root or in a world-writable folder, a linked home, and a fifth runtime", async () => {
    const checkout = harnessCheckout("runtime-refusals");
    const binary = runtimeBinary(join(root, "runtime-bin"));
    const inside = runtimeBinary(join(checkout, "tools"));
    const open = runtimeBinary(join(root, "runtime-open"), 0o777);
    const connections = service(
      developmentBuild,
      journaledRuntimeEgress("runtime-egress-refusals"),
    );
    const status = await register(connections, target("runtime-refusals", asNobody()));
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Refusals",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      expect(
        await launchFailure(placementFor(connections, bound.value, "plan", inside), inside),
      ).toContain("runtime-binary-not-confinable");
      expect(
        await launchFailure(placementFor(connections, bound.value, "plan", open), open),
      ).toContain("runtime-binary-not-confinable");

      // Another instance's home, swapped for a link before it was first made.
      const linkedInstance = decodeProviderInstanceId("80000000-0000-4000-8000-000000000b02");
      const homes = join(root, "nobody-home", ".local", "state", "octant-runtime-homes");
      let folder = join(root, "nobody-home");
      for (const name of [".local", "state", "octant-runtime-homes", String(bound.value.id)]) {
        folder = join(folder, name);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        chownSync(folder, NOBODY, NOBODY);
      }
      symlinkSync(join(root, "nobody-tmp"), join(homes, String(bound.value.id), linkedInstance));
      expect(
        await launchFailure(
          placementFor(connections, bound.value, "plan", binary, {
            providerInstanceId: linkedInstance,
          }),
          binary,
        ),
      ).toContain("runtime-home-not-confinable");

      const plan = placementFor(connections, bound.value, "plan", binary);
      const running = [];
      for (let index = 0; index < 4; index += 1) {
        running.push(await launchRuntime(plan, { executable: binary }));
      }
      expect(await launchFailure(plan, binary)).toContain("busy");
      for (const placed of running) await placed.close();
      // With the four gone, another starts.
      expect(await launchFailure(plan, binary)).toBeUndefined();
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);

  it("ends a placed runtime with its session, and runs nothing of it on the next", async () => {
    const checkout = harnessCheckout("runtime-disconnect");
    const binary = runtimeBinary(join(root, "runtime-bin"));
    const connections = service(
      developmentBuild,
      journaledRuntimeEgress("runtime-egress-disconnect"),
    );
    const status = await register(connections, target("runtime-disconnect", asNobody()));
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "Disconnect",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const marker = `runtime-marker-${randomUUID()}`;
      const placement = placementFor(connections, bound.value, "plan", binary);
      const placed = await launchRuntime(placement, { executable: binary, args: [marker] });
      expect(await placed.ask({ op: "echo", text: "alive" })).toEqual({
        ok: true,
        detail: "alive",
      });
      expect(processRunning(marker)).toBe(true);

      process.kill(executorProcess(), "SIGKILL");
      expect(await Effect.runPromise(placed.runtime.ended)).toEqual({ kind: "lost" });
      for (let attempt = 0; attempt < 100 && processRunning(marker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(processRunning(marker)).toBe(false);

      // A new session attests afresh; the old placement is not carried to it.
      expect((await connections.connect(status.target.id)).status).toBe("ok");
      expect(await launchFailure(placement, binary)).toContain("session");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(processRunning(marker)).toBe(false);
      await placed.close();
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);
  it("places an ACP agent through the ACP driver in every posture it declares, passing placement conformance on the target", async () => {
    const checkout = harnessCheckout("acp-app");
    const agent = acpAgentBinary(join(root, "acp-bin"));
    const accountFolder = join(root, "nobody-home", ".fixture-agent");
    mkdirSync(accountFolder, { recursive: true, mode: 0o700 });
    chownSync(accountFolder, NOBODY, NOBODY);
    const connections = service(developmentBuild, journaledRuntimeEgress("acp-runtime-egress"));
    const status = await register(connections, target("acp-agents", asNobody()));
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "ACP app",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const { driver, localStarts, released } = placedAcpDriver();
      const support = driver.remotePlacement;
      expect(support).toEqual({
        postures: ["plan", "approval-gated", "auto-accept-edits"],
        appToolTransport: "stdio",
      });
      if (support === undefined) throw new Error("the fixture profile is placeable");
      // The host places a runtime in one posture per placement, so the claim
      // is held one declared posture at a time against the real target.
      for (const posture of support.postures) {
        const evidence = await runRemotePlacementConformance({
          driver: { ...driver, remotePlacement: { ...support, postures: [posture] } },
          acquireInput: {
            instanceId: acpInstance,
            projectRoot: bound.value.remoteRoot,
            mode: "code",
          },
          sessionStart: { sessionId: acpSession, modelId: acpModel, executionPolicy: posture },
          turn: { sessionId: acpSession, prompt: "hello", attachments: [], tools: [] },
          target: placementFor(connections, bound.value, posture, agent, {
            providerInstanceId: acpInstance,
            driver,
          }),
          localLaunches: localStarts,
          isReleased: released,
        });
        expect(evidence).toEqual({
          claim: "supported",
          refusedBeforeAnyLaunch: false,
          ranOnTarget: true,
          refusedWithoutLocalFallback: true,
          placedProcessesStopped: true,
        });
      }
      // Every agent it placed stopped with its scope on the target too.
      for (let attempt = 0; attempt < 100 && processRunning(agent); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(processRunning(agent)).toBe(false);
      expect(localStarts()).toBe(0);
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);

  it("routes a placed ACP agent's client file and terminal requests through the executor, refusing a client write in Plan before the executor", async () => {
    const checkout = harnessCheckout("acp-tools");
    const agent = acpAgentBinary(join(root, "acp-bin"));
    const accountFolder = join(root, "nobody-home", ".fixture-agent");
    mkdirSync(accountFolder, { recursive: true, mode: 0o700 });
    chownSync(accountFolder, NOBODY, NOBODY);
    const connections = service(developmentBuild, journaledRuntimeEgress("acp-tools-egress"));
    const status = await register(connections, target("acp-tools", asNobody()));
    try {
      const bound = await projectsOn(connections).bind({
        targetId: status.target.id,
        remoteRoot: remotePath(checkout),
        name: "ACP tools",
      });
      if (bound.status !== "ok") throw new Error(`bind refused: ${bound.reason}`);
      const project = bound.value;
      const { driver, localStarts } = placedAcpDriver();
      // Every request the agent's client tools send to the executor.
      const executorCalls: string[] = [];
      const counted: SshRemoteHarnessOptions["connections"] = {
        admit: (targetId, request) => connections.admit(targetId, request),
        session: (targetId) => connections.session(targetId),
        harnessFile: (session, admission, request) => {
          executorCalls.push(`harness-file ${request.operation.tool}`);
          return connections.harnessFile(session, admission, request);
        },
        runCommand: (session, admission, request, options) => {
          executorCalls.push("run-command");
          return connections.runCommand(session, admission, request, options);
        },
        resolveOnTarget: (session, host) => connections.resolveOnTarget(session, host),
        dialFromTarget: (session, destination) => connections.dialFromTarget(session, destination),
      };
      const turnIn = async (posture: ProviderRemotePlacementPosture, prompt: string) => {
        const hands = bindSshRemoteHarness(
          { connections: counted, uuid: randomUUID },
          {
            project,
            scope: { threadId: randomUUID(), projectId: String(project.id) },
            posture: () => ({ executionPolicy: posture, permissionPersistence: "current-session" }),
            onTargetDisconnected: () => undefined,
          },
        );
        if (hands.status !== "bound") throw new Error(`refused: ${hands.decision.reason}`);
        const tools = createRemoteCodeAcpClientTools({
          root: project.remoteRoot,
          thread: { executionPolicy: posture },
          readExecutionPolicy: () => posture,
          filesystem: hands.filesystem,
          shell: hands.shell,
          uuid: randomUUID,
        });
        try {
          return await acpTurn({
            driver,
            placement: placementFor(connections, project, posture, agent, {
              providerInstanceId: acpInstance,
              driver,
            }),
            root: project.remoteRoot,
            posture,
            tools,
            prompt,
          });
        } finally {
          await tools.close?.();
          hands.release();
        }
      };

      // Plan: the agent asks to write although it was offered no write; the
      // request is refused on this host and never reaches the executor.
      expect(await turnIn("plan", `write ${join(project.remoteRoot, "plan-wrote")}`)).toBe(
        "write: refused Method not found",
      );
      expect(existsSync(join(checkout, "plan-wrote"))).toBe(false);
      expect(executorCalls).toEqual([]);
      // Its reads reach the target's files through the executor.
      expect(await turnIn("plan", `read ${join(project.remoteRoot, "math.js")}`)).toBe(
        "read: export const add = (a, b) => a - b;\n",
      );
      expect(executorCalls).toEqual(["harness-file read"]);

      // Approval-gated: the write and the terminal run on the target, through the executor.
      expect(
        await turnIn("approval-gated", `write ${join(project.remoteRoot, "agent-wrote")}`),
      ).toBe("write: ok");
      expect(readFileSync(join(checkout, "agent-wrote"), "utf8")).toBe("written by the agent");
      expect(await turnIn("approval-gated", "run echo from the target in $PWD")).toBe(
        `run: exit 0 from the target in ${project.remoteRoot}\n`,
      );
      expect(executorCalls).toEqual(["harness-file read", "harness-file write", "run-command"]);
      // The agent runs in the bound root, signed in with the target's own account state.
      expect(await turnIn("approval-gated", "hello")).toBe(
        `hello from ${project.remoteRoot} signed in with ${accountFolder}`,
      );
      expect(localStarts()).toBe(0);
    } finally {
      connections.close();
      connections.remove(status.target.id);
    }
  }, 240_000);
});
