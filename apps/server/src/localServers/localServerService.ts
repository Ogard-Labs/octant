import { createHash } from "node:crypto";
import {
  decodeLocalServerCommandResult,
  decodeLocalServerSnapshot,
  type CodeThreadId,
  type LocalServerCommand,
  type LocalServerCommandResult,
  type LocalServerFailure,
  type LocalServerHealth,
  type LocalServerListener,
  type LocalServerListenerId,
  type LocalServerSnapshot,
  type ProjectId,
  type WindowId,
  MAX_LOCAL_SERVER_LISTENERS,
} from "@octant/contracts";
import {
  authorizeLocalServerAction,
  classifyLocalListener,
  describeLocalServerStopDenial,
  LOCAL_SERVER_SYSTEM_DENYLIST,
  type LocalListenerClassification,
  type LocalServerActor,
  type LocalServerPosture,
} from "@octant/domain";
import type {
  LocalListenerObservation,
  LocalListenerPort,
  ObservedLocalListener,
} from "./localListenerPort";

/**
 * Authoritative Code Environment "Local servers" surface.
 *
 * Three invariants hold for every path through this service:
 *
 * - Classification happens here, never in the renderer. A row the classifier
 *   omits is absent from the response entirely, so the list can never be read
 *   as a host process inventory.
 * - Stop re-observes and re-classifies immediately before signalling. A
 *   listener id minted by an earlier scan is a *claim*, not authority: the port
 *   may since have been taken by a different process.
 * - The observation is ephemeral. Nothing here is journaled, so a restart shows
 *   the host as it is now and never silently restarts a server.
 *
 * Every scan is also bounded in time, because the panel skips a refresh while
 * one is outstanding. The health phase probes listeners with bounded
 * concurrency under `LISTENER_HEALTH_PHASE_DEADLINE_MS` rather than one at a
 * time, so a listener that holds its port without answering delays its own row
 * and never the whole listing — and a row the phase could not finish asking
 * about is still published, with Open withheld rather than a health invented
 * for it.
 */

/**
 * How many listeners may be probed for health at once.
 *
 * Deliberately not `LISTENER_CWD_SCAN_CONCURRENCY`: that cap bounds how many
 * `lsof` subprocesses the host is asked to fork at once, while a health probe
 * costs one loopback socket and no process at all. The two phases bound
 * different resources, so sharing one number would tie a socket budget to a
 * fork budget that happens to be written next to it.
 *
 * The cap is also the number of simultaneously wedged listeners the phase can
 * absorb: within `LISTENER_HEALTH_PHASE_DEADLINE_MS` each worker has room for
 * about one full probe attempt, so a wedged listener occupies one worker and
 * the fast majority keeps flowing past it. Sixteen is twice the subprocess cap
 * because the per-unit cost here is far lower, and it stays well under the
 * contract's two-hundred listener budget so the phase never opens a socket per
 * published row at once.
 */
export const LISTENER_HEALTH_PROBE_CONCURRENCY = 16;

/**
 * How long the whole health phase may take before the listing reports what it
 * has, however many listeners are still unanswered.
 *
 * Concurrency bounds how many probes run at once, not how long they take. One
 * probe fans out over two schemes and up to two loopback families in sequence,
 * each attempt bounded by the probe's own 1.5-second timeout, so a listener
 * that accepts TCP and never answers can hold a worker for roughly six
 * seconds — longer than the panel's whole five-second refresh, which skips a
 * poll while a scan is outstanding.
 *
 * Two seconds follows the same rule the enrichment deadline follows: it sits
 * *below* that per-probe fan-out, so one wedged listener is cut short rather
 * than spending the phase waiting for its own timeouts, and *above* a single
 * 1.5-second attempt, so a listener that is merely slow still gets one complete
 * attempt and a real answer instead of being cut off mid-question. A normal
 * host answers every probe in milliseconds and never reaches it.
 *
 * Reaching it changes nothing about what the listing *claims*: the host looked
 * and saw these listeners, and one it could not finish asking about is reported
 * as a health it did not determine, with Open withheld.
 */
export const LISTENER_HEALTH_PHASE_DEADLINE_MS = 2_000;

/**
 * The thread binding the host resolves before it may observe or act. It holds
 * no actor: who is asking is a fact about the request's authenticated
 * principal, not about the thread, so it is supplied per command instead.
 */
