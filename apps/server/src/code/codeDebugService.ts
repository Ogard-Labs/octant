import { createHash } from "node:crypto";
import { connect as connectSocket, createServer, type Socket } from "node:net";
import { realpath } from "node:fs/promises";
import type {
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeRelativePath,
  CodeThread,
  CodeThreadId,
  ProjectId,
  WindowId,
} from "@octant/contracts";
import { decodeCodeRelativePath } from "@octant/contracts";
import {
  CODE_DEBUG_CONFIGURATION_AGGREGATE,
  MAX_CODE_DEBUG_APPROVED_CONFIGURATIONS,
  MAX_CODE_DEBUG_BREAKPOINT_FILES,
  MAX_CODE_DEBUG_CHILDREN_AT_ONCE,
  MAX_CODE_DEBUG_CHILDREN_PER_SESSION,
  MAX_CODE_DEBUG_NAME_LENGTH,
  MAX_CODE_DEBUG_MESSAGE_LENGTH,
  MAX_CODE_DEBUG_OUTPUT_ENTRIES,
  MAX_CODE_DEBUG_OUTPUT_TEXT_LENGTH,
  MAX_CODE_DEBUG_SOURCE_LENGTH,
  decodeCodeDebugChildId,
  decodeCodeDebugConfigurationDigest,
  decodeCodeDebugSessionId,
  type CodeDebugApprovalRequest,
  type CodeDebugApprovalResult,
  type CodeDebugApprovedConfiguration,
  type CodeDebugChildId,
  type CodeDebugChildSummary,
  type CodeDebugConfiguration,
  type CodeDebugConfigurationApproved,
  type CodeDebugConfigurationDigest,
  type CodeDebugConfigurationsRequest,
  type CodeDebugConfigurationsResult,
  type CodeDebugExceptionFilter,
  type CodeDebugFileBreakpoints,
  type CodeDebugLaunchFileReading,
  type CodeDebugOutputEntry,
  type CodeDebugRefusalReason,
  type CodeDebugSessionCall,
  type CodeDebugSessionEndReason,
  type CodeDebugSessionId,
  type CodeDebugSessionResult,
  type CodeDebugSessionState,
  type CodeDebugStartRequest,
  type CodeDebugStartResult,
} from "@octant/contracts/code-debug";
import {
  canonicalDebugConfigurationText,
  decideDebugSessionStart,
  proposeDebugConfigurations,
  type DebugAdapterPackageState,
  type DebugConfigurationApproval,
  type DebugSessionHostPlatform,
  type PrincipalKind,
} from "@octant/domain";
import { readConfinedCodeFile } from "./codeConfinedFileRead";
import { liveCodeTestSourcePort, type CodeTestSourcePort } from "./codeDirectoryPort";
import { joinCodePath, resolveContainedPath } from "./codePathConfinement";
import type { CodeFileRootResolution } from "./codeService";
import {
  DebugAdapterConnection,
  type DebugAdapterEvent,
  type DebugAdapterResponse,
} from "./debugAdapterConnection";
import type {
  DebugAdapterLaunchInput,
  DebugAdapterLaunchOutcome,
  DebugAdapterProcess,
  DebugChildEndpoint,
} from "./debugAdapterProcess";
import type { DebugSessionRecords } from "./debugSessionRecords";
import {
  adapterText,
  boundText,
  toBreakpoints,
  toEvaluated,
  toExceptionFilters,
  toExceptionInfo,
  toScopes,
  toStackFrames,
  toThreads,
  toVariables,
} from "./debugSessionResults";
import type { CodeDebugAdapterComponent } from "./installedDebugAdapters";
import { EXTENSION_AGGREGATE_TYPE } from "../persistence/extensionProjection";
import type { Journal } from "../persistence/journal";
import { LINUX_EGRESS_FORWARDER_PORT } from "../process/proxiedNetworkEgress";

/**
 * Debug sessions for Code threads. Canonical:
 * docs/design/language-services.md § Debugger addendum.
 *
 * Only the person at a local window whose Project binding holds the thread
 * lists configurations, confirms one, starts a session, controls it, or
 * stops it; every request is authorized when it runs, a paired device and an
 * agent never are. A session starts only from a configuration an approval on
 * record covers, as the configuration and the adapter stand now, and runs
 * the adapter and the program in one capsule. It ends when the person stops
 * it, when the program or the adapter ends, and at once when the thread stops
 * being active, moves to Plan, changes its session's network level, loses its
 * checkout, or no approval covers the configuration and adapter any more, when
 * the Project is erased, and when the host stops. Nothing restarts it on its
 * own: that would run the program again, which only the person may cause.
 *
 * An adapter that declares children may announce one on the session's own
 * connection (§ Child processes, decision DB9). The host opens a second
 * connection only to the session's own host-chosen child port, `attach`es
 * once with the announced configuration, and lists the child under the
 * session. Every end of the session ends its children first.
 */

export const DEBUG_REQUEST_DEADLINE_MS = 10_000;
/** After `disconnect`, how long the capsule has before its group is stopped. */
export const DEBUG_DISCONNECT_GRACE_MS = 5_000;
export const MAX_DEBUG_SESSIONS_PER_HOST = 4;
/** The bound on the program output a session keeps, as a Project terminal's transcript. */
export const DEBUG_OUTPUT_RING_BYTES = 1024 * 1024;
const LAUNCH_FILE_PATH = ".vscode/launch.json";
const MAX_LAUNCH_FILE_BYTES = 256 * 1024;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_REMEMBERED_ENDINGS = 64;
/** The bound on a child announcement's configuration, as on a `launch` body. */
const MAX_CHILD_CONFIGURATION_BYTES = 8 * 1024;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

export interface CodeDebugAuthority {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  /** A local window's Project binding. */
  readonly canAccessProject: (scopeId: WindowId, projectId: ProjectId) => boolean;
  readonly effectiveThread: (scopeId: WindowId, thread: CodeThread) => CodeThread;
  readonly resolveRoot: (
    scopeId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    relativePath: CodeRelativePath,
  ) => Promise<CodeFileRootResolution | undefined> | CodeFileRootResolution | undefined;
}

export interface CodeDebugCaller {
  readonly scopeId: WindowId;
  readonly principal: PrincipalKind;
}

export interface CodeDebugApprovals {
  readonly approvals: (projectId: ProjectId) => ReadonlyArray<CodeDebugConfigurationApproved>;
  readonly record: (input: {
    readonly projectId: ProjectId;
    readonly checkoutId: CodeCheckoutId;
    readonly configuration: CodeDebugConfiguration;
    readonly configurationDigest: CodeDebugConfigurationDigest;
    readonly adapter: DebugAdapterPackageState;
    readonly scope: CodeDebugApprovalRequest["scope"];
  }) => "recorded" | "not-recorded";
}

export interface CodeDebugServiceOptions {
  readonly authority: CodeDebugAuthority;
  readonly approvals: CodeDebugApprovals;
  /** The `debug-adapter` components effective in Code right now. */
  readonly adapters: () => ReadonlyArray<CodeDebugAdapterComponent>;
  readonly processes: {
    readonly launch: (input: DebugAdapterLaunchInput) => Promise<DebugAdapterLaunchOutcome>;
    /** Whether this host can confine a session's network below Full access. */
    readonly proxies: boolean;
  };
  readonly records: Pick<DebugSessionRecords, "started" | "ended">;
  readonly platform: DebugSessionHostPlatform;
  /** Parent of every session's state folder. */
  readonly stateRoot: string;
  readonly uuid: () => string;
  readonly files?: CodeTestSourcePort;
  /** The loopback port a session that declares one gets; the host picks a free one. */
  readonly choosePort?: () => Promise<number>;
  /** Opens a child connection; tests replace it to see what the host connects to. */
  readonly connectChild?: (endpoint: DebugChildEndpoint, deadlineMs: number) => Promise<Socket>;
  readonly requestDeadlineMs?: number;
  readonly disconnectGraceMs?: number;
}

