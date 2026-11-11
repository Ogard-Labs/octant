import {
  createHash,
  randomBytes as defaultRandomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  AGENT_ACCESS_AGGREGATE,
  AGENT_ACCESS_EVENT_NAMES,
  AGENT_CONNECTION_CODE_PREFIX,
  AGENT_GRANT_IDLE_DAYS,
  AGENT_TICKET_TTL_MS,
  MAX_AGENT_GRANT_KEYS,
  MAX_AGENT_GRANTS,
  bearerGrantToken,
  decodeAgentAccessResult,
  decodeAgentClaimRequest,
  decodeAgentGrantScope,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  UtcTimestamp,
  type AgentAccessCommand,
  type AgentAccessResult,
  type AgentGrant,
  type AgentGrantMode,
  type AgentGrantScope,
  type AgentGrantView,
  type AgentThreadAttribution,
  type AgentPendingClaim,
  type EventActor,
} from "@octant/contracts";
import { agentProofPayload } from "@octant/domain";
import { Schema } from "effect";
import { canonicalDeviceKeyFacts } from "../remote/deviceKeyFacts";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { Journal } from "../persistence/journal";
import {
  readAgentGrantRecord,
  readAgentGrants,
  readAgentThread,
  readAgentThreadAttributions,
  readAgentThreads,
  type AgentThreadRecord,
} from "../persistence/agentAccessProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const DAY_MS = 24 * 60 * 60 * 1_000;
const PROOF_SKEW_MS = 30_000;
const NONCE_TTL_MS = 60_000;
const MAX_TICKET_FAILURES = 5;
const LAST_USE_WRITE_INTERVAL_MS = 60_000;
const BEARER_PATTERN = /^oak_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const PROOF_PATTERN =
  /^v1\.([0-9a-f-]{36})\.([0-9a-f]{64})\.(\d{10,16})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,200})$/;

export type AgentSourceClass = "lan-private" | "tailscale";

export interface AgentListenerFacts {
  readonly origin: string;
  /** The self-made certificate's pin; absent for a certificate the person serves. */
  readonly pin?: string;
  readonly hostId: string;
}

export interface AgentAccessServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Pick<Journal, "append">;
  readonly uuid: () => string;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** The private listener's origin, certificate pin, and host id, while it is on. */
  readonly listener: () => AgentListenerFacts | undefined;
  /** An active Project's type, or undefined when no active Project has the id. */
  readonly projectType: (projectId: string) => "chat" | "work" | "code" | undefined;
}

/** Who made a grant change, for the journal. */
export type AgentAccessActor = EventActor;

export type AgentAuthentication =
  | {
      readonly kind: "authenticated";
      readonly grant: AgentGrant;
      readonly credential: "bridge" | "direct";
      /** Ends when the grant is revoked or changed. */
      readonly signal: AbortSignal;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "limited"; readonly retryAfterSeconds: number };

interface Ticket {
  readonly grantId: string;
  readonly proofDigest: Buffer;
  readonly expiresAt: number;
  failures: number;
}

interface PendingKey {
  readonly label: string;
  readonly publicKey: string;
  readonly claimedAt: UtcTimestamp;
}

/**
 * Agent grants: who may reach this host as an outside agent, with what scope,
 * through which credentials. The journal holds every grant fact; tickets,
 * unconfirmed claims, nonces, and use counters live in this process only, so a
 * restart forgets them and nothing half-made survives it.
 */
export class AgentAccessService {
  readonly #options: AgentAccessServiceOptions;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #tickets = new Map<string, Ticket>();
  readonly #pending = new Map<string, Map<string, PendingKey>>();
  readonly #nonces = new Map<string, Map<string, number>>();
  readonly #requests = new Map<string, Array<number>>();
  readonly #turns = new Map<string, Array<number>>();
  readonly #signals = new Map<string, AbortController>();
  readonly #lastUseWrite = new Map<string, number>();
  readonly #revokedListeners = new Set<(grant: AgentGrant) => void>();