export interface LocalServerScopeBinding {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
  /** Canonical root of the checkout the thread is bound to. */
  readonly currentCheckoutRoot: string;
  /** Canonical roots the host recognizes as user project/worktree locations. */
  readonly userProjectRoots: ReadonlyArray<string>;
  readonly posture: LocalServerPosture;
  /** PIDs of processes Octant itself started and still owns. */
  readonly ownedPids: ReadonlySet<number>;
}

/** Everything the host must decide before it may observe or act for one thread. */
export interface LocalServerScope extends LocalServerScopeBinding {
  readonly actor: LocalServerActor;
}

export interface LocalServerScopeResolver {
  resolve(
    authenticatedWindowId: WindowId,
    threadId: CodeThreadId,
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Promise<LocalServerScopeBinding | undefined>;
}

export interface LocalServerHealthProbe {
  probe(input: {
    readonly port: number;
    /** Address the host observed the socket bound to, so the probe can pick a family. */
    readonly bindAddress?: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly scheme: "http" | "https";
    /** Loopback host that answered — reported so Open targets that same endpoint. */
    readonly host: string;
    readonly health: LocalServerHealth;
  }>;
}

export interface LocalServerStopPort {
  /** Graceful SIGTERM, bounded wait, then SIGKILL. Resolves to the outcome. */
  stop(input: { readonly pid: number }): Promise<"stopped" | "failed">;
}

export interface LocalServerServiceOptions {
  readonly listeners: LocalListenerPort;
  readonly scopes: LocalServerScopeResolver;
  readonly health: LocalServerHealthProbe;
  readonly stopPort: LocalServerStopPort;
  readonly clock?: () => string;
  readonly maxListeners?: number;
}

interface ResolvedListener {
  readonly listener: LocalServerListener;
  readonly observation: ObservedLocalListener;
  readonly ownership: "octant-owned" | "leftover";
}

/** One listener the classifier will publish, before its health is known. */
interface ClassifiedListener {
  readonly observation: ObservedLocalListener;
  readonly classification: Extract<LocalListenerClassification, { readonly status: "listed" }>;
}

/** What one health probe established about a listener. */
type ProbeResult = Awaited<ReturnType<LocalServerHealthProbe["probe"]>>;

/**
 * A classified scan, or the host's admission that it could not scan. The
 * unavailable arm never becomes an empty snapshot: every command answers a
 * failed discovery with a typed refusal instead of an assertion about what is
 * running.
 */
type ClassifiedScan =
  | { readonly status: "observed"; readonly listeners: ReadonlyArray<ResolvedListener> }
  | { readonly status: "unavailable" };

export class LocalServerService {
  readonly #listeners: LocalListenerPort;
  readonly #scopes: LocalServerScopeResolver;
  readonly #health: LocalServerHealthProbe;
  readonly #stopPort: LocalServerStopPort;
  readonly #clock: () => string;
  readonly #maxListeners: number;

  constructor(options: LocalServerServiceOptions) {
    this.#listeners = options.listeners;
    this.#scopes = options.scopes;
    this.#health = options.health;
    this.#stopPort = options.stopPort;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#maxListeners = options.maxListeners ?? MAX_LOCAL_SERVER_LISTENERS;
  }

  /**
   * `actor` is required rather than defaulted: the caller holds the request's
   * authenticated principal, and a default here would let a paired remote
   * device be decided as the host user.
   */
  async execute(
    authenticatedWindowId: WindowId,
    command: LocalServerCommand,
    options: { readonly actor: LocalServerActor; readonly signal?: AbortSignal },
  ): Promise<LocalServerCommandResult> {
    const binding = await this.#scopes.resolve(
      authenticatedWindowId,
      command.threadId,
      command.projectId,
      options.signal,
    );
    if (binding === undefined) {
      return this.#rejected(command, {
        category: "not-found",
        message: "Local servers require a bound Code thread in this Project.",
      });
    }
    const scope: LocalServerScope = { ...binding, actor: options.actor };

