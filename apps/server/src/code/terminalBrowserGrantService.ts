import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  TERMINAL_BROWSER_ENDPOINT_ENVIRONMENT,
  TERMINAL_BROWSER_GRANT_EVENT_NAMES,
  TERMINAL_BROWSER_TOKEN_ENVIRONMENT,
  UtcTimestamp,
  decodeBrowserThreadId,
  decodeTerminalBrowserGrantId,
  decodeTerminalBrowserGrantIssued,
  decodeTerminalBrowserGrantRevoked,
  type BrowserThreadId,
  type CodeTerminalId,
  type CodeThread,
  type CodeThreadId,
  type EventActor as EventActorValue,
  type TerminalBrowserGrantId,
  type TerminalBrowserGrantOutcome,
  type TerminalBrowserGrantRefusalReason,
  type TerminalBrowserGrantRevokeReason,
  type WindowId,
} from "@octant/contracts";
import { clampTurnAccessPosture } from "@octant/domain";
import { Schema } from "effect";
import {
  createBrowserAppManagedTools,
  type BrowserAppManagedToolsOptions,
  type BrowserModelBinding,
} from "../browser/browserAppManagedTools";
import { BROWSER_TOOL_DEFINITION } from "../browser/browserToolDefinition";
import type { Journal } from "../persistence/journal";
import {
  createAcpManagedToolsBridge,
  type AcpManagedToolsBridge,
} from "../providers/acpManagedTools";
import type { ManagedToolAnswer } from "../providers/managedMcpTools";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const TERMINAL_BROWSER_GRANT_AGGREGATE = "terminal-browser-grant";

const REFERENCE_PREFIX = "terminal-browser-grant:";
/**
 * When a call is what finds a grant over, its endpoint stays up this long so
 * the call is answered `unauthorized` instead of the connection being cut. The
 * grant refuses everything from the moment it ends; only the listener lingers.
 */
const ANSWER_GRACE_MS = 250;
const UNAUTHORIZED: ManagedToolAnswer = { resultJson: '{"error":"unauthorized"}', isError: true };
const UNAVAILABLE: ManagedToolAnswer = {
  resultJson: '{"error":"tool-unavailable"}',
  isError: true,
};

/** Who asked. Only the person at a local window may switch a grant on. */
export type TerminalBrowserGrantCaller = "local-window" | "remote-device";

export interface TerminalBrowserGrantServiceOptions {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  /** The rule Code already uses for a window to open a thread's Project. */
  readonly canAccessProject: (
    windowId: WindowId,
    projectId: CodeThread["projectId"],
  ) => boolean | Promise<boolean>;
  /** Whether the shell is still the running session the grant was minted for. */
  readonly terminalIsRunning: (terminalId: CodeTerminalId) => boolean;
  /**
   * The Browser this host lends a thread, in the same shape a managed turn is
   * given. Absent means the host lends none, and no grant is minted.
   */
  readonly browser?: {
    readonly resolveAuthority: BrowserAppManagedToolsOptions["resolveAuthority"];
    readonly automation: BrowserAppManagedToolsOptions["browser"];
    readonly approvals: NonNullable<BrowserAppManagedToolsOptions["approvals"]>;
  };
  readonly journal: Pick<Journal, "append">;
  /** Speaks for the person who asked, and who switches a grant off. */
  readonly personActor: EventActorValue;
  /** Speaks for the host when a lifecycle change or a shutdown ends a grant. */
  readonly hostActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export type TerminalBrowserGrantOpening =
  | {
      readonly kind: "granted";
      readonly outcome: Extract<TerminalBrowserGrantOutcome, { readonly status: "granted" }>;
      /** For the terminal's launch; resolved through {@link resolveReference}. */
      readonly credentialReferences: ReadonlyArray<{
        readonly environmentName: string;
        readonly reference: string;
      }>;
    }
  | {
      readonly kind: "refused";
      readonly outcome: Extract<TerminalBrowserGrantOutcome, { readonly status: "refused" }>;
    };

interface LiveGrant {
  readonly grantId: TerminalBrowserGrantId;
  readonly threadId: CodeThreadId;
  readonly browserThreadId: BrowserThreadId;
  readonly terminalId: CodeTerminalId;
  readonly windowId: WindowId;
  readonly issuedAt: Extract<
    TerminalBrowserGrantOutcome,
    { readonly status: "granted" }
  >["issuedAt"];
  /** Private to this grant, so a context a managed turn approved is asked about again. */
  readonly modelBindings: Map<string, BrowserModelBinding>;
  readonly stop: AbortController;
  readonly endpoint: AcpManagedToolsBridge;
  readonly environment: ReadonlyMap<string, string>;
  ended: boolean;
  /** Settles once the endpoint has stopped listening. */
  closed?: Promise<void>;
}

/**
 * Lets a provider CLI the person types into one Code thread terminal drive that
 * thread's Browser, and nothing else.
 *
 * A grant is minted for one terminal session of one thread, held in host memory
 * only, and served on a loopback endpoint of its own. The endpoint is the
 * session-scoped one ACP runtimes use; what it serves is the thread's Browser
 * tool set built the way a managed turn builds it, so the Browser's per-action
 * policy, origin approval, and Plan refusal are the existing ones, and the
 * Browser service records the thread's external-content taint on every page
 * read. The token and the address leave this service in exactly one place: the
 * environment of the terminal the grant was minted for.
 *
 * Every call re-reads the thread and the terminal, so a grant never outlives
 * what it was minted against even if a lifecycle notice is missed. A refused
 * call answers `unauthorized` and never throws.
 */
export class TerminalBrowserGrantService {
  readonly #options: TerminalBrowserGrantServiceOptions;
  readonly #byId = new Map<string, LiveGrant>();
  readonly #byTerminal = new Map<string, LiveGrant>();
  /** Ended grants whose endpoint is held open just long enough to answer a call in flight. */
  readonly #draining = new Set<LiveGrant>();
  readonly #personActor: EventActorValue;
  readonly #hostActor: EventActorValue;