type Authorized =
  | {
      readonly status: "authorized";
      readonly thread: CodeThread;
      readonly checkout: CodeCheckoutIdentity;
    }
  | { readonly status: "refused"; readonly reason: CodeDebugRefusalReason };

interface ResolvedPaths {
  readonly checkoutRoot: string;
  readonly program: string;
  readonly cwd: string;
}

interface OutputRing {
  readonly entries: Array<CodeDebugOutputEntry & { readonly bytes: number }>;
  bytes: number;
  nextSequence: number;
}

/** What a session and each of its children hold of one DAP connection's program. */
interface DebugTarget {
  connection: DebugAdapterConnection | undefined;
  state: CodeDebugSessionState;
  revision: number;
  exceptionFilters: ReadonlyArray<CodeDebugExceptionFilter>;
  exitCode: number | undefined;
  ending: Promise<void> | undefined;
  readonly initialized: { promise: Promise<void>; resolve: () => void };
}

/** One child process the session attached, on a connection of its own. */
interface ChildRecord extends DebugTarget {
  readonly child: CodeDebugChildId;
  readonly name: string;
  socket: Socket | undefined;
}

interface SessionRecord extends DebugTarget {
  readonly sessionId: CodeDebugSessionId;
  readonly projectId: ProjectId;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly configurationDigest: CodeDebugConfigurationDigest;
  readonly adapter: CodeDebugAdapterComponent;
  readonly network: "proxied" | "allow";
  readonly checkoutRoot: string;
  /**
   * The window whose Start began it. Full access can be that window's own
   * session grant, so the posture a running session keeps is read through it.
   */
  readonly startedBy: WindowId;
  process: DebugAdapterProcess | undefined;
  readonly output: OutputRing;
  /** Requests the adapter made of the host, each refused, by command. */
  readonly refusedRequests: Map<string, number>;
  /** The window's breakpoints as last sent, by file, for each child that attaches later. */
  readonly breakpoints: Map<string, CodeDebugFileBreakpoints>;
  /** The children attached now, by their id. */
  readonly children: Map<number, ChildRecord>;
  /** The host-chosen port a child's announcement must name; absent when no children are declared. */
  childPort: number | undefined;
  /** Children attached over the session's life. */
  childrenAttached: number;
  /** Announcements dropped or refused; those children ran undebugged. */
  undebuggedChildren: number;
}

interface Ending {
  readonly sessionId: CodeDebugSessionId;
  readonly endReason: CodeDebugSessionEndReason;
  readonly exitCode: number | undefined;
}