    const scan = await this.#observe(scope, options.signal);
    if (scan.status === "unavailable") {
      // The host never established what is running here, so it answers with a
      // refusal rather than a snapshot the user would read as a quiet computer.
      return this.#rejected(command, {
        category: "unavailable",
        message:
          "Octant could not check this computer for local servers, so it cannot say whether any are running.",
      });
    }
    const resolved = scan.listeners;
    if (command.kind === "list-local-servers") {
      return decodeLocalServerCommandResult({
        kind: "local-servers-listed",
        requestId: command.requestId,
        snapshot: this.#snapshot(scope, resolved),
      });
    }

    const target = resolved.find((entry) => entry.listener.listenerId === command.listenerId);
    if (target === undefined) {
      // A listener the current observation does not classify is not merely
      // missing — it is one Octant refuses to act on, and both answer alike.
      return this.#rejected(command, {
        category: "not-found",
        message: "That local server is no longer classified as a user or dev server.",
      });
    }

    return command.kind === "open-local-server"
      ? this.#open(command, scope, target)
      : await this.#stop(command, scope, target, options.signal);
  }

  #open(
    command: Extract<LocalServerCommand, { readonly kind: "open-local-server" }>,
    scope: LocalServerScope,
    target: ResolvedListener,
  ): LocalServerCommandResult {
    const decision = authorizeLocalServerAction({
      action: "open",
      actor: scope.actor,
      posture: scope.posture,
      classified: true,
    });
    if (decision.kind === "deny") {
      return this.#rejected(command, {
        category: "unauthorized",
        message: describeLocalServerStopDenial(decision),
      });
    }
    if (!target.listener.openAvailable) {
      // Both refusals withhold Open, but only one of them is a fact about the
      // listener: a row the host never finished asking about is not "not
      // answering", it is unchecked.
      return this.#rejected(command, {
        category: "unavailable",
        message:
          target.listener.health === "unknown"
            ? "Octant could not check that local server, so it has nothing to open."
            : "That local server is not answering, so there is nothing to open.",
      });
    }
    const url = new URL(String(target.listener.url));
    return decodeLocalServerCommandResult({
      kind: "local-server-open-prepared",
      requestId: command.requestId,
      listenerId: target.listener.listenerId,
      target: {
        url: target.listener.url,
        // Exactly this origin: a second leftover creates another tab rather
        // than widening `localhost` to every port on the host.
        allowedOrigin: url.origin,
        acceptsLocalCertificate: url.protocol === "https:",
      },
    });
  }

  async #stop(
    command: Extract<LocalServerCommand, { readonly kind: "stop-local-server" }>,
    scope: LocalServerScope,
    target: ResolvedListener,
    signal?: AbortSignal,
  ): Promise<LocalServerCommandResult> {
    const decision = authorizeLocalServerAction({
      action: "stop",
      actor: scope.actor,
      posture: scope.posture,
      ownership: target.ownership,
      classified: true,
    });
    if (decision.kind === "deny") {
      return this.#rejected(command, {
        category:
          decision.reason === "local-host-required" ? "local-host-required" : "unauthorized",
        message: describeLocalServerStopDenial(decision),
      });
    }
    if (decision.kind === "prompt") {
      return this.#rejected(command, {
        category: "confirmation-required",
        message:
          "Stopping a leftover server needs a fresh user approval; a remembered Full access grant does not cover it.",
      });
    }
    if (decision.kind === "confirm" && !confirms(command.confirmation, target)) {
      return this.#rejected(command, {
        category: "confirmation-required",
        message: `Confirm stopping ${target.listener.processName} on port ${target.listener.port} before Octant signals it.`,
      });
    }

    // Re-observe before signalling: the id came from an earlier scan and the
    // port may since have been taken by a process this classifier would hide.
    const reobserved = await this.#observe(scope, signal);
    if (reobserved.status === "unavailable") {
      return this.#rejected(command, {
        category: "unavailable",
        message:
          "Octant could not re-check this computer's local servers, so it signalled nothing.",
      });
    }
    const current = reobserved.listeners.find(
      (entry) => entry.listener.listenerId === command.listenerId,
    );
    if (
      current === undefined ||
      current.observation.pid !== target.observation.pid ||
      current.listener.stop.status !== "available"
    ) {
      return this.#rejected(command, {
        category: "not-found",
        message: "That local server changed before Octant could stop it; nothing was signalled.",
      });
    }

    const outcome = await this.#stopPort.stop({ pid: current.observation.pid });
    if (outcome === "failed") {
      return this.#rejected(command, {
        category: "unavailable",
        message: "Octant could not stop that local server.",
      });
    }

    const after = await this.#observe(scope, signal);
    if (after.status === "unavailable") {
      // The signal landed; only the follow-up scan failed. Saying so beats
      // publishing an empty snapshot as this host's post-stop state.
      return this.#rejected(command, {
        category: "unavailable",
        message:
          "Octant stopped that local server but could not re-check this computer afterwards.",
      });
    }
    return decodeLocalServerCommandResult({
      kind: "local-server-stopped",
      requestId: command.requestId,
      listenerId: command.listenerId,
      snapshot: this.#snapshot(scope, after.listeners),
    });
  }

  async #observe(scope: LocalServerScope, signal?: AbortSignal): Promise<ClassifiedScan> {
    let scan: LocalListenerObservation;
    try {
      scan = await this.#listeners.observe(signal);
    } catch {
      // A port that threw is as uninformative as one that reported failure.
      return { status: "unavailable" };
    }
    if (scan.status === "unavailable") return { status: "unavailable" };

    // Classification is synchronous and decides what may be published at all,
    // so it runs first and in full: the health phase then asks about exactly
    // the listeners this snapshot can carry, never one it is about to drop.
    // An aborted request has no reader, so it classifies nothing.
    const classified: ClassifiedListener[] = [];
    if (signal?.aborted !== true) {
      for (const observation of scan.listeners.slice(0, this.#maxListeners)) {
        const classification = classifyLocalListener(observation, {
          currentCheckoutRoot: scope.currentCheckoutRoot,
          userProjectRoots: scope.userProjectRoots,
        });
        if (classification.status !== "omitted") classified.push({ observation, classification });
      }
    }

    const probes = await this.#probeHealth(classified, signal);
    // An abandoned scan has no reader either, so a listener it never got to ask
    // about is left out rather than published with a health nobody established
    // — which also keeps Stop's re-observation failing closed on an abort.
    const abandoned = signal?.aborted === true;

    const resolved: ResolvedListener[] = [];
    for (const [index, { observation, classification }] of classified.entries()) {
      const probed = probes[index];
      if (probed === undefined && abandoned) continue;
      const probe = probed ?? unanswered(observation);
      const ownership = scope.ownedPids.has(observation.pid) ? "octant-owned" : "leftover";
      const stopDecision = authorizeLocalServerAction({
        action: "stop",
        actor: scope.actor,
        posture: scope.posture,
        ownership,
        classified: classification.stoppable && !isDenylisted(observation),
      });

      // The endpoint that answered, not a presumed one: an IPv6-only listener
      // is reachable at `[::1]` and nowhere else, and an IPv6 host is only a
      // valid URL authority in brackets.
      const host = probe.host.includes(":") ? `[${probe.host}]` : probe.host;
      const url = `${probe.scheme}://${host}:${observation.port}/`;
      let listener: LocalServerListener;
      try {
        listener = {
          listenerId: deriveListenerId(scope.threadId, observation),
          port: observation.port as LocalServerListener["port"],
          url: url as LocalServerListener["url"],
          processName: observation.processName,
          ...(classification.framework === undefined
            ? {}
            : { framework: classification.framework }),
          ...(observation.workingDirectory === undefined
            ? {}
            : { workingDirectory: observation.workingDirectory }),
          ...(observation.workingDirectory === undefined
            ? {}
            : { workspaceLabel: basename(observation.workingDirectory) }),
          attribution: classification.attribution,
          startSource: ownership === "octant-owned" ? "octant" : classification.startSource,
          bindScope: isLoopbackAddress(observation.bindAddress) ? "loopback" : "lan",
          health: probe.health,
          openAvailable: probe.health === "listening",
          stop:
            stopDecision.kind === "deny"
              ? { status: "unavailable", reason: describeLocalServerStopDenial(stopDecision) }
              : {
                  status: "available",
                  confirmationRequired: stopDecision.kind !== "allow",
                },
        };
      } catch {
        continue;
      }
      resolved.push({ listener, observation, ownership });
    }
    return { status: "observed", listeners: resolved };
  }

  /**
   * Probe every classified listener with at most
   * `LISTENER_HEALTH_PROBE_CONCURRENCY` in flight, and the whole phase inside
   * `LISTENER_HEALTH_PHASE_DEADLINE_MS`.
   *
   * The deadline and the caller's abort share one controller, so either ends
   * the phase, both stop the workers from starting further probes, and both
   * cancel the probes already in flight. Results land by index as they arrive;
   * an index left empty is a listener the phase never finished asking about,
   * which the caller reports as such rather than as a wedged server.
   *
   * The timer and the caller's abort listener are released on every exit, so a
   * listing that finishes early leaves nothing pending behind it.
   */
  async #probeHealth(
    classified: ReadonlyArray<ClassifiedListener>,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<ProbeResult | undefined>> {
    const probes: Array<ProbeResult | undefined> = Array.from(
      { length: classified.length },
      () => undefined,
    );
    if (classified.length === 0 || signal?.aborted === true) return probes;

    const deadline = new AbortController();
    const stop = () => deadline.abort();
    const timer = setTimeout(stop, LISTENER_HEALTH_PHASE_DEADLINE_MS);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      let next = 0;
      const workers = Array.from(
        { length: Math.min(LISTENER_HEALTH_PROBE_CONCURRENCY, classified.length) },
        async () => {
          while (next < classified.length) {
            if (deadline.signal.aborted) return;
            const index = next++;
            probes[index] = await this.#probe(classified[index]!.observation, deadline.signal);
          }
        },
      );
      // Resolves — never rejects — the moment the phase ends for either cause,
      // so a probe that never settles cannot hold the listing open.
      const ended = new Promise<void>((resolve) => {
        deadline.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([Promise.all(workers), ended]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
    return probes;
  }

  async #probe(observation: ObservedLocalListener, signal: AbortSignal): Promise<ProbeResult> {
    try {
      return await this.#health.probe({
        port: observation.port,
        bindAddress: observation.bindAddress,
        signal,
      });
    } catch {
      return unanswered(observation);
    }
  }

  #snapshot(
    scope: LocalServerScope,
    resolved: ReadonlyArray<ResolvedListener>,
  ): LocalServerSnapshot {
    return decodeLocalServerSnapshot({
      threadId: scope.threadId,
      projectId: scope.projectId,
      currentCheckout: resolved
        .filter((entry) => entry.listener.attribution === "current-checkout")
        .map((entry) => entry.listener),
      other: resolved
        .filter((entry) => entry.listener.attribution !== "current-checkout")
        .map((entry) => entry.listener),
      observedAt: this.#clock(),
    });
  }

  #rejected(command: LocalServerCommand, failure: LocalServerFailure): LocalServerCommandResult {
    return decodeLocalServerCommandResult({
      kind: "local-server-rejected",
      requestId: command.requestId,
      failure,
    });
  }
}