  constructor(options: TerminalBrowserGrantServiceOptions) {
    this.#options = options;
    this.#personActor = decodeActor(options.personActor);
    this.#hostActor = decodeActor(options.hostActor);
  }

  /**
   * Mint a grant for a terminal that is about to start. Nothing is minted for
   * a caller that is not the person at a local window, for a thread that is
   * not an active Code thread this window can open, or when the thread has no
   * Browser to lend.
   */
  async open(input: {
    readonly caller: TerminalBrowserGrantCaller;
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly terminalId: CodeTerminalId;
  }): Promise<TerminalBrowserGrantOpening> {
    if (input.caller !== "local-window") return refused("not-local-window");
    const thread = this.#options.readThread(input.threadId);
    if (thread === undefined) return refused("not-a-code-thread");
    if (!isActive(thread)) return refused("thread-not-active");
    if (!(await this.#windowCanOpen(input.windowId, thread))) {
      return refused("window-cannot-open-thread");
    }
    const previous = this.#byTerminal.get(String(input.terminalId));
    if (previous !== undefined) {
      // A shell that exited without a notice leaves its grant behind; a shell
      // still running keeps the one it was started with.
      if (this.#options.terminalIsRunning(input.terminalId)) {
        return refused("terminal-already-granted");
      }
      this.#end(previous, "terminal-closed", this.#hostActor);
    }
    const modelBindings = new Map<string, BrowserModelBinding>();
    const browserThreadId = decodeBrowserThreadId(String(thread.id));
    if (this.#browserTools(input.windowId, thread, browserThreadId, modelBindings) === undefined) {
      return refused("browser-unavailable");
    }

    const grantId = decodeTerminalBrowserGrantId(this.#options.uuid());
    let grant: LiveGrant | undefined;
    let endpoint: AcpManagedToolsBridge;
    try {
      endpoint = await createAcpManagedToolsBridge(
        [BROWSER_TOOL_DEFINITION],
        (name, inputJson, signal) =>
          grant === undefined
            ? Promise.resolve(UNAUTHORIZED)
            : this.#call(grant, name, inputJson, signal),
      );
    } catch {
      return refused("grant-unavailable");
    }
    const token = bearerToken(endpoint);
    if (token === undefined) {
      await endpoint.close().catch(() => undefined);
      return refused("grant-unavailable");
    }
    // The checks above ran before the endpoint started; a second open for the
    // same terminal may have minted in the meantime.
    if (this.#byTerminal.has(String(input.terminalId))) {
      await endpoint.close().catch(() => undefined);
      return refused("terminal-already-granted");
    }
    const issuedAt = this.#options.clock();
    const live: LiveGrant = {
      grantId,
      threadId: thread.id,
      browserThreadId,
      terminalId: input.terminalId,
      windowId: input.windowId,
      issuedAt: decodeTimestamp(issuedAt),
      modelBindings,
      stop: new AbortController(),
      endpoint,
      environment: new Map([
        [`${REFERENCE_PREFIX}${grantId}:endpoint`, endpoint.server.url],
        [`${REFERENCE_PREFIX}${grantId}:token`, token],
      ]),
      ended: false,
    };
    grant = live;
    try {
      this.#append(grantId, 0, TERMINAL_BROWSER_GRANT_EVENT_NAMES.issued, this.#personActor, {
        kind: "terminal-browser-grant-issued",
        grantId,
        threadId: thread.id,
        terminalId: input.terminalId,
        windowId: input.windowId,
        issuedAt,
      });
    } catch {
      // A grant nobody can find in the journal is a grant nobody can account for.
      live.ended = true;
      live.stop.abort();
      await endpoint.close().catch(() => undefined);
      return refused("grant-unavailable");
    }
    this.#byId.set(String(grantId), live);
    this.#byTerminal.set(String(input.terminalId), live);
    return {
      kind: "granted",
      outcome: {
        status: "granted",
        grantId,
        threadId: thread.id,
        terminalId: input.terminalId,
        issuedAt: live.issuedAt,
      },
      credentialReferences: [
        {
          environmentName: TERMINAL_BROWSER_ENDPOINT_ENVIRONMENT,
          reference: `${REFERENCE_PREFIX}${grantId}:endpoint`,
        },
        {
          environmentName: TERMINAL_BROWSER_TOKEN_ENVIRONMENT,
          reference: `${REFERENCE_PREFIX}${grantId}:token`,
        },
      ],
    };
  }

