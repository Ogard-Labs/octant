import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  AggregateId,
  AggregateVersion,
  MAX_SHIELD_TAGGED_COMMAND_LENGTH,
  SHIELD_TAG_EVENT_NAMES,
  SHIELD_TAGS_AGGREGATE,
  type ShieldTag,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  decodeShieldServerRemovedPayload,
  decodeShieldServerSetPayload,
  MAX_SHIELD_REMOTE_COMMAND_LENGTH,
  MAX_SHIELD_SERVERS,
  SHIELD_REMOTE_COMMAND_EVENT_NAMES,
  SHIELD_REMOTE_COMMANDS_AGGREGATE,
  SHIELD_SERVERS_AGGREGATE,
  SHIELD_SERVERS_AGGREGATE_ID,
  SHIELD_SERVERS_EVENT_NAMES,
  type ShieldRemoteCommandStatus,
  type ShieldServer,
  type ShieldServerFields,
  type ShieldServersRefusalReason,
} from "@octant/contracts/shield-servers";
import {
  MAX_SHIELD_RUNBOOK_CONTEXT_LENGTH,
  parseSshInvocation,
  registeredServerFor,
  shieldServerContext,
} from "@octant/domain/shield-server-policy";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { redactSecretShaped } from "../providers/providerApprovalCall";

/**
 * The servers a person registered with Octant Shield, journaled and rebuilt
 * from the journal at startup, the record of every `ssh` command a thread
 * ran, and the tags Shield puts on commands it does not judge. Canonical: docs/architecture.md § Octant Shield (servers over
 * SSH).
 *
 * Every change is one `shield-servers.server-set@1` (the whole record) or
 * `shield-servers.server-removed@1`, journal first: a server whose event
 * cannot be appended is not registered. Only a person at a local window
 * changes the registry.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const REPLAY_BATCH = 500;
/** What the record can name as a host; an address with a port or brackets is left out. */
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;

/**
 * Folders that hold keys and credentials. A runbook there would hand their
 * contents to the agent as context, so the registry refuses it.
 */
const CREDENTIAL_FOLDER =
  /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gh|Library\/Keychains)(?:\/|$)|\/\.(?:netrc|git-credentials|npmrc|pypirc)$|\.(?:pem|key|p12|pfx)$/i;

export type ShieldServerPrincipal = "local-window" | "remote-device";

export type ShieldServersChange =
  | { readonly kind: "changed"; readonly server?: ShieldServer }
  | { readonly kind: "refused"; readonly reason: ShieldServersRefusalReason };

export interface ShieldServerStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "aggregateVersions">;
  readonly personActor: EventActorValue;
  /** Who records a remote command: the host, on the thread's behalf. */
  readonly hostActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
  /** Reads a runbook, at most `maxBytes`; undefined when the file cannot be read. */
  readonly readRunbook?: (path: string, maxBytes: number) => string | undefined;
}

export class ShieldServerStore {
  readonly #options: ShieldServerStoreOptions;
  readonly #personActor: EventActorValue;
  readonly #hostActor: EventActorValue;
  readonly #servers = new Map<string, ShieldServer>();
  readonly #versions = new Map<string, number>();

  constructor(options: ShieldServerStoreOptions) {
    this.#options = options;
    this.#personActor = decodeActor(options.personActor);
    this.#hostActor = decodeActor(options.hostActor);
  }