/**
 * Opaque per-thread listener id. Derived from thread, pid, port, and process
 * name so the same listener keeps its id across refreshes while the token still
 * carries no host handle a client could act on directly.
 */
export function deriveListenerId(
  threadId: CodeThreadId,
  observation: Pick<ObservedLocalListener, "pid" | "port" | "processName">,
): LocalServerListenerId {
  const digest = createHash("sha256")
    .update("octant.local-server.v1\0")
    .update(String(threadId))
    .update("\0")
    .update(String(observation.pid))
    .update("\0")
    .update(String(observation.port))
    .update("\0")
    .update(observation.processName)
    .digest("hex")
    .slice(0, 32);
  return `lsn_${digest}` as LocalServerListenerId;
}

function confirms(
  confirmation: Extract<LocalServerCommand, { readonly kind: "stop-local-server" }>["confirmation"],
  target: ResolvedListener,
): boolean {
  if (confirmation === undefined) return false;
  if (confirmation.acknowledgedProcessName !== target.listener.processName) return false;
  if (Number(confirmation.acknowledgedPort) !== Number(target.listener.port)) return false;
  const acknowledgedDirectory = confirmation.acknowledgedWorkingDirectory;
  return acknowledgedDirectory === undefined
    ? target.listener.workingDirectory === undefined
    : acknowledgedDirectory === target.listener.workingDirectory;
}

function isDenylisted(observation: ObservedLocalListener): boolean {
  return (
    LOCAL_SERVER_SYSTEM_DENYLIST.has(observation.processName) ||
    (observation.commandName !== undefined &&
      LOCAL_SERVER_SYSTEM_DENYLIST.has(observation.commandName))
  );
}

/**
 * What the listing says about a listener the host could not finish asking
 * about — a probe that threw, one cut short by the phase deadline, or one that
 * never started before it.
 *
 * `unknown` is the only claim the host can back here. `unresponsive` would say
 * the listener holds its port without answering, which nothing established: the
 * question was abandoned, not answered. Open stays withheld all the same,
 * because `openAvailable` follows `listening` and this is not it. The endpoint
 * named is the loopback family the socket was actually observed on, so an
 * IPv6-only listener is not published under an IPv4 URL nothing was ever asked
 * at.
 */
function unanswered(observation: ObservedLocalListener): ProbeResult {
  return {
    scheme: "http",
    host: observation.bindAddress.includes(":") ? "::1" : "127.0.0.1",
    health: "unknown",
  };
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "localhost" || address === "::1";
}

function basename(path: string): string {
  return (
    path
      .split("/")
      .filter((segment) => segment !== "")
      .at(-1) ?? path
  );
}