  constructor(options: AgentAccessServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? ((size) => defaultRandomBytes(size));
  }

  /** Called with each grant the moment it is revoked or expires. */
  onRevoked(listener: (grant: AgentGrant) => void): () => void {
    this.#revokedListeners.add(listener);
    return () => this.#revokedListeners.delete(listener);
  }

  list(): ReadonlyArray<AgentGrantView> {
    return readAgentGrants(this.#options.connection).map((grant) => this.#view(grant));
  }

  read(grantId: string): AgentGrant | undefined {
    return readAgentGrantRecord(this.#options.connection, grantId)?.grant;
  }

  execute(command: AgentAccessCommand, actor: AgentAccessActor): AgentAccessResult {
    switch (command.kind) {
      case "create":
        return this.#create(command.draft.name, command.draft.scope, command.draft.days, actor);
      case "change":
        return this.#change(command, actor);
      case "revoke":
        return this.#revokeByPerson(command.grantId, actor);
      case "issue-ticket":
        return this.#issueTicket(command.grantId);
      case "confirm-key":
        return this.#confirmKey(command.grantId, command.fingerprint, actor);
      case "remove-key":
        return this.#removeKey(command.grantId, command.fingerprint, actor);
      case "rotate-direct-key":
        return this.#rotateDirectKey(command.grantId, actor);
    }
  }

  /**
   * An agent's machine claims a ticket with the public key it just made. The
   * key is held as pending until the person confirms its fingerprint; a bad
   * proof counts against the ticket and every failure answers the same.
   */
  claim(
    body: unknown,
  ): { readonly kind: "pending"; readonly grantId: string } | { readonly kind: "refused" } {
    let request;
    try {
      request = decodeAgentClaimRequest(body);
    } catch {
      return { kind: "refused" };
    }
    const ticket = this.#tickets.get(String(request.ticketId));
    if (ticket === undefined || ticket.expiresAt <= this.#now()) {
      this.#tickets.delete(String(request.ticketId));
      return { kind: "refused" };
    }
    const offered = sha256(Buffer.from(request.ticketProof, "base64url"));
    if (!timingSafeEqual(offered, ticket.proofDigest)) {
      ticket.failures += 1;
      if (ticket.failures >= MAX_TICKET_FAILURES) this.#tickets.delete(String(request.ticketId));
      return { kind: "refused" };
    }
    const facts = canonicalDeviceKeyFacts(request.publicKey);
    const grant = this.read(ticket.grantId);
    if (facts === undefined || facts.fingerprint !== request.fingerprint || !isActive(grant)) {
      this.#tickets.delete(String(request.ticketId));
      return { kind: "refused" };
    }
    this.#tickets.delete(String(request.ticketId));
    const pending = this.#pending.get(ticket.grantId) ?? new Map<string, PendingKey>();
    pending.set(facts.fingerprint, {
      label: request.label,
      publicKey: facts.canonicalPem,
      claimedAt: iso(this.#now()),
    });
    this.#pending.set(ticket.grantId, pending);
    return { kind: "pending", grantId: ticket.grantId };
  }

  /**
   * Checks one agent request's credential. Bridge requests are signed over the
   * exact request with an enrolled key; direct requests carry the bearer key.
   * Every failure is `unauthorized`, whatever the reason.
   */
  authenticate(input: {
    readonly method: string;
    readonly pathWithQuery: string;
    readonly body: Uint8Array;
    readonly proof: string | null;
    readonly authorization: string | null;
    readonly sourceClass: AgentSourceClass;
  }): AgentAuthentication {
    const now = this.#now();
    const listener = this.#options.listener();
    if (listener === undefined) return { kind: "unauthorized" };
    let grant: AgentGrant | undefined;
    let credential: "bridge" | "direct";
    if (input.proof !== null) {
      const match = PROOF_PATTERN.exec(input.proof);
      if (match === null) return { kind: "unauthorized" };
      const [, grantId = "", fingerprint = "", timestamp = "", nonce = "", signature = ""] = match;
      grant = this.read(grantId);
      const key = grant?.keys.find((entry) => entry.fingerprint === fingerprint);
      const at = Number(timestamp);
      if (grant === undefined || key === undefined || Math.abs(now - at) > PROOF_SKEW_MS) {
        return { kind: "unauthorized" };
      }
      const payload = agentProofPayload({
        method: input.method,
        pathWithQuery: input.pathWithQuery,
        bodyDigest: createHash("sha256").update(input.body).digest("hex"),
        timestamp,
        nonce,
        hostId: listener.hostId,
        grantId,
        fingerprint,
      });
      if (!verifyP256(key.publicKey, payload, signature)) return { kind: "unauthorized" };
      if (!this.#takeNonce(grantId, nonce, now)) return { kind: "unauthorized" };
      credential = "bridge";
    } else if (input.authorization !== null && input.authorization.startsWith("Bearer ")) {
      const match = BEARER_PATTERN.exec(input.authorization.slice("Bearer ".length).trim());
      if (match === null) return { kind: "unauthorized" };
      const grantId = grantIdFromToken(match[1] ?? "");
      grant = this.read(grantId);
      if (grant === undefined || !grant.scope.direct) return { kind: "unauthorized" };
      const stored = this.#credential(grantId);
      if (stored?.salt === null || stored?.hash === null || stored === undefined) {
        return { kind: "unauthorized" };
      }
      const offered = Buffer.from(bearerHash(stored.salt, match[2] ?? ""), "hex");
      if (!timingSafeEqual(offered, Buffer.from(stored.hash, "hex"))) {
        return { kind: "unauthorized" };
      }
      credential = "direct";
    } else {
      return { kind: "unauthorized" };
    }
    if (!isActive(grant)) return { kind: "unauthorized" };
    if (Date.parse(grant.expiresAt) <= now) {
      this.#revoke(grant, "expired", systemActor());
      return { kind: "unauthorized" };
    }
    const lastUse = this.#credential(String(grant.grantId))?.last_used_at;
    const idleSince = Date.parse(lastUse ?? grant.createdAt);
    if (now - idleSince > AGENT_GRANT_IDLE_DAYS * DAY_MS) {
      this.#revoke(grant, "idle", systemActor());
      return { kind: "unauthorized" };
    }
    const window = recent(this.#requests, String(grant.grantId), now, 60_000);
    if (window.length >= grant.scope.limits.requestsPerMinute) {
      return { kind: "limited", retryAfterSeconds: 60 };
    }
    window.push(now);
    this.#recordUse(String(grant.grantId), input.sourceClass, now);
    return {
      kind: "authenticated",
      grant,
      credential,
      signal: this.#signal(String(grant.grantId)),
    };
  }

  /** Counts one turn against the grant's daily limit, or refuses it. */
  takeTurn(grantId: string): boolean {
    const grant = this.read(grantId);
    if (!isActive(grant)) return false;
    const now = this.#now();
    const turns = recent(this.#turns, grantId, now, DAY_MS);
    if (turns.length >= grant.scope.limits.turnsPerDay) return false;
    turns.push(now);
    return true;
  }

  /** Journals that an agent started a thread, so it is its own from then on. */
  recordThreadStarted(input: {
    readonly grantId: string;
    readonly threadId: string;
    readonly mode: AgentGrantMode;
    readonly projectId?: string;
  }): void {
    const record = readAgentGrantRecord(this.#options.connection, input.grantId);
    if (record === undefined) return;
    this.#append(
      input.grantId,
      record.version,
      AGENT_ACCESS_EVENT_NAMES.threadStarted,
      systemActor(),
      {
        grantId: input.grantId,
        threadId: input.threadId,
        mode: input.mode,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        startedAt: iso(this.#now()),
      },
    );
  }

  threadOwner(threadId: string): AgentThreadRecord | undefined {
    return readAgentThread(this.#options.connection, threadId);
  }

  threadsOf(grantId: string): ReadonlyArray<AgentThreadRecord> {
    return readAgentThreads(this.#options.connection, grantId);
  }

  /** Every thread an outside agent started, with its agent's name, for "Started by" labels. */
  attributions(): ReadonlyArray<AgentThreadAttribution> {
    return readAgentThreadAttributions(this.#options.connection);
  }

  /** The grant a product-layer scope id belongs to, for attribution. */
  grantForScope(scopeId: string): AgentGrant | undefined {
    return readAgentGrants(this.#options.connection).find(
      (grant) => String(grant.scopeId) === scopeId,
    );
  }

  /** Ends every grant past its absolute or idle limit; run at start and on a timer. */
  reconcileExpired(): void {
    const now = this.#now();
    for (const grant of readAgentGrants(this.#options.connection)) {
      if (!isActive(grant)) continue;
      const lastUse = this.#credential(String(grant.grantId))?.last_used_at;
      if (Date.parse(grant.expiresAt) <= now) this.#revoke(grant, "expired", systemActor());
      else if (now - Date.parse(lastUse ?? grant.createdAt) > AGENT_GRANT_IDLE_DAYS * DAY_MS) {
        this.#revoke(grant, "idle", systemActor());
      }
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  #create(
    name: string,
    scope: AgentGrantScope,
    days: number,
    actor: EventActor,
  ): AgentAccessResult {
    const invalid = this.#invalidScope(scope);
    if (invalid !== undefined) return refused("invalid", invalid);
    const active = readAgentGrants(this.#options.connection).filter(isActive);
    if (active.length >= MAX_AGENT_GRANTS) {
      return refused("too-many", `At most ${MAX_AGENT_GRANTS} agent grants can be active.`);
    }
    const grantId = this.#options.uuid();
    const now = this.#now();
    this.#append(grantId, 0, AGENT_ACCESS_EVENT_NAMES.grantCreated, actor, {
      grantId,
      scopeId: this.#options.uuid(),
      name,
      scope,
      createdAt: iso(now),
      expiresAt: iso(now + days * DAY_MS),
    });
    return this.#grantResult(grantId);
  }

  #change(
    command: Extract<AgentAccessCommand, { kind: "change" }>,
    actor: EventActor,
  ): AgentAccessResult {
    const record = readAgentGrantRecord(this.#options.connection, String(command.grantId));
    if (record === undefined) return refused("not-found", "No agent grant has that id.");
    if (!isActive(record.grant)) return refused("revoked", "That agent grant is revoked.");
    if (record.grant.generation !== command.expectedGeneration) {
      return refused("stale", "The grant changed elsewhere first; read it again.");
    }
    const invalid = this.#invalidScope(command.scope);
    if (invalid !== undefined) return refused("invalid", invalid);
    this.#append(
      String(command.grantId),
      record.version,
      AGENT_ACCESS_EVENT_NAMES.grantChanged,
      actor,
      {
        grantId: command.grantId,
        name: command.name,
        scope: command.scope,
        generation: record.grant.generation + 1,
        changedAt: iso(this.#now()),
      },
    );
    if (!command.scope.direct) this.#clearBearer(String(command.grantId));
    this.#endSessions(String(command.grantId));
    return this.#grantResult(String(command.grantId));
  }

  #revokeByPerson(grantId: string, actor: EventActor): AgentAccessResult {
    const grant = this.read(grantId);
    if (grant === undefined) return refused("not-found", "No agent grant has that id.");
    if (!isActive(grant)) return { kind: "done" };
    this.#revoke(grant, "person", actor);
    return { kind: "done" };
  }

  #issueTicket(grantId: string): AgentAccessResult {
    const grant = this.read(grantId);
    if (grant === undefined) return refused("not-found", "No agent grant has that id.");
    if (!isActive(grant)) return refused("revoked", "That agent grant is revoked.");
    const listener = this.#options.listener();
    if (listener === undefined) {
      return refused(
        "listener-off",
        "Remote access is off. Turn the private listener on (octant listener enable) first.",
      );
    }
    const now = this.#now();
    for (const [id, ticket] of this.#tickets) if (ticket.expiresAt <= now) this.#tickets.delete(id);
    const ticketId = this.#options.uuid();
    const proof = Buffer.from(this.#randomBytes(32));
    const expiresAt = now + AGENT_TICKET_TTL_MS;
    this.#tickets.set(ticketId, {
      grantId,
      proofDigest: sha256(proof),
      expiresAt,
      failures: 0,
    });
    const code = {
      origin: listener.origin,
      hostId: listener.hostId,
      grantId,
      ticketId,
      ticketProof: proof.toString("base64url"),
      ...(listener.pin === undefined ? {} : { pin: listener.pin }),
    };
    return {
      kind: "ticket",
      connectionCode: `${AGENT_CONNECTION_CODE_PREFIX}${Buffer.from(JSON.stringify(code)).toString("base64url")}`,
      expiresAt: iso(expiresAt),
    };
  }

  #confirmKey(grantId: string, fingerprint: string, actor: EventActor): AgentAccessResult {
    const record = readAgentGrantRecord(this.#options.connection, grantId);
    if (record === undefined) return refused("not-found", "No agent grant has that id.");
    if (!isActive(record.grant)) return refused("revoked", "That agent grant is revoked.");
    const pending = this.#pending.get(grantId)?.get(fingerprint);
    if (pending === undefined) {
      return refused("not-pending", "No key with that fingerprint is waiting to be confirmed.");
    }
    if (record.grant.keys.length >= MAX_AGENT_GRANT_KEYS) {
      return refused("too-many", `A grant holds at most ${MAX_AGENT_GRANT_KEYS} keys.`);
    }
    this.#append(grantId, record.version, AGENT_ACCESS_EVENT_NAMES.keyEnrolled, actor, {
      grantId,
      key: {
        fingerprint,
        publicKey: pending.publicKey,
        label: pending.label,
        enrolledAt: iso(this.#now()),
      },
    });
    this.#pending.get(grantId)?.delete(fingerprint);
    return this.#grantResult(grantId);
  }

  #removeKey(grantId: string, fingerprint: string, actor: EventActor): AgentAccessResult {
    const record = readAgentGrantRecord(this.#options.connection, grantId);
    if (record === undefined) return refused("not-found", "No agent grant has that id.");
    if (!record.grant.keys.some((key) => key.fingerprint === fingerprint)) {
      return refused("not-found", "That grant has no key with that fingerprint.");
    }
    this.#append(grantId, record.version, AGENT_ACCESS_EVENT_NAMES.keyRemoved, actor, {
      grantId,
      fingerprint,
      generation: record.grant.generation + 1,
      removedAt: iso(this.#now()),
    });
    this.#endSessions(grantId);
    return this.#grantResult(grantId);
  }

  #rotateDirectKey(grantId: string, actor: EventActor): AgentAccessResult {
    const record = readAgentGrantRecord(this.#options.connection, grantId);
    if (record === undefined) return refused("not-found", "No agent grant has that id.");
    if (!isActive(record.grant)) return refused("revoked", "That agent grant is revoked.");
    if (!record.grant.scope.direct) {
      return refused("invalid", "Turn direct access on for this grant before issuing a key.");
    }
    const listener = this.#options.listener();
    if (listener === undefined) {
      return refused("listener-off", "Remote access is off. Turn the private listener on first.");
    }
    const secret = Buffer.from(this.#randomBytes(32)).toString("base64url");
    const salt = Buffer.from(this.#randomBytes(16)).toString("hex");
    this.#options.connection
      .prepare(
        `INSERT INTO agent_access_credential_store (grant_id, salt, hash) VALUES (?, ?, ?)
         ON CONFLICT(grant_id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`,
      )
      .run(grantId, salt, bearerHash(salt, secret));
    this.#append(grantId, record.version, AGENT_ACCESS_EVENT_NAMES.directKeyRotated, actor, {
      grantId,
      generation: record.grant.generation + 1,
      rotatedAt: iso(this.#now()),
    });
    this.#endSessions(grantId);
    return {
      kind: "direct-key",
      key: `oak_${bearerGrantToken(grantId)}_${secret}`,
      endpoint: new URL("/api/agent-access/mcp", listener.origin).toString(),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #invalidScope(scope: AgentGrantScope): string | undefined {
    try {
      decodeAgentGrantScope(scope);
    } catch {
      return "The grant's scope is not valid.";
    }
    for (const projectId of scope.projects) {
      const type = this.#options.projectType(String(projectId));
      if (type === undefined) return `No active Project has the id ${String(projectId)}.`;
      if (type !== "chat" && !scope.modes.includes(type)) {
        return `A ${type} Project needs the ${type} mode in the grant.`;
      }
    }
    if (scope.projects.length === 0 && scope.modes.some((mode) => mode !== "chat")) {
      return "Work and Code need at least one Project in the grant.";
    }
    return undefined;
  }

  #revoke(grant: AgentGrant, reason: "person" | "expired" | "idle", actor: EventActor): void {
    const record = readAgentGrantRecord(this.#options.connection, String(grant.grantId));
    if (record === undefined || !isActive(record.grant)) return;
    this.#append(
      String(grant.grantId),
      record.version,
      AGENT_ACCESS_EVENT_NAMES.grantRevoked,
      actor,
      {
        grantId: grant.grantId,
        reason,
        generation: record.grant.generation + 1,
        revokedAt: iso(this.#now()),
      },
    );
    this.#clearBearer(String(grant.grantId));
    this.#pending.delete(String(grant.grantId));
    for (const [id, ticket] of this.#tickets) {
      if (ticket.grantId === String(grant.grantId)) this.#tickets.delete(id);
    }
    this.#endSessions(String(grant.grantId));
    const revoked = this.read(String(grant.grantId));
    if (revoked !== undefined) for (const listener of this.#revokedListeners) listener(revoked);
  }

  #signal(grantId: string): AbortSignal {
    const existing = this.#signals.get(grantId);
    if (existing !== undefined && !existing.signal.aborted) return existing.signal;
    const controller = new AbortController();
    this.#signals.set(grantId, controller);
    return controller.signal;
  }

  #endSessions(grantId: string): void {
    this.#signals.get(grantId)?.abort();
    this.#signals.delete(grantId);
    this.#nonces.delete(grantId);
  }

  #takeNonce(grantId: string, nonce: string, now: number): boolean {
    const seen = this.#nonces.get(grantId) ?? new Map<string, number>();
    for (const [value, expiresAt] of seen) if (expiresAt <= now) seen.delete(value);
    if (seen.has(nonce)) return false;
    seen.set(nonce, now + NONCE_TTL_MS);
    this.#nonces.set(grantId, seen);
    return true;
  }

  #credential(grantId: string):
    | {
        readonly salt: string | null;
        readonly hash: string | null;
        readonly last_used_at: string | null;
        readonly last_source_class: AgentSourceClass | null;
      }
    | undefined {
    return this.#options.connection
      .prepare(
        `SELECT salt, hash, last_used_at, last_source_class FROM agent_access_credential_store
         WHERE grant_id = ?`,
      )
      .get(grantId) as
      | {
          readonly salt: string | null;
          readonly hash: string | null;
          readonly last_used_at: string | null;
          readonly last_source_class: AgentSourceClass | null;
        }
      | undefined;
  }

  #clearBearer(grantId: string): void {
    this.#options.connection
      .prepare(
        `UPDATE agent_access_credential_store SET salt = NULL, hash = NULL WHERE grant_id = ?`,
      )
      .run(grantId);
  }

  #recordUse(grantId: string, sourceClass: AgentSourceClass, now: number): void {
    const last = this.#lastUseWrite.get(grantId) ?? 0;
    if (now - last < LAST_USE_WRITE_INTERVAL_MS) return;
    this.#lastUseWrite.set(grantId, now);
    this.#options.connection
      .prepare(
        `INSERT INTO agent_access_credential_store (grant_id, last_used_at, last_source_class)
         VALUES (?, ?, ?)
         ON CONFLICT(grant_id) DO UPDATE SET
           last_used_at = excluded.last_used_at, last_source_class = excluded.last_source_class`,
      )
      .run(grantId, iso(now), sourceClass);
  }

  #view(grant: AgentGrant): AgentGrantView {
    const grantId = String(grant.grantId);
    const stored = this.#credential(grantId);
    const pending: ReadonlyArray<AgentPendingClaim> = [
      ...(this.#pending.get(grantId)?.entries() ?? []),
    ].map(([fingerprint, entry]) => ({
      grantId: grant.grantId,
      fingerprint,
      label: entry.label,
      claimedAt: entry.claimedAt,
    }));
    return {
      grant,
      pendingClaims: pending,
      directKey: stored?.hash !== null && stored?.hash !== undefined,
      ...(stored?.last_used_at === null || stored?.last_used_at === undefined
        ? {}
        : { lastUsedAt: decodeTimestamp(stored.last_used_at) }),
      ...(stored?.last_source_class === null || stored?.last_source_class === undefined
        ? {}
        : { lastSourceClass: stored.last_source_class }),
      threadsStarted: this.threadsOf(grantId).length,
      turnsToday: recent(this.#turns, grantId, this.#now(), DAY_MS).length,
    };
  }

  #grantResult(grantId: string): AgentAccessResult {
    const grant = this.read(grantId);
    return grant === undefined
      ? refused("not-found", "No agent grant has that id.")
      : decodeAgentAccessResult({ kind: "grant", grant: this.#view(grant) });
  }

  #append(
    grantId: string,
    expectedVersion: number,
    eventName: string,
    actor: EventActor,
    payload: unknown,
  ): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: AGENT_ACCESS_AGGREGATE,
        aggregateId: decodeAggregateId(grantId),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor,
          occurredAt: iso(this.#now()),
          payload,
        },
      ],
    });
  }
}

function isActive(grant: AgentGrant | undefined): grant is AgentGrant {
  return grant !== undefined && grant.state === "active";
}

function verifyP256(publicKey: string, payload: string, signature: string): boolean {
  try {
    return verify(
      "sha256",
      Buffer.from(payload, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function bearerHash(salt: string, secret: string): string {
  return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

function grantIdFromToken(token: string): string {
  return `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`;
}

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function recent(
  store: Map<string, Array<number>>,
  key: string,
  now: number,
  windowMs: number,
): Array<number> {
  const kept = (store.get(key) ?? []).filter((at) => now - at < windowMs);
  store.set(key, kept);
  return kept;
}

function iso(at: number): UtcTimestamp {
  return decodeTimestamp(new Date(at).toISOString());
}

/** The host itself, for facts no person decided: an expiry, a thread an agent started. */
function systemActor(): EventActor {
  return { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID };
}

/** The person at this host, for grant changes made at a local window or the loopback CLI. */
export const AGENT_ACCESS_LOCAL_ACTOR: EventActor = {
  kind: "local-user",
  actorId: OCTANT_LOCAL_ACTOR_ID,
};

function refused(
  reason: Extract<AgentAccessResult, { kind: "refused" }>["reason"],
  message: string,
): AgentAccessResult {
  return { kind: "refused", reason, message };
}