  /** Rebuilds the registry from the journal, in journal order. A record that no longer decodes changes nothing. */
  load(): void {
    this.#servers.clear();
    let after = 0;
    for (;;) {
      const batch = this.#options.journal.replayAggregateType({
        aggregateType: SHIELD_SERVERS_AGGREGATE,
        afterSequence: after,
        limit: REPLAY_BATCH,
      });
      for (const envelope of batch) {
        after = envelope.globalSequence;
        try {
          this.#apply(envelope.eventName, envelope.payload);
        } catch {
          // An unreadable record registers nothing; the registry keeps what it had.
        }
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    for (const aggregateType of [
      SHIELD_SERVERS_AGGREGATE,
      SHIELD_REMOTE_COMMANDS_AGGREGATE,
      SHIELD_TAGS_AGGREGATE,
    ]) {
      for (const { aggregateId, aggregateVersion } of this.#options.journal.aggregateVersions(
        aggregateType,
      )) {
        this.#versions.set(`${aggregateType}/${aggregateId}`, aggregateVersion);
      }
    }
  }

  servers(): ReadonlyArray<ShieldServer> {
    return [...this.#servers.values()];
  }

  register(input: {
    readonly server: ShieldServerFields;
    readonly principal: ShieldServerPrincipal;
  }): ShieldServersChange {
    if (input.principal !== "local-window") return refused("needs-local-window");
    if (this.#servers.size >= MAX_SHIELD_SERVERS) return refused("too-many-servers");
    return this.#set({ serverId: decodeAggregateId(this.#options.uuid()), ...input.server });
  }

  change(input: {
    readonly serverId: string;
    readonly server: ShieldServerFields;
    readonly principal: ShieldServerPrincipal;
  }): ShieldServersChange {
    if (input.principal !== "local-window") return refused("needs-local-window");
    const existing = this.#servers.get(input.serverId);
    if (existing === undefined) return refused("server-not-found");
    return this.#set({ ...input.server, serverId: existing.serverId });
  }

  remove(input: {
    readonly serverId: string;
    readonly principal: ShieldServerPrincipal;
  }): ShieldServersChange {
    if (input.principal !== "local-window") return refused("needs-local-window");
    const existing = this.#servers.get(input.serverId);
    if (existing === undefined) return refused("server-not-found");
    const payload = { serverId: existing.serverId, principal: { kind: "local-window" as const } };
    if (!this.#appendRegistry(SHIELD_SERVERS_EVENT_NAMES.serverRemoved, payload)) {
      return refused("unavailable");
    }
    this.#apply(SHIELD_SERVERS_EVENT_NAMES.serverRemoved, payload);
    return { kind: "changed" };
  }

  /**
   * Journals one `ssh` command a thread ran, with the host it named, the
   * registered server when it is one, and how it ended. A command with `ssh`
   * in command position is recorded even when its host cannot be read; one
   * without is not a remote command. The command is redacted and cut; its
   * output is not kept here.
   */
  recordRemoteCommand(input: {
    readonly threadId: string;
    readonly command: string;
    readonly status: ShieldRemoteCommandStatus;
    readonly exitCode?: number | undefined;
  }): "recorded" | "not-remote" | "unavailable" {
    const ssh = parseSshInvocation(input.command);
    if (ssh.kind === "not-ssh") return "not-remote";
    const host = ssh.host !== undefined && ALIAS.test(ssh.host) ? ssh.host : undefined;
    const server = host === undefined ? undefined : registeredServerFor(this.servers(), host);
    const redacted = redactSecretShaped(input.command.trim());
    let threadId: AggregateId;
    try {
      threadId = decodeAggregateId(input.threadId);
    } catch {
      return "unavailable";
    }
    const payload = {
      threadId,
      ...(host === undefined ? {} : { host }),
      ...(server === undefined ? {} : { serverId: server.serverId }),
      command:
        redacted.length > MAX_SHIELD_REMOTE_COMMAND_LENGTH
          ? `${redacted.slice(0, MAX_SHIELD_REMOTE_COMMAND_LENGTH - 1)}…`
          : redacted,
      status: input.status,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ranAt: this.#options.clock(),
    };
    return this.#append(
      SHIELD_REMOTE_COMMANDS_AGGREGATE,
      String(threadId),
      SHIELD_REMOTE_COMMAND_EVENT_NAMES.ran,
      payload,
      this.#hostActor,
    )
      ? "recorded"
      : "unavailable";
  }

  /**
   * Journals a tag Shield put on a command it did not judge (Full access),
   * under the thread, with the command redacted and cut. The tag changes
   * nothing about the command; `unavailable` means it could not be kept.
   */
  recordTag(input: {
    readonly threadId: string;
    readonly tag: ShieldTag;
    readonly command: string;
  }): "recorded" | "unavailable" {
    let threadId: AggregateId;
    try {
      threadId = decodeAggregateId(input.threadId);
    } catch {
      return "unavailable";
    }
    const redacted = redactSecretShaped(input.command.trim());
    const payload = {
      threadId,
      tag: input.tag,
      command:
        redacted.length > MAX_SHIELD_TAGGED_COMMAND_LENGTH
          ? `${redacted.slice(0, MAX_SHIELD_TAGGED_COMMAND_LENGTH - 1)}…`
          : redacted,
      recordedAt: this.#options.clock(),
    };
    return this.#append(
      SHIELD_TAGS_AGGREGATE,
      String(threadId),
      SHIELD_TAG_EVENT_NAMES.recorded,
      payload,
      this.#hostActor,
    )
      ? "recorded"
      : "unavailable";
  }

  /**
   * What a thread's agent reads about the registered servers, with each
   * runbook's notes framed as context that grants nothing. Read when a turn
   * starts, so an edited runbook reaches the next turn.
   */
  context(): string | undefined {
    const servers = this.servers();
    const runbooks = new Map<string, string>();
    for (const server of servers) {
      if (server.runbookPath === undefined) continue;
      const text = this.#options.readRunbook?.(
        server.runbookPath,
        MAX_SHIELD_RUNBOOK_CONTEXT_LENGTH + 1,
      );
      if (text !== undefined) runbooks.set(String(server.serverId), text);
    }
    return shieldServerContext(
      servers.map((server) => ({ ...server, serverId: String(server.serverId) })),
      runbooks,
    );
  }

  #set(server: ShieldServer): ShieldServersChange {
    const duplicate = [...this.#servers.values()].some(
      (other) =>
        String(other.serverId) !== String(server.serverId) &&
        other.alias.toLowerCase() === server.alias.toLowerCase(),
    );
    if (duplicate) return refused("duplicate-alias");
    if (server.runbookPath !== undefined && CREDENTIAL_FOLDER.test(server.runbookPath)) {
      return refused("invalid-runbook-path");
    }
    const deployCommands = server.deployCommands
      .map((command) => command.trim())
      .filter((command) => command.length > 0);
    if (deployCommands.some((command) => command.includes("\u0000") || /[\r\n]/.test(command))) {
      return refused("invalid-deploy-command");
    }
    const canonical: ShieldServer = { ...server, deployCommands };
    const payload = { server: canonical, principal: { kind: "local-window" as const } };
    if (!this.#appendRegistry(SHIELD_SERVERS_EVENT_NAMES.serverSet, payload)) {
      return refused("unavailable");
    }
    this.#apply(SHIELD_SERVERS_EVENT_NAMES.serverSet, payload);
    return { kind: "changed", server: canonical };
  }

  #apply(eventName: string, payload: unknown): void {
    if (eventName === SHIELD_SERVERS_EVENT_NAMES.serverSet) {
      const { server } = decodeShieldServerSetPayload(payload);
      this.#servers.set(String(server.serverId), server);
      return;
    }
    if (eventName === SHIELD_SERVERS_EVENT_NAMES.serverRemoved) {
      this.#servers.delete(String(decodeShieldServerRemovedPayload(payload).serverId));
    }
  }

  #appendRegistry(eventName: string, payload: unknown): boolean {
    return this.#append(
      SHIELD_SERVERS_AGGREGATE,
      SHIELD_SERVERS_AGGREGATE_ID,
      eventName,
      payload,
      this.#personActor,
    );
  }

  #append(
    aggregateType: string,
    aggregateId: string,
    eventName: string,
    payload: unknown,
    actor: EventActorValue,
  ): boolean {
    const key = `${aggregateType}/${aggregateId}`;
    const version = this.#versions.get(key) ?? 0;
    try {
      this.#options.journal.append({
        aggregate: { aggregateType, aggregateId: decodeAggregateId(aggregateId) },
        expectedVersion: decodeAggregateVersion(version),
        events: [
          {
            eventId: decodeEventId(this.#options.uuid()),
            eventName: decodeEventName(eventName),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#options.uuid()),
            actor,
            occurredAt: decodeTimestamp(this.#options.clock()),
            payload,
          },
        ],
      });
    } catch {
      return false;
    }
    this.#versions.set(key, version + 1);
    return true;
  }
}

function refused(reason: ShieldServersRefusalReason): ShieldServersChange {
  return { kind: "refused", reason };
}

/**
 * Reads the start of a runbook the person pointed to: a regular file, at most
 * `maxBytes`, as UTF-8. Anything else (a folder, a device, a missing file)
 * reads as nothing.
 */
export function readRunbookFile(path: string, maxBytes: number): string | undefined {
  let descriptor: number | undefined;
  try {
    // Non-blocking, so a named pipe at the path cannot stall a turn's start.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) return undefined;
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * The person's SSH agent socket, when the host process was given one and it
 * is a socket: what an SSH session signs in through. Read each time, so an
 * agent started after the host is picked up.
 */
export function personSshAgentSocket(
  value: string | undefined,
  isSocket: (path: string) => boolean = (path) => {
    try {
      return statSync(path).isSocket();
    } catch {
      return false;
    }
  },
): string | undefined {
  if (value === undefined || !isAbsolute(value) || value.includes("\0")) return undefined;
  return isSocket(value) ? value : undefined;
}