  /**
   * The terminal's credential path. A reference {@link open} handed out is
   * answered here and never reaches the host's credential store, live or not;
   * a grant that has ended is unavailable, which fails the launch it was for.
   * Any other reference is the host's to answer.
   */
  async resolveCredential(
    reference: string,
    hostCredential: (reference: string) => Promise<string>,
  ): Promise<string> {
    if (!reference.startsWith(REFERENCE_PREFIX)) return hostCredential(reference);
    const value = this.resolveReference(reference);
    if (value === undefined) throw new Error("Credential is unavailable.");
    return value;
  }

  /**
   * The value behind a reference {@link open} handed out, for the terminal that
   * is starting with the grant. A grant that has ended, or any other reference,
   * has no value here.
   */
  resolveReference(reference: string): string | undefined {
    if (!reference.startsWith(REFERENCE_PREFIX)) return undefined;
    const [grantId] = reference.slice(REFERENCE_PREFIX.length).split(":");
    const grant = grantId === undefined ? undefined : this.#byId.get(grantId);
    if (grant === undefined || grant.ended) return undefined;
    return grant.environment.get(reference);
  }

  /**
   * A terminal that did not end up running after its grant was minted never ran
   * with it. Returns how the grant ended, or undefined when it held none.
   */
  abandon(
    terminalId: CodeTerminalId,
  ): Extract<TerminalBrowserGrantOutcome, { readonly status: "revoked" }> | undefined {
    const grant = this.#byTerminal.get(String(terminalId));
    return grant === undefined
      ? undefined
      : this.#end(grant, "terminal-not-started", this.#hostActor);
  }

  /**
   * The grant a running terminal of this thread holds, for a window that
   * attaches to it. A window shows the switch from this answer rather than from
   * what it remembers, so a grant it did not see start, or one that ended while
   * it looked elsewhere, reads as it is.
   */
  liveGrant(
    threadId: CodeThreadId,
    terminalId: CodeTerminalId,
  ): Extract<TerminalBrowserGrantOutcome, { readonly status: "granted" }> | undefined {
    const grant = this.#byTerminal.get(String(terminalId));
    if (grant === undefined || grant.ended || String(grant.threadId) !== String(threadId)) {
      return undefined;
    }
    return {
      status: "granted",
      grantId: grant.grantId,
      threadId: grant.threadId,
      terminalId: grant.terminalId,
      issuedAt: grant.issuedAt,
    };
  }