export class CodeDebugService {
  readonly #authority: CodeDebugAuthority;
  readonly #approvals: CodeDebugApprovals;
  readonly #adapters: () => ReadonlyArray<CodeDebugAdapterComponent>;
  readonly #processes: CodeDebugServiceOptions["processes"];
  readonly #records: CodeDebugServiceOptions["records"];
  readonly #platform: DebugSessionHostPlatform;
  readonly #stateRoot: string;
  readonly #uuid: () => string;
  readonly #files: CodeTestSourcePort;
  readonly #choosePort: () => Promise<number>;
  readonly #connectChild: NonNullable<CodeDebugServiceOptions["connectChild"]>;
  readonly #requestDeadlineMs: number;
  readonly #disconnectGraceMs: number;
  readonly #sessions = new Map<string, SessionRecord>();
  /** The last session each thread ended, so its window can read why. */
  readonly #endings = new Map<string, Ending>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: CodeDebugServiceOptions) {
    this.#authority = options.authority;
    this.#approvals = options.approvals;
    this.#adapters = options.adapters;
    this.#processes = options.processes;
    this.#records = options.records;
    this.#platform = options.platform;
    this.#stateRoot = options.stateRoot;
    this.#uuid = options.uuid;
    this.#files = options.files ?? liveCodeTestSourcePort;
    this.#choosePort = options.choosePort ?? chooseLoopbackPort;
    this.#connectChild = options.connectChild ?? openChildSocket;
    this.#requestDeadlineMs = options.requestDeadlineMs ?? DEBUG_REQUEST_DEADLINE_MS;
    this.#disconnectGraceMs = options.disconnectGraceMs ?? DEBUG_DISCONNECT_GRACE_MS;
  }

  /** How many sessions run now, by thread; for tests and lifecycle counts. */
  get running(): number {
    return this.#sessions.size;
  }

  /** Requests the adapters of running sessions made of the host, all refused, by command. */
  refusedAdapterRequests(sessionId: CodeDebugSessionId): ReadonlyMap<string, number> {
    return new Map(this.#sessions.get(String(sessionId))?.refusedRequests ?? []);
  }

  startSweeping(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.#sweepTimer !== undefined) return;
    this.#sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), intervalMs);
    this.#sweepTimer.unref?.();
  }

  /**
   * What the Run and debug panel lists for the thread: the effective
   * adapters, the configurations an approval covers here as they stand, and
   * the repository launch file's proposals. The file is read for this answer
   * only; nothing in it runs.
   */
  async configurations(
    caller: CodeDebugCaller,
    request: CodeDebugConfigurationsRequest,
  ): Promise<CodeDebugConfigurationsResult> {
    if (caller.principal !== "local-window") return refused("local-host-required");
    const authorized = this.#authorize(caller, request.threadId, request.checkoutId);
    if (authorized.status === "refused") return authorized;
    const adapters = this.#adapters();
    const approved = this.#coveredConfigurations(authorized, adapters);
    const launchFile = await this.#readLaunchFile(
      caller,
      authorized,
      adapters,
      request.currentFile,
    );
    return {
      status: "listed",
      adapters: adapters.slice(0, 64).map((adapter) => ({
        adapter: adapter.adapter,
        displayName: adapter.displayName,
        runtimes: adapter.declaration.runtimes,
        packageName: adapter.packageName,
        packageVersion: adapter.packageVersion,
      })),
      approved,
      launchFile,
    };
  }

  /**
   * The person at a local window confirms one configuration for this
   * checkout or the thread's Project. Every check a start makes runs first,
   * with the confirmation taken as given, so Plan refuses and nothing is
   * recorded for a configuration the thread could not start.
   */
  async approve(
    caller: CodeDebugCaller,
    request: CodeDebugApprovalRequest,
  ): Promise<CodeDebugApprovalResult> {
    if (caller.principal !== "local-window") return refused("local-host-required");
    const authorized = this.#authorize(caller, request.threadId, request.checkoutId);
    if (authorized.status === "refused") return authorized;
    const adapter = this.#adapterFor(request.configuration);
    if (adapter === undefined) return refused("no-debug-adapter");
    const configurationDigest = digestOf(request.configuration);
    const decision = this.#decide(caller, authorized, adapter, configurationDigest, [
      {
        configurationDigest,
        adapter: adapter.packageState,
        scope: { kind: "checkout", checkoutId: authorized.checkout.id },
      },
    ]);
    if (decision.status === "refused") return refused(decision.reason);
    const paths = await this.#resolvePaths(caller, authorized, request.configuration);
    if (paths === undefined) return refused("configuration-invalid");
    const recorded = this.#approvals.record({
      projectId: authorized.thread.projectId,
      checkoutId: authorized.checkout.id,
      configuration: request.configuration,
      configurationDigest,
      adapter: adapter.packageState,
      scope: request.scope,
    });
    if (recorded !== "recorded") return { status: "not-recorded" };
    return { status: "approved", configurationDigest, scope: request.scope };
  }

  /** A person's Start at a local window. Nothing launches until every check passes. */
  async start(
    caller: CodeDebugCaller,
    request: CodeDebugStartRequest,
  ): Promise<CodeDebugStartResult> {
    if (this.#closed) return { status: "failed", reason: "launch-failed" };
    const authorized = this.#authorize(caller, request.threadId, request.checkoutId);
    if (authorized.status === "refused") return authorized;
    const { thread, checkout } = authorized;
    const adapter = this.#adapterFor(request.configuration);
    if (adapter === undefined) return refused("no-debug-adapter");
    const configurationDigest = digestOf(request.configuration);
    const decision = this.#decide(
      caller,
      authorized,
      adapter,
      configurationDigest,
      this.#approvals.approvals(thread.projectId).map(toPolicyApproval),
    );
    if (decision.status === "refused") return refused(decision.reason);
    // Contained again with links followed, as at confirmation: the checkout
    // may have changed under the confirmed configuration since.
    const paths = await this.#resolvePaths(caller, authorized, request.configuration);
    if (paths === undefined) return refused("configuration-invalid");
    // The host may have begun stopping while the paths were read; `close`
    // ends only the sessions it can see, so a Start it cannot see launches
    // nothing.
    if (this.#closed) return { status: "failed", reason: "launch-failed" };
    const network = decision.shape.network === "allow" ? "allow" : "proxied";
    if (network === "proxied" && !this.#processes.proxies) {
      return refused("confinement-unavailable");
    }
    if ([...this.#sessions.values()].some((record) => sameThread(record, thread.id))) {
      return { status: "busy", reason: "thread-has-session" };
    }
    if (this.#sessions.size >= MAX_DEBUG_SESSIONS_PER_HOST) {
      return { status: "busy", reason: "host-limit" };
    }
    const sessionId = decodeCodeDebugSessionId(this.#uuid());
    const record = newRecord({
      sessionId,
      projectId: thread.projectId,
      threadId: thread.id,
      checkoutId: checkout.id,
      configurationDigest,
      adapter,
      network,
      checkoutRoot: paths.checkoutRoot,
      startedBy: caller.scopeId,
    });
    // Held from here, so a second Start on the thread is busy while this one
    // is still launching.
    this.#sessions.set(String(sessionId), record);
    const executable = await adapter.executable().catch(() => undefined);
    if (executable === undefined) {
      this.#sessions.delete(String(sessionId));
      return { status: "failed", reason: "adapter-unverified" };
    }
    // Ended while the binary was verified (the thread moved to Plan, the host
    // is stopping): nothing is journaled as started and nothing launches.
    if (record.ending !== undefined) return { status: "failed", reason: "launch-failed" };
    const started = this.#records.started({
      sessionId,
      projectId: thread.projectId,
      threadId: thread.id,
      checkoutId: checkout.id,
      configurationDigest,
      network,
    });
    if (started !== "recorded") {
      this.#sessions.delete(String(sessionId));
      return { status: "failed", reason: "launch-failed" };
    }
    const ports = await this.#chooseSessionPorts(
      adapter.declaration.debugPorts === 1 ? 1 : 0,
      adapter.declaration.childSessions === 1 ? 2 : 0,
    );
    if (ports === undefined) {
      await this.#end(record, "start-failed");
      return { status: "failed", reason: "launch-failed" };
    }
    const [debugPort] = ports.debug;
    const [childPort, childServerPort] = ports.child;
    const childPorts =
      childPort === undefined || childServerPort === undefined
        ? undefined
        : { child: childPort, childServer: childServerPort };
    for (const file of request.breakpoints) rememberBreakpoints(record, file);
    if (record.ending !== undefined) {
      await record.ending;
      return { status: "failed", reason: "launch-failed" };
    }
    const outcome = await this.#processes.launch({
      sessionId: String(sessionId),
      executable,
      installRoot: adapter.installRoot,
      checkoutRoot: paths.checkoutRoot,
      stateRoot: this.#stateRoot,
      network:
        network === "allow"
          ? { kind: "allow" }
          : {
              kind: "proxied",
              egress: {
                sessionId: String(sessionId),
                projectId: String(thread.projectId),
                threadId: String(thread.id),
              },
            },
      environment: request.configuration.env.map((entry) => ({
        key: String(entry.key),
        value: entry.value,
      })),
      ...(debugPort === undefined ? {} : { debugPort }),
      ...(childPorts === undefined ? {} : { childPorts }),
    });
    if (outcome.status !== "launched") {
      await this.#end(record, "start-failed");
      return outcome.status === "confinement-unavailable"
        ? refused("confinement-unavailable")
        : { status: "failed", reason: "launch-failed" };
    }
    record.process = outcome.process;
    record.childPort = childPorts?.child;
    if (record.ending !== undefined) {
      // Ended while it launched (the thread moved to Plan, the host is
      // stopping); the capsule goes with it.
      await outcome.process.kill();
      return { status: "failed", reason: "launch-failed" };
    }
    const connection = this.#connect(record, outcome.process);
    const ready = await this.#handshake(record, connection, request, paths, debugPort);
    if (!ready) {
      await this.#end(record, "start-failed");
      return { status: "failed", reason: "adapter-refused" };
    }
    return { status: "started", sessionId };
  }

  /** A request on a running session, checked when it runs. */
  async session(
    caller: CodeDebugCaller,
    call: CodeDebugSessionCall,
  ): Promise<CodeDebugSessionResult> {
    if (caller.principal !== "local-window") return refused("local-host-required");
    const authorized = this.#authorize(caller, call.threadId, call.checkoutId);
    if (authorized.status === "refused") return authorized;
    const record = this.#sessions.get(String(call.sessionId));
    if (record === undefined || !sameThread(record, call.threadId)) {
      return this.#endedAnswer(call);
    }
    // A session that is ending answers as ended once it has.
    if (record.ending !== undefined) {
      await record.ending;
      return this.#endedAnswer(call);
    }
    const lapsed = this.#endReasonFor(record);
    if (lapsed !== undefined) {
      await this.#end(record, lapsed);
      return this.#endedAnswer(call);
    }
    let target: SessionRecord | ChildRecord = record;
    if (call.child !== undefined) {
      const child = record.children.get(Number(call.child));
      // A child that has ended, or never was, reads as no session; the panel
      // goes back to the program.
      if (child === undefined || child.ending !== undefined) return refused("no-session");
      target = child;
    }
    const request = call.request;
    switch (request.kind) {
      case "state":
        return this.#stateAnswer(record, target, request.afterOutput ?? 0);
      case "stop":
        if ("child" in target) {
          await this.#endChild(record, target, "stopped");
        } else {
          await this.#end(record, "stopped");
        }
        return { status: "ended", endReason: "stopped" };
      case "set-breakpoints": {
        // The window's breakpoints apply to the program and every child, so
        // each connection gets them; the answer is the named one's.
        rememberBreakpoints(record, request.file);
        const args = breakpointArguments(record.checkoutRoot, request.file);
        for (const other of [record, ...record.children.values()]) {
          if (other !== target) void other.connection?.request("setBreakpoints", args);
        }
        const answered = await this.#ask(record, target, "setBreakpoints", args);
        return answered.status === "answered"
          ? { status: "breakpoints", breakpoints: toBreakpoints(answered.body) }
          : answered;
      }
      case "set-exception-breakpoints": {
        const advertised = new Set(target.exceptionFilters.map((filter) => filter.filter));
        const answered = await this.#ask(record, target, "setExceptionBreakpoints", {
          filters: request.filters.filter((filter) => advertised.has(filter)),
        });
        return answered.status === "answered" ? { status: "done" } : answered;
      }
      case "threads": {
        const answered = await this.#ask(record, target, "threads", undefined);
        return answered.status === "answered"
          ? { status: "threads", threads: toThreads(answered.body, record.checkoutRoot) }
          : answered;
      }
      case "stack-trace": {
        const answered = await this.#ask(record, target, "stackTrace", {
          threadId: request.programThreadId,
          startFrame: request.startFrame ?? 0,
          levels: 200,
        });
        if (answered.status !== "answered") return answered;
        const placed = await toStackFrames(answered.body, {
          checkoutRoot: record.checkoutRoot,
          realpath: (path) => realpath(path),
        });
        return { status: "stack", ...placed };
      }
      case "scopes": {
        const answered = await this.#ask(record, target, "scopes", { frameId: request.frameId });
        return answered.status === "answered"
          ? { status: "scopes", scopes: toScopes(answered.body, record.checkoutRoot) }
          : answered;
      }
      case "variables": {
        const answered = await this.#ask(record, target, "variables", {
          variablesReference: request.variablesReference,
          ...(request.start === undefined ? {} : { start: request.start, count: 200 }),
        });
        return answered.status === "answered"
          ? { status: "variables", ...toVariables(answered.body) }
          : answered;
      }
      case "source": {
        // By reference only: a source the adapter holds, never a path the
        // host would open outside the checkout.
        const answered = await this.#ask(record, target, "source", {
          sourceReference: request.sourceReference,
          source: { sourceReference: request.sourceReference },
        });
        if (answered.status !== "answered") return answered;
        const content = isRecord(answered.body) ? answered.body.content : undefined;
        const bounded = boundText(
          typeof content === "string" ? content : "",
          MAX_CODE_DEBUG_SOURCE_LENGTH,
        );
        return { status: "source", text: bounded.text, truncated: bounded.truncated };
      }
      case "exception-info": {
        const answered = await this.#ask(record, target, "exceptionInfo", {
          threadId: request.programThreadId,
        });
        if (answered.status !== "answered") return answered;
        const info = toExceptionInfo(answered.body, record.checkoutRoot);
        return info === undefined
          ? { status: "unavailable", reason: "failed" }
          : { status: "exception", ...info };
      }
      case "continue":
      case "next":
      case "step-in":
      case "step-out":
      case "pause": {
        const answered = await this.#ask(record, target, STEP_COMMANDS[request.kind], {
          threadId: request.programThreadId,
        });
        return answered.status === "answered" ? { status: "done" } : answered;
      }
      case "evaluate": {
        const answered = await this.#ask(record, target, "evaluate", {
          expression: request.expression,
          context: request.context,
          ...(request.frameId === undefined ? {} : { frameId: request.frameId }),
        });
        if (answered.status !== "answered") return answered;
        const result = toEvaluated(answered.body, request.expression);
        return result === undefined
          ? { status: "unavailable", reason: "failed" }
          : { status: "evaluated", result };
      }
    }
  }

  /**
   * Ends every session that should no longer run. Committed `code-thread`,
   * `code-checkout`, extension, and approval events run it at once, and a
   * timer every minute.
   */
  async sweep(): Promise<void> {
    const ends: Promise<void>[] = [];
    for (const record of this.#sessions.values()) {
      if (record.ending !== undefined) continue;
      const reason = this.#endReasonFor(record);
      if (reason !== undefined) ends.push(this.#end(record, reason));
    }
    await Promise.all(ends);
  }

  /**
   * A thread purge ends the thread's session before the purge takes its
   * records and its managed worktree, so nothing the session writes as it
   * ends (its end record, its egress summary, its proposals) lands after the
   * purge and outlives it.
   */
  async endThread(threadId: CodeThreadId): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()]
        .filter((record) => sameThread(record, threadId))
        .map((record) => this.#end(record, "thread-inactive")),
    );
  }

  /**
   * Ends sessions as soon as a committed `code-thread`, `code-checkout`,
   * extension, or confirmation event could have withdrawn what let them
   * start. The sweep runs after the committing call has finished, not inside
   * its append: a window that moves a thread out of its own session grant of
   * Full access appends the thread's event first and withdraws the grant
   * after, so a sweep inside the append still read Full access and kept the
   * session on the open network.
   */
  endOnAuthorityChanges(journal: Pick<Journal, "subscribeCommitted">): () => void {
    return journal.subscribeCommitted((append) => {
      if (!append.events.some((event) => AUTHORITY_AGGREGATES.has(event.aggregateType))) return;
      setImmediate(() => void this.sweep().catch(() => undefined)).unref?.();
    });
  }

  /** A Project erase ends its sessions at once, whatever else still holds. */
  async endProject(projectId: ProjectId): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()]
        .filter((record) => String(record.projectId) === String(projectId))
        .map((record) => this.#end(record, "project-erased")),
    );
  }

  /** Ends every session, for host shutdown. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    await Promise.all(
      [...this.#sessions.values()].map((record) => this.#end(record, "host-shutdown")),
    );
  }

  #authorize(
    caller: CodeDebugCaller,
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
  ): Authorized {
    const thread = this.#authority.readThread(threadId);
    // A thread the caller cannot reach reads the same as one that does not
    // exist, so a refusal never says which threads are on this host.
    if (
      thread === undefined ||
      !this.#authority.canAccessProject(caller.scopeId, thread.projectId)
    ) {
      return refused("no-reach");
    }
    if (!isActiveThread(thread)) return refused("thread-inactive");
    const effective = this.#authority.effectiveThread(caller.scopeId, thread);
    if (String(effective.checkoutId) !== String(checkoutId)) return refused("checkout-mismatch");
    const checkout = this.#authority.readCheckout(checkoutId);
    if (
      checkout === undefined ||
      String(checkout.repositoryId) !== String(thread.repositoryId) ||
      checkout.availability !== "available"
    ) {
      return refused("checkout-unavailable");
    }
    return { status: "authorized", thread: effective, checkout };
  }

  #adapterFor(configuration: CodeDebugConfiguration): CodeDebugAdapterComponent | undefined {
    return this.#adapters().find(
      (adapter) => String(adapter.adapter) === String(configuration.adapter),
    );
  }

  #decide(
    caller: CodeDebugCaller,
    authorized: Extract<Authorized, { status: "authorized" }>,
    adapter: CodeDebugAdapterComponent,
    configurationDigest: CodeDebugConfigurationDigest,
    approvals: ReadonlyArray<DebugConfigurationApproval>,
  ) {
    return decideDebugSessionStart({
      platform: this.#platform,
      // The authority reads Code threads only.
      mode: "code",
      posture: authorized.thread.executionPolicy,
      startedBy: caller.principal,
      checkoutId: authorized.checkout.id,
      configurationDigest,
      adapter: adapter.packageState,
      approvals,
      // Checked by the host right after, so no path is read for a start the
      // decision refuses.
      configurationPaths: "resolve",
      debugPorts: adapter.declaration.debugPorts,
      adapterRuntimes: adapter.declaration.runtimes.map(String),
    });
  }

  /**
   * The configuration's program (a regular file) and folder (a directory),
   * contained in the checkout with links followed.
   */
  async #resolvePaths(
    caller: CodeDebugCaller,
    authorized: Extract<Authorized, { status: "authorized" }>,
    configuration: CodeDebugConfiguration,
  ): Promise<ResolvedPaths | undefined> {
    let root: CodeFileRootResolution | undefined;
    try {
      root = await this.#authority.resolveRoot(
        caller.scopeId,
        authorized.thread,
        authorized.checkout,
        configuration.program,
      );
    } catch {
      root = undefined;
    }
    if (root === undefined) return undefined;
    const program = await resolveContainedPath(
      this.#files,
      root.rootPath,
      joinCodePath(root.rootPath, configuration.program),
    );
    if (program === undefined || !program.stat.isFile) return undefined;
    if (configuration.cwd === undefined) {
      return { checkoutRoot: root.rootPath, program: program.canonical, cwd: root.rootPath };
    }
    const cwd = await resolveContainedPath(
      this.#files,
      root.rootPath,
      joinCodePath(root.rootPath, configuration.cwd),
    );
    if (cwd === undefined || !cwd.stat.isDirectory) return undefined;
    return { checkoutRoot: root.rootPath, program: program.canonical, cwd: cwd.canonical };
  }

  #coveredConfigurations(
    authorized: Extract<Authorized, { status: "authorized" }>,
    adapters: ReadonlyArray<CodeDebugAdapterComponent>,
  ): ReadonlyArray<CodeDebugApprovedConfiguration> {
    const listed = new Map<string, CodeDebugApprovedConfiguration>();
    for (const approval of this.#approvals.approvals(authorized.thread.projectId)) {
      if (
        approval.scope.kind === "checkout" &&
        String(approval.scope.checkoutId) !== String(authorized.checkout.id)
      ) {
        continue;
      }
      const adapter = adapters.find(
        (candidate) => String(candidate.adapter) === String(approval.configuration.adapter),
      );
      if (adapter === undefined || !samePackageState(adapter.packageState, approval.adapter)) {
        continue;
      }
      const key = String(approval.configurationDigest);
      if (listed.has(key) || listed.size >= MAX_CODE_DEBUG_APPROVED_CONFIGURATIONS) continue;
      listed.set(key, {
        configurationDigest: approval.configurationDigest,
        configuration: approval.configuration,
        scope: approval.scope.kind,
      });
    }
    return [...listed.values()];
  }

  /**
   * Reads `.vscode/launch.json`, if the checkout holds one, as proposals
   * only: contained like any checkout file, bounded at 256 KiB, parsed as
   * JSON with comments, and mapped by the pure import policy.
   */
  async #readLaunchFile(
    caller: CodeDebugCaller,
    authorized: Extract<Authorized, { status: "authorized" }>,
    adapters: ReadonlyArray<CodeDebugAdapterComponent>,
    currentFile: CodeRelativePath | undefined,
  ): Promise<CodeDebugLaunchFileReading> {
    const path = decodeCodeRelativePath(LAUNCH_FILE_PATH);
    let root: CodeFileRootResolution | undefined;
    try {
      root = await this.#authority.resolveRoot(
        caller.scopeId,
        authorized.thread,
        authorized.checkout,
        path,
      );
    } catch {
      root = undefined;
    }
    if (root === undefined) return { status: "absent" };
    const read = await readConfinedCodeFile({
      port: this.#files,
      canonicalRoot: root.rootPath,
      relativePath: path,
      maximumBytes: MAX_LAUNCH_FILE_BYTES,
    });
    if (read.status === "refused") {
      // Missing, or a link that leads out of the checkout: nothing to propose.
      return read.reason === "outside-root" ? { status: "absent" } : { status: "unreadable" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return { status: "unreadable" };
    }
    const parsed = parseJsonWithComments(text);
    if (parsed === undefined) return { status: "unreadable" };
    const imported = proposeDebugConfigurations(parsed, {
      checkoutRoot: root.rootPath,
      ...(currentFile === undefined ? {} : { currentFile }),
      adapters: adapters.map((adapter) => ({
        adapter: adapter.adapter,
        importTypes: adapter.declaration.importTypes,
      })),
    });
    return imported.status === "read"
      ? { status: "read", proposals: imported.proposals, truncated: imported.truncated }
      : { status: "unreadable" };
  }

  #connect(record: SessionRecord, process: DebugAdapterProcess): DebugAdapterConnection {
    const connection = new DebugAdapterConnection({
      input: process.stdout,
      output: process.stdin,
      requestDeadlineMs: this.#requestDeadlineMs,
      onViolation: () => void this.#end(record, "protocol-violation"),
      onEvent: (event, body) => this.#receive(record, record, event, body),
      onRefusedRequest: (command) => countRefused(record, command),
      ...(record.adapter.declaration.childAnnouncement === undefined
        ? {}
        : {
            childAnnouncement: record.adapter.declaration.childAnnouncement,
            onChildAnnounced: (configuration: unknown) =>
              this.#announceChild(record, configuration),
          }),
    });
    record.connection = connection;
    // An adapter that leaves without saying the program ended took the
    // session with it; it is not restarted, since that would run the program
    // again.
    void process.exited.then(() => this.#end(record, "adapter-exited"));
    return connection;
  }

  /**
   * `initialize`, then `launch` with the adapter's body filled, the window's
   * breakpoints once the adapter is initialized, the adapter's default
   * exception filters, and `configurationDone`. Many adapters answer `launch`
   * only after `configurationDone`, so it is awaited last.
   */
  async #handshake(
    record: SessionRecord,
    connection: DebugAdapterConnection,
    request: CodeDebugStartRequest,
    paths: ResolvedPaths,
    debugPort: number | undefined,
  ): Promise<boolean> {
    const initialized = await connection.request("initialize", {
      adapterID: String(record.adapter.adapter),
      ...INITIALIZE_ARGUMENTS,
      // Only an adapter that declared `startDebugging` as its announcement is
      // told the host answers it; debugpy, told so, would announce that way
      // rather than by the event its package declared.
      supportsStartDebuggingRequest:
        record.adapter.declaration.childAnnouncement?.kind === "start-debugging",
    });
    if (initialized.status !== "answered") return false;
    record.exceptionFilters = toExceptionFilters(initialized.body);
    const launched = connection.request(
      "launch",
      fillLaunchArguments(record.adapter.declaration.launchArguments, {
        program: paths.program,
        args: request.configuration.args,
        cwd: paths.cwd,
        env: Object.fromEntries(
          request.configuration.env.map((entry) => [String(entry.key), entry.value]),
        ),
        stopOnEntry: request.configuration.stopOnEntry,
        ...(debugPort === undefined ? {} : { debugPort }),
      }),
    );
    const ready = await Promise.race([
      record.initialized.promise.then(() => "initialized" as const),
      launched.then((response) => (response.status === "answered" ? "waiting" : "failed")),
      delay(this.#requestDeadlineMs).then(() => "timed-out" as const),
    ]);
    if (ready === "failed" || ready === "timed-out") return false;
    if (ready === "waiting") {
      const initializedLate = await Promise.race([
        record.initialized.promise.then(() => true),
        delay(this.#requestDeadlineMs).then(() => false),
      ]);
      if (!initializedLate) return false;
    }
    for (const file of request.breakpoints) {
      await connection.request("setBreakpoints", breakpointArguments(paths.checkoutRoot, file));
    }
    await connection.request("setExceptionBreakpoints", {
      filters: record.exceptionFilters
        .filter((filter) => filter.default)
        .map((filter) => filter.filter),
    });
    const done = await connection.request("configurationDone");
    if (done.status === "failed" || done.status === "closed") return false;
    const answered = await launched;
    if (answered.status !== "answered") return false;
    if (record.state.status === "starting") record.state = { status: "running" };
    record.revision += 1;
    return true;
  }

  /**
   * One accepted event on the session's connection or a child's. Output from
   * either reaches the session's one console; `terminated` ends the
   * connection's own program, so a child's ends that child only.
   */
  #receive(
    record: SessionRecord,
    target: SessionRecord | ChildRecord,
    event: DebugAdapterEvent,
    body: unknown,
  ): void {
    if (record.ending !== undefined || target.ending !== undefined) return;
    const fields = isRecord(body) ? body : {};
    switch (event) {
      case "initialized":
        target.initialized.resolve();
        return;
      case "stopped": {
        const description =
          typeof fields.description === "string"
            ? adapterText(fields.description, record.checkoutRoot, MAX_CODE_DEBUG_MESSAGE_LENGTH)
            : typeof fields.text === "string"
              ? adapterText(fields.text, record.checkoutRoot, MAX_CODE_DEBUG_MESSAGE_LENGTH)
              : undefined;
        target.state = {
          status: "stopped",
          programThreadId:
            typeof fields.threadId === "number" &&
            Number.isInteger(fields.threadId) &&
            fields.threadId >= 0 &&
            fields.threadId <= 2_147_483_647
              ? fields.threadId
              : 0,
          reason: boundText(typeof fields.reason === "string" ? fields.reason : "", 64).text,
          ...(description === undefined ? {} : { description }),
          allThreadsStopped: fields.allThreadsStopped === true,
        };
        target.revision += 1;
        return;
      }
      case "continued":
        target.state = { status: "running" };
        target.revision += 1;
        return;
      case "exited":
        if (typeof fields.exitCode === "number" && Number.isInteger(fields.exitCode)) {
          target.exitCode = fields.exitCode;
        }
        return;
      case "terminated":
        if ("child" in target) void this.#endChild(record, target, "program-exited");
        else void this.#end(record, "program-exited");
        return;
      case "output": {
        if (typeof fields.output !== "string") return;
        const category =
          fields.category === "stdout" ||
          fields.category === "stderr" ||
          fields.category === "important"
            ? fields.category
            : "console";
        appendOutput(
          record.output,
          category,
          adapterText(fields.output, record.checkoutRoot, MAX_CODE_DEBUG_OUTPUT_TEXT_LENGTH),
        );
        return;
      }
      case "capabilities": {
        const capabilities = fields.capabilities;
        if (isRecord(capabilities) && Array.isArray(capabilities.exceptionBreakpointFilters)) {
          target.exceptionFilters = toExceptionFilters(capabilities);
        }
        target.revision += 1;
        return;
      }
      case "thread":
      case "breakpoint":
      case "invalidated":
      case "process":
      case "progressStart":
      case "progressUpdate":
      case "progressEnd":
        target.revision += 1;
        return;
    }
  }

  async #ask(
    record: SessionRecord,
    target: SessionRecord | ChildRecord,
    command: Parameters<DebugAdapterConnection["request"]>[0],
    args: unknown,
  ): Promise<
    | { readonly status: "answered"; readonly body: unknown }
    | Extract<CodeDebugSessionResult, { status: "unavailable" }>
  > {
    const connection = target.connection;
    if (connection === undefined) return { status: "unavailable", reason: "ended" };
    const response: DebugAdapterResponse = await connection.request(command, args);
    switch (response.status) {
      case "answered":
        return response;
      case "timed-out":
        return { status: "unavailable", reason: "timed-out" };
      case "closed":
        return { status: "unavailable", reason: "ended" };
      case "failed":
        return {
          status: "unavailable",
          reason: "failed",
          ...(response.message === undefined
            ? {}
            : {
                message: adapterText(
                  response.message,
                  record.checkoutRoot,
                  MAX_CODE_DEBUG_MESSAGE_LENGTH,
                ),
              }),
        };
    }
  }

  #stateAnswer(
    record: SessionRecord,
    target: SessionRecord | ChildRecord,
    afterOutput: number,
  ): CodeDebugSessionResult {
    const newer = record.output.entries.filter((entry) => entry.sequence > afterOutput);
    const first = newer[0];
    const declaresChildren = record.childPort !== undefined;
    return {
      status: "state",
      state: target.state,
      revision: target.revision,
      exceptionFilters: target.exceptionFilters,
      ...(declaresChildren
        ? {
            children: [...record.children.values()]
              .filter((child) => child.ending === undefined)
              .map(childSummary),
            undebuggedChildren: record.undebuggedChildren,
          }
        : {}),
      output: newer
        .slice(0, MAX_CODE_DEBUG_OUTPUT_ENTRIES)
        .map(({ sequence, category, text }) => ({ sequence, category, text })),
      outputDropped:
        newer.length > MAX_CODE_DEBUG_OUTPUT_ENTRIES ||
        (first !== undefined && first.sequence > afterOutput + 1) ||
        (first === undefined && record.output.nextSequence - 1 > afterOutput),
    };
  }

  #endedAnswer(call: CodeDebugSessionCall): CodeDebugSessionResult {
    const ending = this.#endings.get(String(call.threadId));
    if (ending === undefined || String(ending.sessionId) !== String(call.sessionId)) {
      return refused("no-session");
    }
    if (call.request.kind === "state") {
      return {
        status: "state",
        state: {
          status: "ended",
          endReason: ending.endReason,
          ...(ending.exitCode === undefined ? {} : { exitCode: ending.exitCode }),
        },
        revision: 0,
        exceptionFilters: [],
        output: [],
        outputDropped: false,
      };
    }
    return { status: "ended", endReason: ending.endReason };
  }

  /**
   * Why a running session must end now, or undefined while everything that
   * let it start still holds: an active thread outside Plan whose posture
   * keeps the session's network level, its checkout available, and an
   * approval on record covering the configuration and the adapter in the
   * package state the session started from.
   */
  #endReasonFor(record: SessionRecord): CodeDebugSessionEndReason | undefined {
    const stored = this.#authority.readThread(record.threadId);
    if (stored === undefined || !isActiveThread(stored)) return "thread-inactive";
    const thread = this.#authority.effectiveThread(record.startedBy, stored);
    if (thread.executionPolicy === "plan") return "plan-read-only";
    const network = thread.executionPolicy === "full-access" ? "allow" : "proxied";
    if (network !== record.network) return "network-changed";
    const checkout = this.#authority.readCheckout(record.checkoutId);
    if (
      String(thread.checkoutId) !== String(record.checkoutId) ||
      checkout === undefined ||
      checkout.availability !== "available"
    ) {
      return "checkout-unavailable";
    }
    const adapter = this.#adapters().find(
      (candidate) => String(candidate.adapter) === String(record.adapter.adapter),
    );
    if (
      adapter === undefined ||
      !samePackageState(adapter.packageState, record.adapter.packageState)
    ) {
      return "approval-ended";
    }
    const covered = this.#approvals
      .approvals(record.projectId)
      .some(
        (approval) =>
          String(approval.configurationDigest) === String(record.configurationDigest) &&
          samePackageState(approval.adapter, adapter.packageState) &&
          (approval.scope.kind === "project" ||
            String(approval.scope.checkoutId) === String(record.checkoutId)),
      );
    return covered ? undefined : "approval-ended";
  }

  /**
   * A child announcement on the session's own connection, as the adapter
   * declared it. The child is taken only while the session runs and is not
   * ending, within the bounds, and only when it names loopback and the
   * session's own child port: under Full access on Linux the capsule shares
   * the host's network, so a port the adapter chose could be any local
   * service, Octant's own listener included. Anything else is refused before
   * a connection is opened, and that child runs undebugged.
   */
  #announceChild(record: SessionRecord, configuration: unknown): "accepted" | "refused" {
    if (record.ending !== undefined || record.process?.childEndpoint === undefined) {
      return "refused";
    }
    const refuse = () => {
      record.undebuggedChildren += 1;
      return "refused" as const;
    };
    if (!isRecord(configuration)) return refuse();
    const connect = configuration.connect;
    if (
      !isRecord(connect) ||
      typeof connect.host !== "string" ||
      !LOOPBACK_HOSTS.has(connect.host) ||
      connect.port !== record.childPort
    ) {
      return refuse();
    }
    const body = Object.fromEntries(
      Object.entries(configuration).filter(([key]) => key !== "connect"),
    );
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_CHILD_CONFIGURATION_BYTES) {
      return refuse();
    }
    const live = [...record.children.values()].filter((child) => child.ending === undefined);
    if (
      live.length >= MAX_CODE_DEBUG_CHILDREN_AT_ONCE ||
      record.childrenAttached >= MAX_CODE_DEBUG_CHILDREN_PER_SESSION
    ) {
      return refuse();
    }
    record.childrenAttached += 1;
    const id = decodeCodeDebugChildId(record.childrenAttached);
    const named = typeof configuration.name === "string" ? configuration.name : "";
    const child: ChildRecord = {
      ...newTarget(),
      child: id,
      name:
        named.length === 0
          ? `Child ${String(id)}`
          : adapterText(named, record.checkoutRoot, MAX_CODE_DEBUG_NAME_LENGTH),
      socket: undefined,
    };
    record.children.set(Number(id), child);
    void this.#attachChild(record, child, record.process.childEndpoint, body);
    return "accepted";
  }

  /**
   * The child's connection: opened to the session's own child endpoint, then
   * `initialize`, `attach` once with the announced configuration (its
   * `connect` removed, nothing added), the window's breakpoints, the
   * adapter's default exception filters, and `configurationDone`. The host
   * launches nothing: the adapter attaches to a process already in the
   * capsule.
   */
  async #attachChild(
    record: SessionRecord,
    child: ChildRecord,
    endpoint: DebugChildEndpoint,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    let socket: Socket;
    try {
      socket = await this.#connectChild(endpoint, this.#requestDeadlineMs);
    } catch {
      await this.#endChild(record, child, "start-failed");
      return;
    }
    child.socket = socket;
    if (child.ending !== undefined || record.ending !== undefined) {
      socket.destroy();
      return;
    }
    const connection = new DebugAdapterConnection({
      role: "child",
      input: socket,
      output: socket,
      requestDeadlineMs: this.#requestDeadlineMs,
      onViolation: () => void this.#endChild(record, child, "protocol-violation"),
      onEvent: (event, eventBody) => this.#receive(record, child, event, eventBody),
      onRefusedRequest: (command) => countRefused(record, command),
    });
    child.connection = connection;
    socket.once("close", () => void this.#endChild(record, child, "adapter-exited"));
    const initialized = await connection.request("initialize", {
      ...INITIALIZE_ARGUMENTS,
      adapterID: String(record.adapter.adapter),
      supportsStartDebuggingRequest: false,
    });
    if (initialized.status !== "answered") {
      await this.#endChild(record, child, "start-failed");
      return;
    }
    child.exceptionFilters = toExceptionFilters(initialized.body);
    const attached = connection.request("attach", body);
    const ready = await Promise.race([
      child.initialized.promise.then(() => "initialized" as const),
      attached.then((response) => (response.status === "answered" ? "waiting" : "failed")),
      delay(this.#requestDeadlineMs).then(() => "timed-out" as const),
    ]);
    const initializedLate =
      ready === "waiting"
        ? await Promise.race([
            child.initialized.promise.then(() => true),
            delay(this.#requestDeadlineMs).then(() => false),
          ])
        : ready === "initialized";
    if (!initializedLate || child.ending !== undefined) {
      await this.#endChild(record, child, "start-failed");
      return;
    }
    for (const file of record.breakpoints.values()) {
      await connection.request("setBreakpoints", breakpointArguments(record.checkoutRoot, file));
    }
    await connection.request("setExceptionBreakpoints", {
      filters: child.exceptionFilters
        .filter((filter) => filter.default)
        .map((filter) => filter.filter),
    });
    const done = await connection.request("configurationDone");
    const answered = await attached;
    if (done.status === "failed" || done.status === "closed" || answered.status !== "answered") {
      await this.#endChild(record, child, "start-failed");
      return;
    }
    if (child.state.status === "starting") child.state = { status: "running" };
    child.revision += 1;
  }

  /**
   * Ends one child once: `disconnect` with its process terminated on its own
   * connection, then the connection closed. The session goes on; a child's
   * end never ends it.
   */
  #endChild(
    record: SessionRecord,
    child: ChildRecord,
    reason: CodeDebugSessionEndReason,
  ): Promise<void> {
    child.ending ??= (async () => {
      child.state = { status: "ended", endReason: reason };
      child.initialized.resolve();
      const connection = child.connection;
      if (connection !== undefined && !connection.closed) {
        const closed = new Promise<void>((resolve) => {
          if (child.socket === undefined || child.socket.closed) resolve();
          else child.socket.once("close", () => resolve());
        });
        void connection.request("disconnect", { terminateDebuggee: true }, this.#disconnectGraceMs);
        await Promise.race([closed, delay(this.#disconnectGraceMs)]);
      }
      connection?.close();
      child.socket?.destroy();
      record.children.delete(Number(child.child));
    })();
    return child.ending;
  }

  /**
   * The session's host-chosen loopback ports, all distinct: its debug port
   * when the adapter declares one, and its two child ports when it declares
   * children. Undefined when the host found none.
   */
  async #chooseSessionPorts(
    debug: number,
    child: number,
  ): Promise<{ readonly debug: number[]; readonly child: number[] } | undefined> {
    const chosen: number[] = [];
    for (let attempt = 0; chosen.length < debug + child && attempt < 16; attempt += 1) {
      const port = await this.#choosePort().catch(() => undefined);
      if (port === undefined) return undefined;
      if (!chosen.includes(port)) chosen.push(port);
    }
    if (chosen.length < debug + child) return undefined;
    return { debug: chosen.slice(0, debug), child: chosen.slice(debug) };
  }

  /**
   * Ends a session once: its children first, then `disconnect` with the
   * program terminated, then the capsule's group stopped after the grace
   * period, then the end journaled with how many children it attached. Its
   * values (output, variables, breakpoints) go with it.
   */
  #end(record: SessionRecord, reason: CodeDebugSessionEndReason): Promise<void> {
    record.ending ??= (async () => {
      record.state = {
        status: "ended",
        endReason: reason,
        ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      };
      record.initialized.resolve();
      await Promise.all(
        [...record.children.values()].map((child) => this.#endChild(record, child, reason)),
      );
      const connection = record.connection;
      const process = record.process;
      if (connection !== undefined && !connection.closed && process !== undefined) {
        void connection.request("disconnect", { terminateDebuggee: true }, this.#disconnectGraceMs);
        await Promise.race([process.exited, delay(this.#disconnectGraceMs)]);
      }
      connection?.close();
      await process?.kill().catch(() => undefined);
      this.#records.ended({
        sessionId: record.sessionId,
        projectId: record.projectId,
        threadId: record.threadId,
        configurationDigest: record.configurationDigest,
        endReason: reason,
        ...(record.childPort === undefined ? {} : { childSessions: record.childrenAttached }),
      });
      record.output.entries.length = 0;
      this.#sessions.delete(String(record.sessionId));
      this.#endings.delete(String(record.threadId));
      this.#endings.set(String(record.threadId), {
        sessionId: record.sessionId,
        endReason: reason,
        exitCode: record.exitCode,
      });
      while (this.#endings.size > MAX_REMEMBERED_ENDINGS) {
        const oldest = this.#endings.keys().next().value;
        if (oldest === undefined) break;
        this.#endings.delete(oldest);
      }
    })();
    return record.ending;
  }
}

/** The aggregates whose committed events can end a running session. */
const AUTHORITY_AGGREGATES: ReadonlySet<string> = new Set([
  "code-thread",
  "code-checkout",
  EXTENSION_AGGREGATE_TYPE,
  CODE_DEBUG_CONFIGURATION_AGGREGATE,
]);

const STEP_COMMANDS = {
  continue: "continue",
  next: "next",
  "step-in": "stepIn",
  "step-out": "stepOut",
  pause: "pause",
} as const;

function newRecord(input: {
  readonly sessionId: CodeDebugSessionId;
  readonly projectId: ProjectId;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly configurationDigest: CodeDebugConfigurationDigest;
  readonly adapter: CodeDebugAdapterComponent;
  readonly network: "proxied" | "allow";
  readonly checkoutRoot: string;
  readonly startedBy: WindowId;
}): SessionRecord {
  return {
    ...input,
    ...newTarget(),
    process: undefined,
    output: { entries: [], bytes: 0, nextSequence: 1 },
    refusedRequests: new Map(),
    breakpoints: new Map(),
    children: new Map(),
    childPort: undefined,
    childrenAttached: 0,
    undebuggedChildren: 0,
  };
}

function newTarget(): DebugTarget {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {
    connection: undefined,
    state: { status: "starting" },
    revision: 0,
    exceptionFilters: [],
    exitCode: undefined,
    ending: undefined,
    initialized: { promise, resolve },
  };
}

/** What the host tells an adapter about itself, on every connection. */
const INITIALIZE_ARGUMENTS = {
  clientID: "octant",
  clientName: "Octant",
  locale: "en",
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: "path",
  supportsVariableType: true,
  supportsVariablePaging: true,
  supportsRunInTerminalRequest: false,
  supportsMemoryReferences: false,
  supportsProgressReporting: true,
  supportsInvalidatedEvent: true,
  supportsArgsCanBeInterpretedByShell: false,
} as const;

function countRefused(record: SessionRecord, command: string): void {
  record.refusedRequests.set(command, (record.refusedRequests.get(command) ?? 0) + 1);
}

/**
 * Keeps the window's breakpoints as last sent, for a child that attaches
 * later; a file with none left is forgotten, and no more files are kept
 * than a Start may carry.
 */
function rememberBreakpoints(record: SessionRecord, file: CodeDebugFileBreakpoints): void {
  const key = String(file.path);
  if (file.breakpoints.length === 0) {
    record.breakpoints.delete(key);
    return;
  }
  if (!record.breakpoints.has(key) && record.breakpoints.size >= MAX_CODE_DEBUG_BREAKPOINT_FILES) {
    return;
  }
  record.breakpoints.set(key, file);
}

function childSummary(child: ChildRecord): CodeDebugChildSummary {
  return {
    child: child.child,
    name: child.name,
    status:
      child.state.status === "stopped"
        ? "stopped"
        : child.state.status === "running"
          ? "running"
          : "starting",
  };
}

/** Opens a child connection to the session's own endpoint, or fails by the deadline. */
function openChildSocket(endpoint: DebugChildEndpoint, deadlineMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      endpoint.kind === "loopback"
        ? connectSocket({ host: "127.0.0.1", port: endpoint.port })
        : connectSocket({ path: endpoint.path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The child connection timed out."));
    }, deadlineMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Keeps the newest output within the ring's byte bound. */
function appendOutput(
  ring: OutputRing,
  category: CodeDebugOutputEntry["category"],
  text: string,
): void {
  if (text.length === 0) return;
  const bytes = Buffer.byteLength(text, "utf8");
  ring.entries.push({ sequence: ring.nextSequence, category, text, bytes });
  ring.nextSequence += 1;
  ring.bytes += bytes;
  while (ring.bytes > DEBUG_OUTPUT_RING_BYTES && ring.entries.length > 1) {
    const dropped = ring.entries.shift();
    ring.bytes -= dropped?.bytes ?? 0;
  }
}

/** The SHA-256 digest of a configuration's canonical text, which its approval covers. */
export function digestOf(configuration: CodeDebugConfiguration): CodeDebugConfigurationDigest {
  return decodeCodeDebugConfigurationDigest(
    `sha256:${createHash("sha256").update(canonicalDebugConfigurationText(configuration)).digest("hex")}`,
  );
}

/**
 * Fills the adapter's `launch` body. A string that is exactly one placeholder
 * becomes the checked value; every other value is the adapter's literal.
 * The seam already refused a placeholder inside a longer string or a key.
 */
export function fillLaunchArguments(
  body: unknown,
  values: {
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stopOnEntry: boolean;
    readonly debugPort?: number;
  },
): unknown {
  if (typeof body === "string") {
    switch (body) {
      case "{{program}}":
        return values.program;
      case "{{args}}":
        return [...values.args];
      case "{{cwd}}":
        return values.cwd;
      case "{{env}}":
        return { ...values.env };
      case "{{stopOnEntry}}":
        return values.stopOnEntry;
      case "{{debugPort}}":
        return values.debugPort ?? null;
      default:
        return body;
    }
  }
  if (Array.isArray(body)) return body.map((item) => fillLaunchArguments(item, values));
  if (isRecord(body)) {
    const filled: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      Object.defineProperty(filled, key, {
        value: fillLaunchArguments(value, values),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return filled;
  }
  return body;
}

function breakpointArguments(checkoutRoot: string, file: CodeDebugFileBreakpoints): unknown {
  return {
    source: { path: joinCodePath(checkoutRoot, file.path) },
    breakpoints: file.breakpoints.map((breakpoint) => ({
      line: breakpoint.line,
      ...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
    })),
  };
}

function toPolicyApproval(approval: CodeDebugConfigurationApproved): DebugConfigurationApproval {
  return {
    configurationDigest: approval.configurationDigest,
    adapter: approval.adapter,
    scope: approval.scope,
  };
}

function samePackageState(
  left: DebugAdapterPackageState,
  right: DebugAdapterPackageState,
): boolean {
  return (
    String(left.extensionId) === String(right.extensionId) &&
    String(left.componentId) === String(right.componentId) &&
    String(left.packageDigest) === String(right.packageDigest) &&
    left.lifecycleVersion === right.lifecycleVersion
  );
}

function sameThread(record: SessionRecord, threadId: CodeThreadId): boolean {
  return String(record.threadId) === String(threadId);
}

function isActiveThread(thread: CodeThread): boolean {
  return thread.lifecycle === "active" && thread.completedAt === undefined;
}

function refused(reason: CodeDebugRefusalReason): {
  readonly status: "refused";
  readonly reason: CodeDebugRefusalReason;
} {
  return { status: "refused", reason };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * A free loopback port for a session's debug port. On Linux the port lives
 * in the capsule's own network namespace, where only the egress forwarder
 * listens, so it only has to differ from the forwarder's.
 */
async function chooseLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          typeof address === "object" && address !== null
            ? resolve(address.port)
            : reject(new Error("No loopback port.")),
        );
      });
    });
    if (port !== LINUX_EGRESS_FORWARDER_PORT) return port;
  }
  throw new Error("No loopback port.");
}

/**
 * JSON with comments, as editors write launch files: line and block comments
 * and trailing commas outside strings are dropped, then the text is parsed as
 * JSON. Undefined when it is not that.
 */
export function parseJsonWithComments(text: string): unknown {
  let output = "";
  let index = 0;
  const source = text.replace(/^﻿/, "");
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') {
        end += source[end] === "\\" ? 2 : 1;
      }
      output += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return undefined;
      index = end + 2;
      continue;
    }
    if (character === ",") {
      let ahead = index + 1;
      while (ahead < source.length && /\s/.test(source[ahead] ?? "")) ahead += 1;
      // A comment between a trailing comma and its bracket is rare enough
      // that such a file reads as unreadable rather than guessed at.
      if (source[ahead] === "}" || source[ahead] === "]") {
        index += 1;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