  /** The person switching a live grant off, without closing the terminal. */
  async switchOff(input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly terminalId: CodeTerminalId;
  }): Promise<Extract<TerminalBrowserGrantOutcome, { readonly status: "revoked" | "refused" }>> {
    const thread = this.#options.readThread(input.threadId);
    if (thread === undefined) return refusedOutcome("not-a-code-thread");
    if (!(await this.#windowCanOpen(input.windowId, thread))) {
      return refusedOutcome("window-cannot-open-thread");
    }
    const grant = this.#byTerminal.get(String(input.terminalId));
    if (grant === undefined || String(grant.threadId) !== String(input.threadId)) {
      return refusedOutcome("no-live-grant");
    }
    const outcome = this.#end(grant, "switched-off", this.#personActor);
    await this.#closeEndpoint(grant);
    return outcome;
  }

  /** The shell the grant was minted for has closed. */
  terminalClosed(terminalId: string): void {
    const grant = this.#byTerminal.get(terminalId);
    if (grant !== undefined) this.#end(grant, "terminal-closed", this.#hostActor);
  }

  /** The thread was completed, archived, or deleted: every grant it holds ends. */
  threadSettled(
    threadId: string,
    reason: Extract<
      TerminalBrowserGrantRevokeReason,
      "thread-completed" | "thread-archived" | "thread-deleted"
    >,
  ): void {
    for (const grant of this.#byId.values()) {
      if (String(grant.threadId) === threadId) this.#end(grant, reason, this.#hostActor);
    }
  }

  /** The window that switched a grant on no longer holds host authority. */
  revokeWindow(windowId: WindowId): void {
    for (const grant of this.#byId.values()) {
      if (String(grant.windowId) === String(windowId)) {
        this.#end(grant, "window-revoked", this.#hostActor);
      }
    }
  }

  /** A restarted host mints nothing by itself, so a stopping host ends every grant. */
  async close(): Promise<void> {
    const grants = [...this.#byId.values()];
    for (const grant of grants) this.#end(grant, "host-stopped", this.#hostActor);
    await Promise.allSettled(
      [...grants, ...this.#draining].map((grant) => this.#closeEndpoint(grant)),
    );
  }

  async #windowCanOpen(windowId: WindowId, thread: CodeThread): Promise<boolean> {
    try {
      return await this.#options.canAccessProject(windowId, thread.projectId);
    } catch {
      return false;
    }
  }

  async #call(
    grant: LiveGrant,
    name: string,
    inputJson: string,
    signal: AbortSignal,
  ): Promise<ManagedToolAnswer> {
    if (grant.ended) return UNAUTHORIZED;
    const thread = this.#options.readThread(grant.threadId);
    if (thread === undefined) {
      this.#end(grant, "thread-deleted", this.#hostActor, ANSWER_GRACE_MS);
      return UNAUTHORIZED;
    }
    if (thread.lifecycle !== "active") {
      this.#end(grant, "thread-archived", this.#hostActor, ANSWER_GRACE_MS);
      return UNAUTHORIZED;
    }
    if (thread.completedAt !== undefined) {
      this.#end(grant, "thread-completed", this.#hostActor, ANSWER_GRACE_MS);
      return UNAUTHORIZED;
    }
    if (!this.#options.terminalIsRunning(grant.terminalId)) {
      this.#end(grant, "terminal-closed", this.#hostActor, ANSWER_GRACE_MS);
      return UNAUTHORIZED;
    }
    if (!(await this.#windowCanOpen(grant.windowId, thread))) return UNAUTHORIZED;
    const tools = this.#browserTools(
      grant.windowId,
      thread,
      grant.browserThreadId,
      grant.modelBindings,
    );
    if (tools === undefined) return UNAVAILABLE;
    try {
      const outcome = await tools.execute({
        name,
        inputJson,
        signal: AbortSignal.any([signal, grant.stop.signal]),
      });
      if (grant.ended) return UNAUTHORIZED;
      return {
        resultJson: JSON.stringify(outcome.result),
        isError: outcome.isError === true,
        ...(outcome.images === undefined ? {} : { images: outcome.images }),
      };
    } catch {
      return UNAVAILABLE;
    }
  }

  /**
   * The thread's Browser tool set as a managed turn gets it, for this thread
   * only. Screenshots are not passed on as thread captures: no journal actor
   * describes a hand-typed CLI, so `capturedBy` is never named.
   */
  #browserTools(
    windowId: WindowId,
    thread: CodeThread,
    browserThreadId: BrowserThreadId,
    modelBindings: Map<string, BrowserModelBinding>,
  ) {
    const lent = this.#options.browser;
    if (lent === undefined) return undefined;
    const readPosture = () => {
      const current = this.#options.readThread(thread.id);
      return clampTurnAccessPosture({ thread: current?.executionPolicy ?? thread.executionPolicy });
    };
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId: browserThreadId,
      mode: "code",
      modelId: String(thread.modelId),
      resolveModelId: () => {
        const current = this.#options.readThread(thread.id);
        return current === undefined ? undefined : String(current.modelId);
      },
      modelBindings,
      resolveAuthority: lent.resolveAuthority,
      executionPolicy: readPosture(),
      ...(thread.toolConstraints === undefined ? {} : { toolConstraints: thread.toolConstraints }),
      browser: {
        inspectThread: lent.automation.inspectThread,
        create: lent.automation.create,
        act: ({ windowId: actingWindow, request }) =>
          lent.automation.act({ windowId: actingWindow, request }),
        releaseThread: lent.automation.releaseThread,
      },
      approvals: {
        request: async (request) => {
          const outcome = await lent.approvals.request(request);
          // An answer given while the thread moved into Plan is not an answer
          // to the question that was asked.
          return outcome === "approved" && readPosture() === "plan" ? "cancelled" : outcome;
        },
        ...(lent.approvals.isRemembered === undefined
          ? {}
          : { isRemembered: (origin: string) => lent.approvals.isRemembered?.(origin) === true }),
      },
      uuid: this.#options.uuid,
    });
    return tools.definitions.length === 0 ? undefined : tools;
  }

  #end(
    grant: LiveGrant,
    reason: TerminalBrowserGrantRevokeReason,
    actor: EventActorValue,
    closeAfterMs = 0,
  ): Extract<TerminalBrowserGrantOutcome, { readonly status: "revoked" }> {
    const revokedAt = this.#options.clock();
    if (!grant.ended) {
      grant.ended = true;
      this.#byId.delete(String(grant.grantId));
      if (this.#byTerminal.get(String(grant.terminalId)) === grant) {
        this.#byTerminal.delete(String(grant.terminalId));
      }
      grant.stop.abort();
      // Journaled before the first await: a thread purge that follows this
      // notice erases the grant's records along with the thread's.
      try {
        this.#append(grant.grantId, 1, TERMINAL_BROWSER_GRANT_EVENT_NAMES.revoked, actor, {
          kind: "terminal-browser-grant-revoked",
          grantId: grant.grantId,
          threadId: grant.threadId,
          terminalId: grant.terminalId,
          reason,
          revokedAt,
        });
      } catch {
        console.warn("Octant could not record that a terminal Browser grant ended.");
      }
      if (closeAfterMs <= 0) {
        void this.#closeEndpoint(grant);
      } else {
        this.#draining.add(grant);
        setTimeout(() => {
          this.#draining.delete(grant);
          void this.#closeEndpoint(grant);
        }, closeAfterMs).unref();
      }
    }
    return {
      status: "revoked",
      grantId: grant.grantId,
      threadId: grant.threadId,
      terminalId: grant.terminalId,
      reason,
      revokedAt: decodeTimestamp(revokedAt),
    };
  }

  #closeEndpoint(grant: LiveGrant): Promise<void> {
    grant.closed ??= grant.endpoint.close().catch(() => undefined);
    return grant.closed;
  }

  #append(
    grantId: TerminalBrowserGrantId,
    expectedVersion: number,
    eventName: string,
    actor: EventActorValue,
    payload: unknown,
  ): void {
    const decoded =
      eventName === TERMINAL_BROWSER_GRANT_EVENT_NAMES.issued
        ? decodeTerminalBrowserGrantIssued(payload)
        : decodeTerminalBrowserGrantRevoked(payload);
    this.#options.journal.append({
      aggregate: {
        aggregateType: TERMINAL_BROWSER_GRANT_AGGREGATE,
        aggregateId: decodeAggregateId(String(grantId)),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload: decoded,
        },
      ],
    });
  }
}

function isActive(thread: CodeThread): boolean {
  return thread.lifecycle === "active" && thread.completedAt === undefined;
}

function refusedOutcome(
  reason: TerminalBrowserGrantRefusalReason,
): Extract<TerminalBrowserGrantOutcome, { readonly status: "refused" }> {
  return { status: "refused", reason };
}

function refused(reason: TerminalBrowserGrantRefusalReason): TerminalBrowserGrantOpening {
  return { kind: "refused", outcome: refusedOutcome(reason) };
}

function bearerToken(endpoint: AcpManagedToolsBridge): string | undefined {
  const header = endpoint.server.headers.find(
    (candidate) => candidate.name.toLowerCase() === "authorization",
  );
  const prefix = "Bearer ";
  return header?.value.startsWith(prefix) === true ? header.value.slice(prefix.length) : undefined;
}
